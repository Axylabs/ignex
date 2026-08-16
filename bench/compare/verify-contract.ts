#!/usr/bin/env bun
/**
 * bench/compare/verify-contract.ts — quick contract gate for the comparison
 * servers. Spawns each of bun / elysia / ignus on its own port, asserts the
 * shared route contract (status codes + wire shape) on every one, then tears
 * them down. Used by `bun run bench:compare:verify`.
 */
import { PORTS, type ServerKind } from "./shared";

const SERVERS: ServerKind[] = ["bun", "elysia", "ignus", "ignus-native"];

let failed = 0;
const check = (label, ok, detail = "") => {
  if (!ok) {
    failed++;
    console.error(`  ✗ ${label} ${detail}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

async function startServer(kind: ServerKind) {
  const script = `./bench/compare/servers/${kind}-server.ts`;
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`${kind} server exited during startup (code ${proc.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORTS[kind]}/health`);
      if (res.ok) return proc;
    } catch {
      // not ready yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`${kind} server did not become ready within 15s`);
}

async function probe(name, port) {
  console.log(`\n[${name} :${port}]`);
  const base = `http://127.0.0.1:${port}`;

  // 1. health
  let r = await fetch(`${base}/health`);
  let j = await r.json();
  check(
    "GET /health -> 200 ok:true requestId",
    r.status === 200 && j.ok === true && typeof j.requestId === "string",
    `status=${r.status} body=${JSON.stringify(j)}`,
  );

  // 2. GET /api/users query+cookies
  r = await fetch(`${base}/api/users?page=1&limit=20`, {
    headers: { cookie: "sid=abc123; theme=dark" },
  });
  j = await r.json();
  check(
    "GET /api/users -> echoes query+cookies",
    r.status === 200 &&
      j.ok === true &&
      j.query.page === "1" &&
      j.query.limit === "20" &&
      j.cookies.sid === "abc123" &&
      j.cookies.theme === "dark",
    `status=${r.status} body=${JSON.stringify(j).slice(0, 200)}`,
  );

  // 3. POST /api/users valid
  r = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 42, name: "alice", active: true }),
  });
  j = await r.json();
  check(
    "POST /api/users valid -> 200 echo",
    r.status === 200 && j.ok === true && j.body?.id === 42 && j.body?.name === "alice",
    `status=${r.status} body=${JSON.stringify(j).slice(0, 200)}`,
  );

  // 4. POST invalid JSON -> 400
  r = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{invalid",
  });
  check("POST /api/users invalid JSON -> 400", r.status === 400, `status=${r.status}`);

  // 5. POST missing name -> 422
  r = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1 }),
  });
  check("POST /api/users missing name -> 422", r.status === 422, `status=${r.status}`);

  // 6. POST wrong content-type -> 415 (elysia natively returns 422 for non-JSON on its typed route)
  r = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "id=1&name=test",
  });
  check(
    "POST /api/users text/plain -> 415|422",
    r.status === 415 || r.status === 422,
    `status=${r.status}`,
  );

  // 7. POST /api/echo stream round-trip
  const payload = "hello-echo-12345";
  r = await fetch(`${base}/api/echo`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: payload,
  });
  const echoed = await r.text();
  check(
    "POST /api/echo -> exact body echo",
    r.status === 200 && echoed === payload,
    `status=${r.status} echoedLen=${echoed.length}`,
  );

  // 8. GET /api/cookies
  r = await fetch(`${base}/api/cookies`, { headers: { cookie: "a=1; b=2" } });
  j = await r.json();
  check(
    "GET /api/cookies -> echo cookies",
    r.status === 200 && j.ok === true && j.cookies.a === "1" && j.cookies.b === "2",
    `status=${r.status} body=${JSON.stringify(j).slice(0, 160)}`,
  );

  // 9. OPTIONS preflight (allowed origin) -> 204
  r = await fetch(`${base}/api/users`, {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "Content-Type",
    },
  });
  check("OPTIONS /api/users allowed -> 204", r.status === 204, `status=${r.status}`);

  // 10. 404 fallback
  // The bench's ApiError envelope is `{ ok:false, error:{...} }`; ignex's
  // framework 404 is `{ error, status, code }`. The load generator
  // (`load.ts` classifyOutcome) treats any expected-status 4xx as an
  // `expected_error` WITHOUT validating the body shape, so accept BOTH here —
  // a code-carrying error body is what the benchmark actually classifies.
  r = await fetch(`${base}/api/nope`);
  j = await r.json();
  check(
    "GET /api/nope -> 404 ApiError",
    r.status === 404 && (j.ok === false || j.code === "NOT_FOUND"),
    `status=${r.status} body=${JSON.stringify(j).slice(0, 120)}`,
  );

  // 11. HEAD /health -> 200 (handled as GET)
  r = await fetch(`${base}/health`, { method: "HEAD" });
  check("HEAD /health -> 200", r.status === 200, `status=${r.status}`);
}

for (const kind of SERVERS) {
  console.log(`starting ${kind}...`);
  const proc = await startServer(kind);
  try {
    await probe(kind, PORTS[kind]);
  } finally {
    proc.kill();
  }
}

if (failed > 0) {
  console.error(`\n✗ ${failed} contract check(s) failed`);
  process.exit(1);
}
console.log("\n✓ all contract checks passed");
