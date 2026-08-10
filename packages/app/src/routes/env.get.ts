import { defineConfig, env, loadEnv } from "@flux/core";
import { get } from "@flux/core/http";

loadEnv();

const config = defineConfig({
  PORT: { type: "number", default: 3000, env: "PORT" },
  NODE_ENV: { type: "string", default: "development", env: "NODE_ENV" },
  FEATURES: { type: "json", default: [] as string[], env: "FEATURES" },
  DEBUG: { type: "boolean", default: false, env: "DEBUG" },
});

/** GET /env — typed config + typed env accessors. */
export default get((ctx) => {
  return ctx.json({
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    features: config.FEATURES,
    debug: config.DEBUG,
    direct: env("SOME_DIRECT_VAR", "fallback"),
    requestId: ctx.requestId,
  });
});
