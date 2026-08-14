import { post } from "@ignex/core/http";
import { errorEnvelope, RATE_LIMIT_CONFIG, rateLimitCheck } from "../../lib/bench";

/** POST /api/echo — stream the raw request body back verbatim. */
export default post(async (ctx) => {
  // Inlined `ctx.set` writes force the full-context path (usage detection).
  const now = Date.now();
  const rl = rateLimitCheck(ctx.ip, now);
  ctx.set.headers["X-Request-Id"] = ctx.requestId;
  ctx.set.headers["RateLimit-Limit"] = String(RATE_LIMIT_CONFIG.limit);
  ctx.set.headers["RateLimit-Remaining"] = String(rl.remaining);
  ctx.set.headers["RateLimit-Reset"] = String(Math.ceil(rl.resetMs / 1000));
  if (!rl.allowed) {
    ctx.set.headers["Retry-After"] = String(Math.ceil((rl.resetMs - now) / 1000));
    return ctx.json(
      errorEnvelope({
        code: "rate_limited",
        message: "Too Many Requests",
        retry_after_ms: rl.resetMs - now,
      }),
      { status: 429 },
    );
  }

  const requestedContentType = ctx.headers.get("content-type") ?? "application/octet-stream";
  // Raw `Response` is a passthrough in the compiled pipeline — the body
  // streams back with zero buffering (plugins still decorate it in onResponse).
  return new Response(ctx.req.body, {
    status: 200,
    headers: { "content-type": requestedContentType },
  });
});
