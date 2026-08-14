import { get } from "@ignex/core/http";
import {
  cookiesRecord,
  errorEnvelope,
  okEnvelope,
  RATE_LIMIT_CONFIG,
  rateLimitCheck,
} from "../../lib/bench";

/** GET /api/cookies — parse cookies, echo back in ApiOk. */
export default get(async (ctx) => {
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

  return ctx.json(okEnvelope(ctx, "/api/cookies", {}, cookiesRecord(ctx)));
});
