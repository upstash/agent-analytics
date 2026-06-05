import type { Provider, TrackedEvent } from "./types.ts";

type RequestWithNextUrl = Request & {
  nextUrl?: { href: string };
};

/**
 * Extract the tracked dimensions from an incoming request. Only the pruned set
 * of {@link TrackedEvent} fields is produced — high-cardinality / PII fields
 * like raw IP and user-agent are deliberately not stored as dimensions.
 *
 * Returns `undefined` when the request can't be attributed to a known agent —
 * such requests are not recorded.
 */
export function eventFromRequest(req: Request): TrackedEvent | undefined {
  const request = req as RequestWithNextUrl;

  const provider = detectProvider(request);
  if (provider === undefined) return undefined;

  return {
    provider,
    path: normalizeUrl(request.nextUrl?.href ?? request.url),
  };
}

/** Drop the fragment so `/a#x` and `/a#y` aren't counted separately. */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Infer the AI agent from the user-agent and referrer headers. Returns
 * `undefined` when no known agent matches — the request is then not recorded.
 */
export function detectProvider(req: Request): Provider | undefined {
  const userAgent = req.headers.get("user-agent")?.toLowerCase() ?? "";
  const referer = (req.headers.get("referer") ?? req.headers.get("referrer") ?? "").toLowerCase();
  const source = `${userAgent} ${referer}`;

  if (source.includes("chatgpt") || source.includes("openai")) return "chatgpt";
  if (source.includes("claude") || source.includes("anthropic")) return "claude";
  if (source.includes("perplexity")) return "perplexity";
  if (source.includes("gemini") || source.includes("google-extended")) return "gemini";
  if (source.includes("copilot") || source.includes("bing")) return "copilot";

  return undefined;
}
