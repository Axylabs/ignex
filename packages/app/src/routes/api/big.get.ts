import { get } from "@ignus/core/http";
import { bigJson } from "../../bench-data";

const big = bigJson(256);

/** GET /api/big — ~256KB JSON response (compressed by the compression plugin). */
export default get(
  async () =>
    new Response(big, {
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
);
