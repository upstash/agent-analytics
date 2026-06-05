import { Redis as UpstashRedis } from "@upstash/redis";

import { parseDuration } from "./duration.ts";
import { dataHash, dimensionPairs } from "./hash.ts";
import { eventFromRequest } from "./request.ts";
import { INGEST_SCRIPT } from "./script.ts";
import { dateToHourInt, hourIntToDate } from "./time.ts";
import type {
  AgentAnalyticsConfig,
  AggregateByOptions,
  Redis,
  TimeRange,
  TimeseriesBucket,
  TimeseriesOptions,
  TrackedEvent,
} from "./types.ts";

export const DEFAULT_PREFIX = "@upstash/agent-analytics";
export const DEFAULT_RETENTION = "28d";

/**
 * Thrown by {@link AgentAnalytics.query} reads when the search index has not
 * been created yet. Call `query.getIndex()` once before querying.
 */
export class IndexNotFoundError extends Error {
  public constructor(indexName: string) {
    super(
      `Search index "${indexName}" does not exist. ` +
        `Call query.getIndex() once (e.g. at setup) before aggregateBy()/timeseries().`,
    );
    this.name = "IndexNotFoundError";
  }
}

/**
 * Flat schema of an event hash. `count` and `hour` are numeric so we can
 * range-filter and group on them; the dimensions are keywords so we can group
 * by their exact values.
 */
const EVENT_SCHEMA = {
  count: { type: "U64" as const, fast: true as const },
  hour: { type: "U64" as const, fast: true as const },
  provider: { type: "KEYWORD" as const },
  path: { type: "KEYWORD" as const },
};

function resolveRange(range: TimeRange): { sinceHour: number; untilHour: number } {
  return {
    sinceHour: dateToHourInt(range.since),
    untilHour: dateToHourInt(range.until ?? new Date()),
  };
}

/**
 * The read side of agent analytics — everything powered by the Redis Search
 * index. Reached via {@link AgentAnalytics.query}.
 */
class AnalyticsQuery {
  public constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    private readonly indexName: string,
  ) {}

  /**
   * A local reference to the search index. This does **not** make a network
   * round-trip and does **not** create the index — it only builds the handle
   * used to issue queries. The index itself must already exist on the server
   * (see {@link getIndex}).
   */
  private index() {
    return this.redis.search.index<typeof EVENT_SCHEMA>({
      name: this.indexName,
      schema: EVENT_SCHEMA,
    });
  }

  /**
   * Run a query, translating the opaque failure you get from a non-existent
   * index into a clear {@link IndexNotFoundError}. The extra `describe()`
   * round-trip only happens on the error path, so the happy path stays a
   * single request.
   */
  private async run<T>(query: () => Promise<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      if ((await this.index().describe()) === null) {
        throw new IndexNotFoundError(this.indexName);
      }
      throw error;
    }
  }

  /**
   * Sum the counters in a time window, grouped by one dimension.
   *
   * The index must already exist — call {@link getIndex} once at setup.
   * Otherwise this throws {@link IndexNotFoundError}.
   *
   * @example
   * // Citations per provider over the last 24 hours
   * await analytics.query.aggregateBy({ field: "provider", since: new Date(Date.now() - 24 * 3600_000) });
   * // -> { chatgpt: 12, claude: 7, perplexity: 3 }
   */
  public async aggregateBy(options: AggregateByOptions): Promise<Record<string, number>> {
    const { field } = options;
    const { sinceHour, untilHour } = resolveRange(options);
    const result = await this.run(() =>
      this.index().aggregate({
        filter: { hour: { $gte: sinceHour, $lte: untilHour } },
        aggregations: {
          groups: {
            $terms: { field, size: 10_000 },
            $aggs: { total: { $sum: { field: "count" } } },
          },
        },
      }),
    );

    const counts: Record<string, number> = {};
    for (const bucket of result.groups.buckets) {
      counts[String(bucket.key)] = bucket.total.value;
    }
    return counts;
  }

  /**
   * Hourly time series of summed counters in a window, grouped by one
   * dimension (provider by default). Returns one bucket per hour in the range
   * (including empty hours), sorted ascending, so it is chart-ready.
   *
   * Like {@link aggregateBy}, this requires the index to already exist and
   * throws {@link IndexNotFoundError} if it was never created via
   * {@link getIndex}.
   *
   * @example
   * await analytics.query.timeseries({ since: new Date(Date.now() - 24 * 3600_000), groupBy: "provider" });
   * // -> [{ time: Date, values: { chatgpt: 2, claude: 0 } }, ...]
   */
  public async timeseries(options: TimeseriesOptions): Promise<TimeseriesBucket[]> {
    const groupBy = options.groupBy ?? "provider";
    const { sinceHour, untilHour } = resolveRange(options);
    const result = await this.run(() =>
      this.index().aggregate({
        filter: { hour: { $gte: sinceHour, $lte: untilHour } },
        aggregations: {
          byHour: {
            $histogram: { field: "hour", interval: 1 },
            $aggs: {
              byGroup: {
                $terms: { field: groupBy, size: 10_000 },
                $aggs: { total: { $sum: { field: "count" } } },
              },
            },
          },
        },
      }),
    );

    // Collect the populated hours and the full set of groups we saw, so every
    // bucket can carry the same keys (missing -> 0).
    const populated = new Map<number, Record<string, number>>();
    const seenGroups = new Set<string>();
    for (const hourBucket of result.byHour.buckets) {
      const values: Record<string, number> = {};
      for (const group of hourBucket.byGroup.buckets) {
        const key = String(group.key);
        values[key] = group.total.value;
        seenGroups.add(key);
      }
      populated.set(Number(hourBucket.key), values);
    }

    const series: TimeseriesBucket[] = [];
    for (let hour = sinceHour; hour <= untilHour; hour++) {
      const found = populated.get(hour) ?? {};
      const values: Record<string, number> = {};
      for (const group of seenGroups) {
        values[group] = found[group] ?? 0;
      }
      series.push({ time: hourIntToDate(hour), values });
    }
    return series;
  }

  /**
   * Create the search index (idempotent — uses `existsOk`) and return a
   * reference to it. This makes a network round-trip, so call it **once at
   * setup**, not on the read path: {@link aggregateBy} / {@link timeseries}
   * use a cheap local reference and assume the index already exists.
   *
   * `existsOk` makes creation a no-op when an index of this name already
   * exists — but it does **not** reconcile a differing schema (an older index
   * created with extra/renamed fields keeps its stale schema). So if an index
   * already exists with a schema that doesn't match {@link EVENT_SCHEMA}, we
   * drop it first and recreate it with the current schema.
   */
  public async getIndex() {
    const existing = await this.index().describe();
    if (existing !== null && !this.schemaMatches(existing.schema)) {
      await this.index().drop();
    }
    await this.redis.search.createIndex<typeof EVENT_SCHEMA>({
      name: this.indexName,
      prefix: this.keyPrefix,
      dataType: "hash",
      existsOk: true,
      schema: EVENT_SCHEMA,
    });
    return this.index();
  }

  /**
   * Whether an existing index's described schema matches {@link EVENT_SCHEMA}:
   * the same set of fields, each with the same type. Optional flags like `fast`
   * are ignored — the server may report them differently than we declared them.
   */
  private schemaMatches(actual: Record<string, { type: string }>): boolean {
    const expectedFields = Object.keys(EVENT_SCHEMA);
    const actualFields = Object.keys(actual);
    if (expectedFields.length !== actualFields.length) return false;
    return expectedFields.every(
      (field) => actual[field]?.type === EVENT_SCHEMA[field as keyof typeof EVENT_SCHEMA].type,
    );
  }

  /**
   * Block until the search index has caught up with the latest writes.
   *
   * Indexing is asynchronous, so {@link aggregateBy} and {@link timeseries}
   * read whatever has been indexed so far. Call this after recording events
   * when you need the queries to reflect them (e.g. in tests, or a
   * read-after-write dashboard refresh). Requires the index to exist.
   */
  public async waitIndexing(): Promise<void> {
    await this.index().waitIndexing();
  }

  /** Drop the search index. The underlying event hashes are left untouched. */
  public async dropIndex(): Promise<void> {
    await this.index().drop();
  }
}

