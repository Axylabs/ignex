/**
 * Verify the per-route native stack (`castrum_route_*` C-ABI surface)
 * end-to-end under plain Bun — where `bun:ffi` dlopen works (vitest workers
 * do not expose it, so the route parity tests in
 * `packages/native/test/route.test.ts` skip there).
 *
 * Usage:
 *   IGNEX_NATIVE_PATH=/path/to/castrum.linux-x64-gnu.node bun scripts/verify-native-route.ts
 *
 * Exits 0 when the route surface is unavailable (graceful null fallback is
 * the contract), or when it is available AND the native query/cookie parse is
 * byte-identical to the JS wrappers on the parity vectors (plain, `%20`,
 * malformed `%ZZ`, invalid-UTF-8 `%FF`, UTF-8 `%E2%9C%93`, `+`→space, `%2B`
 * literal `+`, empty values; quoted/trimmed cookies). Exits 1 on a parity
 * mismatch.
 */
import { cookiePairs, createNativeRoute, queryPairs } from "@ignex/native";

const plan = () => ({
  pipeline: ["parseQuery", "parseCookies"] as const,
  schemas: {},
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 8192,
  maxCookieBytes: 8192,
  maxPairs: 0,
});

const route = createNativeRoute(plan());
if (route === null) {
  console.log("route surface unavailable — graceful null fallback OK (no addon/route module).");
  process.exit(0);
}

const QUERY_CASES = [
  "a=1&b=hello%20world&c=2",
  "m=%ZZ&n=abc%", // malformed → lenient raw
  "u=%E2%9C%93", // UTF-8 ✓
  "p=a+b", // + → space
  "k=%2B", // %2B → literal +
  "k&k2=", // empty value
  "q=%FF", // invalid UTF-8 → raw
];
const COOKIE_CASES = ["sid=abc; theme=dark", 'a=1; "quoted"=val;  spaced = x ', "empty=; bare"];

let failures = 0;
const check = (label: string, cond: boolean): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
};

for (const qs of QUERY_CASES) {
  const r = route.run({ query: qs, cookie: "", body: null });
  check(
    `query ${JSON.stringify(qs)} === JS queryPairs`,
    JSON.stringify(r.query) === JSON.stringify(queryPairs(qs)),
  );
}
for (const cs of COOKIE_CASES) {
  const r = route.run({ query: "", cookie: cs, body: null });
  check(
    `cookie ${JSON.stringify(cs)} === JS cookiePairs`,
    JSON.stringify(r.cookie) === JSON.stringify(cookiePairs(cs)),
  );
}

// Mixed frame + absent-part behavior.
const mixed = route.run({ query: "a=1&b=2", cookie: "s=v", body: null });
check(
  "mixed frame flags/ok + both pair lists",
  mixed.ok &&
    mixed.queryValid &&
    mixed.cookieValid &&
    JSON.stringify(mixed.query) === JSON.stringify(queryPairs("a=1&b=2")) &&
    JSON.stringify(mixed.cookie) === JSON.stringify(cookiePairs("s=v")),
);

route.destroy();

// ── Phase 2: body validation (bytes-in / verdict-out) ─────────────
const BODY_SCHEMA = { type: "object", required: ["x"], properties: { x: { type: "number" } } };
const bodyRoute = createNativeRoute({
  pipeline: ["requireJsonBody", "validateBody"] as const,
  schemas: { body: new TextEncoder().encode(JSON.stringify(BODY_SCHEMA)) },
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 8192,
  maxCookieBytes: 8192,
  maxPairs: 0,
});
if (bodyRoute !== null) {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  const okBody = bodyRoute.run({ query: "", cookie: "", body: enc('{"x":1}') });
  check(
    "valid JSON body passes requireJsonBody + validateBody (ok, both flags)",
    okBody.ok && okBody.bodyValidJson && okBody.bodyValid && okBody.errorCode === 0,
  );

  const badJson = bodyRoute.run({ query: "", cookie: "", body: enc("not json") });
  check(
    "non-JSON body → errorCode 400, ok cleared, no valid flags",
    !badJson.ok && badJson.errorCode === 400 && !badJson.bodyValidJson && !badJson.bodyValid,
  );

  const schemaFail = bodyRoute.run({ query: "", cookie: "", body: enc('{"x":"str"}') });
  check(
    "JSON-but-schema-invalid body → errorCode 422 (json valid, schema not)",
    !schemaFail.ok &&
      schemaFail.errorCode === 422 &&
      schemaFail.bodyValidJson &&
      !schemaFail.bodyValid,
  );

  // No body (hasBody=0) with an empty-`{}`-equivalent pipeline → ok.
  const noBody = bodyRoute.run({ query: "", cookie: "", body: null });
  check(
    "absent body on requireJsonBody route → errorCode 400 (empty is not JSON)",
    !noBody.ok && noBody.errorCode === 400,
  );

  bodyRoute.destroy();
} else {
  console.log("body route surface unavailable — skipped body vectors.");
}

if (failures > 0) {
  console.error(`\n${failures} parity failure(s).`);
  process.exit(1);
}
console.log("\nAll per-route native stack parity checks passed.");
