import { get } from "@ignus/core/http";
import { bigJson } from "../../bench-data";

const big = bigJson(256);
const bigBytes = new TextEncoder().encode(big);
// Precompress once at module load (the payload is static) — the same approach
// the raw-Bun baseline uses. The compression plugin skips responses that
// already carry `content-encoding`.
const bigGzip = Bun.gzipSync(bigBytes);

/** GET /api/big — ~256KB JSON response, precompressed (gzip) like the baseline. */
export default get(
  async () =>
    new Response(bigGzip, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
      },
    }),
);
