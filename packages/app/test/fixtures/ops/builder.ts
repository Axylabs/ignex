/**
 * AOT-compile the ops fixture — a production-shaped, NON-WebSocket app.
 *
 * The operational journeys need two things the request matrix cannot give:
 * a route slow enough to observe a drain, and no WS route (a WS app must
 * `stop(true)`, which force-closes in-flight requests by design). `production:
 * true` also makes this fixture a production build, so the journeys exercise
 * the hardened production artifact shape.
 */
import { join } from "node:path";
import { buildAsync } from "@ignex/compiler";

await buildAsync({
  routesDir: join(import.meta.dir, "src/routes"),
  outDir: join(import.meta.dir, "dist"),
  outFile: "__server.js",

  production: true,
  exposeErrorDetails: false,
  enableAccessLog: false,
});
