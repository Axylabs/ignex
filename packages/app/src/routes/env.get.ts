import { get } from "@ignex/core/http";
import { env } from "../config/env.js";

/** GET /env — validated, typed environment (see src/config/env.ts). */
export default get((ctx) => {
  return ctx.json({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    features: env.FEATURES,
    debug: env.DEBUG,
    requestId: ctx.requestId,
  });
});
