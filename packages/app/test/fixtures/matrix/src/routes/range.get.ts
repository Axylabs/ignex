import { get } from "@ignex/core/http";

/** Path to the fixture sample asset, resolved relative to the generated server. */
const SAMPLE = new URL("../assets/sample.txt", import.meta.url).pathname;

/** GET /range — sendFile (etag / 304 / range 206 / 416). */
export default get(async (ctx) => ctx.sendFile(SAMPLE));
