import type { Redis as UpstashRedis } from "@upstash/redis";
import type { Duration } from "./duration.ts";

export type { Duration } from "./duration.ts";

/**
 * The AI agent / crawler that produced the citation. Inferred from the
 * request's user-agent and referrer. Only known agents are recorded — a
 * request that matches none of these is dropped rather than bucketed.
 */
export type Provider = "chatgpt" | "claude" | "perplexity" | "gemini" | "copilot";

/**
 * The dimensions of a tracked citation. This is intentionally a small, pruned
 * set: every distinct combination of these values becomes its own counter
 * (one hash key per hour), so we only keep fields that are useful to group and
 * filter analytics by. Time is **not** a dimension — it lives in the hour
 * bucket of the key.
 */
export type TrackedEvent = {
  /** Which AI agent cited the page. */
  provider: Provider;
  /** The path on our site that was cited. */
  path: string;
};

/** The dimensions that can be grouped/filtered on. */
export type DimensionKey = keyof TrackedEvent;

/**
 * Minimal Redis surface this SDK needs. Accepts the full `@upstash/redis`
 * client (or anything structurally compatible).
 */
export type Redis = Pick<UpstashRedis, "eval" | "search" | "scan">;

export type AgentAnalyticsConfig = {
  redis: Redis;
  /**
   * All analytics keys in Redis are prefixed with this.
   *
   * @default "@upstash/agent-analytics"
   */
  prefix?: string;
  /**
   * How long an hour bucket is kept before it expires.
   *
   * @default "28d"
   */
  retention?: Duration;
  /**
   * Name of the search index used for aggregations. Defaults to a name
   * derived from {@link prefix}.
   */
  indexName?: string;
};

/**
 * A half-open time window, expressed in `Date`s. `until` defaults to "now".
 * Analytics are designed for windows from 24 hours up to 7 days.
 */
export type TimeRange = {
  since: Date;
  until?: Date;
};

/** Options for `query.aggregateBy` — a time window plus the dimension to group by. */
export type AggregateByOptions = TimeRange & {
  /** The dimension to group and sum by. */
  field: DimensionKey;
};

/** Options for `query.timeseries` — a time window plus an optional grouping. */
export type TimeseriesOptions = TimeRange & {
  /**
   * The dimension to break each hour down by.
   *
   * @default "provider"
   */
  groupBy?: DimensionKey;
};

/**
 * One hour bucket of a time series. `values` maps each group (e.g. provider)
 * to its summed counter for that hour.
 */
export type TimeseriesBucket = {
  /** Start of the hour bucket. */
  time: Date;
  values: Record<string, number>;
};
