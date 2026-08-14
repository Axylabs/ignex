import { get } from "@ignex/core/http";
import { errorEnvelope, okEnvelope, RATE_LIMIT_CONFIG, rateLimitCheck } from "../lib/bench";

/** GET /health — same per-request work as the interpreted server. */
export default get(async (ctx) => {
  // Inlined `ctx.set` writes force the full-context path (usage detection),
  // so requestId/ip/cookie/body/url are available on the compiled route.
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

  return ctx.json(okEnvelope(ctx, "/health", {}, {}));
});
