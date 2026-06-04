import { describe, expect, test } from "bun:test";

import { eventFromRequest } from "./request.ts";

describe("eventFromRequest", () => {
  test("captures the normalized Accept header", () => {
    const event = eventFromRequest(
      new Request("https://upstash.com/blog#section", {
        headers: {
          "user-agent": "ClaudeBot/1.0",
          accept: " Text/Markdown, text/html;q=0.8 ",
        },
      }),
    );

    expect(event).toEqual({
      provider: "claude",
      path: "https://upstash.com/blog",
      accept: "text/markdown, text/html;q=0.8",
    });
  });

  test("omits Accept when the header is missing", () => {
    const event = eventFromRequest(new Request("https://upstash.com/docs"));

    expect(event.accept).toBeUndefined();
  });
});
