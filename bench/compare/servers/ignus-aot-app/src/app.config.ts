/**
 * bench/compare/servers/ignus-aot-app/src/app.config.ts
 *
 * AOT-compiled bench participant config. Mirrors the interpreted
 * `ignus-server.ts` plugin set (cors + security with the shared bench
 * constants) so both ignus participants apply byte-identical response
 * decoration — only the route reply path differs (`ctx.json` compiled reply
 * vs `new Response(JSON.stringify(...))` passthrough).
 */
import { cors, type IgnexPlugin, security } from "@ignex/core";
import { CORS_CONFIG, MAX_BODY_BYTES, SECURITY_HEADERS } from "../../../shared";

export const plugins: IgnexPlugin[] = [
  cors({
    origin: [...CORS_CONFIG.allowOrigin],
    methods: [...CORS_CONFIG.allowMethods],
    allowedHeaders: [...CORS_CONFIG.allowHeaders],
    exposedHeaders: [...CORS_CONFIG.exposeHeaders],
    credentials: CORS_CONFIG.allowCredentials,
    maxAge: CORS_CONFIG.maxAge,
  }),
  security({ contentSecurityPolicy: SECURITY_HEADERS["Content-Security-Policy"] }),
];

export const server = {
  port: 9123,
  idleTimeout: 30,
  maxRequestBodySize: MAX_BODY_BYTES + 1024,
};
