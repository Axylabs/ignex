import type { IgnexContext } from "@ignex/core";
import { rateLimit } from "@ignex/core";
import { get } from "@ignex/core/http";

/**
 * GET /ratelimit-strict — its own 3-requests/minute limiter.
 *
 * The limiter is ROUTE-LOCAL (wired through the route `before`/`after`
 * chains) rather than a second global plugin: every `rateLimit` plugin tracks
 * its state under the shared `__ratelimit` ctx key, so two instances fighting
 * over one request cross-contaminate each other's `X-RateLimit-*` headers.
 * Wrapping both halves here scopes the plugin to exactly this route, and the
 * after hook clears the shared key once the headers are written so the
 * GLOBAL limiter's onResponse (which runs later and skips this path) finds
 * no state and leaves the decorated response untouched.
 */
const strict = rateLimit({ maxRequests: 3, windowMs: 60_000 });

/** Run the plugin's onRequest half as a before hook (halt on the 429). */
const strictBefore = async (ctx: IgnexContext) => {
  const result = await strict.onRequest?.(ctx);
  if (result instanceof Response) return { ok: false as const, response: result };
  return { ok: true as const, ctx };
};

/** Decorate the response, then release the shared state key (see above). */
const strictAfter = (ctx: IgnexContext, response: Response) => {
  const decorated = strict.onResponse?.(ctx, response) ?? response;
  ctx.setState("__ratelimit", undefined);
  return decorated;
};

export default get(async (ctx) => ctx.json({ ok: true }), {
  before: [strictBefore],
  after: [strictAfter],
});
