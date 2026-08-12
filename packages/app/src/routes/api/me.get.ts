import { verifyCookie } from "@ignus/core";
import { get } from "@ignus/core/http";
import { BENCH_SECRET } from "../../bench-data";

/** GET /api/me — parse many cookies + verify the signed session cookie. */
export default get(async (ctx) => {
  let cookies = 0;
  let sid: string | null = null;

  for (const [name, cookie] of Object.entries(ctx.cookie)) {
    cookies += 1;
    if (name === "sid") {
      sid = verifyCookie(cookie.value ?? "", BENCH_SECRET);
    }
  }

  return ctx.json({ ok: true, cookies, sid });
});