/**
 * Stores and reads AI citation analytics on Upstash Redis.
 *
 * Each unique combination of {@link TrackedEvent} dimensions within an hour is
 * stored as a single hash at `<prefix>:event:<data-hash>:<hour>` whose `count`
 * field is the number of citations. A Redis Search index over those hashes
 * powers the aggregation queries, exposed under {@link query}.
 */
export class AgentAnalytics {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  /** Read/query side, all powered by the search index. */
  public readonly query: AnalyticsQuery;

  public constructor(config: AgentAnalyticsConfig) {
    this.redis = config.redis;
    this.prefix = config.prefix ?? DEFAULT_PREFIX;
    this.ttlSeconds = parseDuration(config.retention ?? DEFAULT_RETENTION);
    const indexName = config.indexName ?? `${this.prefix.replace(/[^a-zA-Z0-9_-]/g, "_")}-events`;
    this.query = new AnalyticsQuery(this.redis, this.keyPrefix, indexName);
  }

  public static fromEnv(config?: Omit<AgentAnalyticsConfig, "redis">): AgentAnalytics {
    return new AgentAnalytics({ redis: UpstashRedis.fromEnv(), ...config });
  }

  /** Prefix shared by every event hash key. Useful for `scan`. */
  protected get keyPrefix(): string {
    return `${this.prefix}:event:`;
  }

  /** Build the full Redis key for an event hash. */
  protected eventKey(hash: string, hour: number): string {
    return `${this.keyPrefix}${hash}:${hour}`;
  }

  /**
   * Track a citation, either from an incoming `Request` (dimensions are
   * inferred from it) or from an explicit {@link TrackedEvent}. `time` only
   * applies to the event form and defaults to now.
   *
   * Returns a promise resolving to the counter's new value. In a request
   * handler you usually don't want to block the response on it — schedule it
   * with Next.js `after()` instead (see the README proxy example).
   *
   * The request form resolves to `null` when the request can't be attributed
   * to a known agent — only known agents are recorded.
   *
   * Dimension order does not matter: `track({ provider, path })` and
   * `track({ path, provider })` increment the same counter.
   */
  public track(req: Request): Promise<number | null>;
  public track(event: TrackedEvent, time?: Date): Promise<number>;
  public async track(eventOrReq: TrackedEvent | Request, time?: Date): Promise<number | null> {
    const event = eventOrReq instanceof Request ? eventFromRequest(eventOrReq) : eventOrReq;
    if (event === undefined) return null;
    return this.ingest(event, time);
  }

  /** Increment the counter for one event occurrence; returns its new value. */
  private async ingest(event: TrackedEvent, time: Date = new Date()): Promise<number> {
    const pairs = dimensionPairs(event as Record<string, string | undefined>);
    const hour = dateToHourInt(time);
    const key = this.eventKey(dataHash(pairs), hour);

    const args: (string | number)[] = [this.ttlSeconds, hour];
    for (const [name, value] of pairs) {
      args.push(name, value);
    }

    const count = await this.redis.eval(INGEST_SCRIPT, [key], args);
    return count as number;
  }
}
