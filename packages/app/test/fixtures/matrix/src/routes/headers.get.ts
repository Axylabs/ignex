import { get } from "@flux/core/http";

/** Headers the fixture echoes back (names are case-insensitive on read). */
const ECHO = [
  "x-test",
  "x-multi",
  "if-none-match",
  "if-modified-since",
  "accept-language",
  "authorization",
  "content-type",
];

/** GET /headers — echoes selected request headers. */
export default get(async (ctx) => {
  const headers: Record<string, string> = {};

  for (const name of ECHO) {
    const value = ctx.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  return ctx.json({ headers });
});
