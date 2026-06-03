# @upstash/agent-analytics

AI citation analytics for Upstash Redis, built directly on the Redis
[Search](https://upstash.com/docs/redis/search) extension — no
`@upstash/core-analytics` dependency.

## Installation

```bash
npm install @upstash/agent-analytics @upstash/redis
```

`@upstash/redis` is a peer dependency — install it alongside the SDK. Then
create the analytics client:

```ts
import { AgentAnalytics } from "@upstash/agent-analytics";

// Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from the environment:
const analytics = AgentAnalytics.fromEnv();
```

Or pass your own `@upstash/redis` client — useful when you configure it
explicitly or reuse an existing instance:

```ts
import { AgentAnalytics } from "@upstash/agent-analytics";
import { Redis } from "@upstash/redis";

const analytics = new AgentAnalytics({
  redis: new Redis({ url: "...", token: "..." }),
});
```

## How it works

Every citation is bucketed by the hour and by its dimensions. A single Redis
hash holds the counter for one combination of dimensions in one hour:

```
key:   <prefix>:event:<data-hash>:<hour>
value: { count, hour, provider, path }
```

- **`data-hash`** is derived from the event's dimensions. It is
  order-independent: `track({ provider, path })` and
  `track({ path, provider })` map to the same key.
- **`hour`** is an integer hour bucket. It is never exposed in the public API —
  every method takes and returns `Date`.
- Ingestion runs a small Lua script: it `HINCRBY`s the `count` field, and only
  the first time the counter is created does it write the immutable metadata
  and set the expiry (28 days by default, configurable).
- A Redis Search index over these hashes (with `count` and `hour` as numeric
  fields) powers the aggregations.

## Tracking

`track` is overloaded — pass a `Request` (dimensions are inferred) or an
explicit event. It returns a promise resolving to the counter's new value.

```ts
import { AgentAnalytics } from "@upstash/agent-analytics";
import { redis } from "./redis";

const analytics = new AgentAnalytics({ redis });

// From a Fetch/NextRequest — provider and path are inferred:
await analytics.track(request);

// Or pass explicit dimensions (time defaults to now):
await analytics.track({ provider: "chatgpt", path: "/pricing" });
```

### Don't block the response — use `after`

In a request handler you rarely want to await the write. On Next.js, schedule it
with [`after`](https://nextjs.org/docs/app/api-reference/functions/after) so it
runs as a background side-effect once the response has been sent:

```ts
import { after } from "next/server";
import { AgentAnalytics } from "@upstash/agent-analytics";

const analytics = AgentAnalytics.fromEnv();

export async function GET(req: Request) {
  // Returns immediately; the write happens after the response is sent.
  after(() => analytics.track(req));
  return Response.json({ ok: true });
}
```

`after` works the same way in middleware, Route Handlers, and Server Actions —
the function stays alive for the background write without delaying the response.

> **Earlier Next.js versions:** if `after` isn't available, use `waitUntil`
> instead — `event.waitUntil(analytics.track(req))` in middleware (via
> `NextFetchEvent`), or `waitUntil` from `@vercel/functions` elsewhere. See
> [Using `after` in Next.js](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#using-after-in-nextjs).

## Analytics

The read side lives under `.query`. Both queries take a `{ since, until? }`
window of `Date`s (`until` defaults to now). They are designed for windows from
24 hours up to 7 days.

```ts
const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

// Sum of citations grouped by one dimension. The field is type-safe.
await analytics.query.aggregateBy({ field: "provider", since });
// -> { chatgpt: 12, claude: 7, perplexity: 3 }

await analytics.query.aggregateBy({ field: "path", since });
// -> { "/pricing": 9, "/blog": 13 }

// Hourly time series, grouped by provider (default). One gap-filled bucket per
// hour in the window, sorted ascending — ready to chart.
await analytics.query.timeseries({ since });
await analytics.query.timeseries({ since, groupBy: "path" });
// -> [{ time: Date, values: { chatgpt: 2, claude: 0 } }, ...]
```

### Setup & the search index

The queries above issue a single search request against a cheap local index
reference; they assume the index already exists and throw `IndexNotFoundError`
if it doesn't. Create it once, at setup (it's idempotent):

```ts
await analytics.query.getIndex(); // creates the search index if missing
```

Indexing is then asynchronous, and the queries read whatever has been indexed
so far — they do **not** wait. When you need a read to reflect events you just
recorded, call `analytics.query.waitIndexing()` first. `dropIndex()` removes the
index (the event hashes are left untouched).

## Configuration

```ts
new AgentAnalytics({
  redis,
  prefix: "@upstash/agent-analytics", // key namespace (default)
  retention: "28d",                   // hour-bucket TTL (default); also accepts seconds
  indexName: "...",                   // search index name (defaults to one derived from prefix)
});
```
