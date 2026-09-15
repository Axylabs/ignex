import { get } from "@ignex/core/http";
import {
  cookiesRecord,
  errorEnvelope,
  okEnvelope,
  queryRecord,
  RATE_LIMIT_CONFIG,
  rateLimitCheck,
} from "../../lib/bench";

/** GET /api/users — parse query + cookies, echo back in ApiOk. */
export default get(async (ctx) => {
  // Measurement-only ablations (docs/aot-perf-plan.md §43): each isolates one
  // call's served cost so the framework's per-route overhead can be attributed
  // against the shared-helpers implementation in the `bun` participant.
  const ABL = process.env.ABL ?? "";
  // Inlined `ctx.set` writes no longer force the full-context path; §38 made
  // ctx escaping do that (these helpers are in another module).
  const now = Date.now();
  const rl = ABL === "noip" ? rateLimitCheck("127.0.0.1", now) : rateLimitCheck(ctx.ip, now);
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

  return ctx.json(
    okEnvelope(
      ctx,
      "/api/users",
      ABL === "noquery" ? {} : queryRecord(ctx),
      ABL === "nocookie" ? {} : cookiesRecord(ctx),
    ),
  );
});
