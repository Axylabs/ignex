/**
 * Fault taxonomy tests — the "which part broke down, and why" contract.
 *
 * Three layers are pinned here:
 *
 * 1. **Typed errors** (`DBError`, `ConfigError`, `UpstreamError`,
 *    `DependencyError`, `ApplicationError`, `RequestError`) declare their
 *    origin/kind/status once and every instance inherits it.
 * 2. **`toFault`** classifies an arbitrary throw from its `cause` chain, its
 *    driver codes and the service markers in its messages — and never throws,
 *    never mutates the throw, and never changes a plain throw's status.
 * 3. **`errorToResponse`** maps each fault to the right status/code/envelope and
 *    reports 5xx once (4xx stays quiet).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationError, isAppError, statusOf } from "../src/platform/app-error.js";
import {
  BadRequestError,
  ConfigError,
  ConflictError,
  DBError,
  DependencyError,
  errorToResponse,
  ForbiddenError,
  HTTPError,
  InternalError,
  isHttpError,
  MethodNotAllowedError,
  NotFoundError,
  RequestError,
  TooManyRequestsError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
} from "../src/platform/errors.js";
import { readMappedError, toFault } from "../src/platform/fault.js";
import {
  faultOf,
  faultRequestInfo,
  isFaultReported,
  reportFault,
  requestInYourCode,
  resetFaultDedupe,
  setRequestFrameResolver,
} from "../src/platform/fault-report.js";
import { redactLogText } from "../src/platform/redact.js";

// A failing assertion must never leave a console spy installed for the next
// test (a leaked spy made an unrelated test fail).
afterEach(() => {
  vi.restoreAllMocks();
});

describe("typed error taxonomy", () => {
  it("derives origin/kind/code from the class, not from the caller", () => {
    expect(new DBError("insert into gigs failed")).toMatchObject({
      origin: "db",
      kind: "unexpected",
      code: "IGN_DB_ERROR",
      status: 503,
      retryable: true,
      detail: "insert into gigs failed",
      // The client-visible message stays generic; the driver text is `detail`.
      message: "Database unavailable",
    });
    expect(new ConfigError()).toMatchObject({
      origin: "config",
      kind: "invalid",
      code: "IGN_CONFIG_ERROR",
      status: 500,
      retryable: false,
    });
    expect(new UpstreamError()).toMatchObject({
      origin: "network",
      kind: "unreachable",
      code: "IGN_UPSTREAM_ERROR",
      status: 502,
      retryable: true,
    });
    expect(new DependencyError("sharp is not installed")).toMatchObject({
      origin: "dependency",
      kind: "dependency",
      status: 500,
      retryable: false,
    });
    expect(new ApplicationError("order 42 has no items")).toMatchObject({
      origin: "app",
      kind: "unexpected",
      code: "IGN_APP_UNEXPECTED",
      message: "order 42 has no items",
    });
  });

  it("keeps the HTTP family's origins and statuses (auth, request, internal)", () => {
    expect(new UnauthorizedError()).toMatchObject({ origin: "auth", status: 401 });
    expect(new ForbiddenError()).toMatchObject({ origin: "auth", status: 403 });
    expect(new NotFoundError("user")).toMatchObject({
      origin: "request",
      kind: "missing",
      status: 404,
      code: "NOT_FOUND",
    });
    expect(new ValidationError("bad", { name: ["required"] })).toMatchObject({
      origin: "request",
      kind: "invalid",
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect(new TooManyRequestsError()).toMatchObject({
      origin: "request",
      kind: "limit",
      status: 429,
      retryable: true,
    });
    expect(new InternalError()).toMatchObject({
      origin: "internal",
      kind: "unexpected",
      status: 500,
      code: "INTERNAL_ERROR",
    });
    // The 4xx family is one class hierarchy: RequestError, still an HTTPError.
    for (const error of [
      new BadRequestError(),
      new NotFoundError(),
      new ConflictError(),
      new MethodNotAllowedError(),
    ]) {
      expect(error).toBeInstanceOf(RequestError);
      expect(error).toBeInstanceOf(HTTPError);
    }
  });

  it("takes a non-retryable kind over the class's retryable default", () => {
    const rejected = new DBError("auth rejected", { kind: "credentials", retryable: false });
    expect(rejected).toMatchObject({ origin: "db", kind: "credentials", retryable: false });
    expect(new DBError("unreachable", { kind: "unreachable" }).retryable).toBe(true);
  });

  it("isAppError / isHttpError separate the two families", () => {
    expect(isAppError(new DBError("x"))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isHttpError(new DBError("x"))).toBe(true);
    expect(isHttpError(new ApplicationError("x"))).toBe(false);
    expect(statusOf(new ApplicationError("x"))).toBe(500);
    expect(statusOf(new DBError("x"))).toBe(503);
  });
});

describe("toFault", () => {
  it("trusts a typed error's own taxonomy", () => {
    const fault = toFault(
      new DBError("credentials rejected", { kind: "credentials", cause: new Error("bad auth") }),
    );
    expect(fault).toMatchObject({
      origin: "db",
      kind: "credentials",
      code: "IGN_DB_ERROR",
      status: 503,
      retryable: false,
      detail: "credentials rejected",
    });
  });

  it("classifies a raw driver throw from its cause chain", () => {
    const driver = Object.assign(new Error("E11000 duplicate key error"), {
      name: "MongoServerError",
      code: 11000,
    });
    const fault = toFault(new Error("insert failed", { cause: driver }));

    expect(fault).toMatchObject({
      origin: "db",
      kind: "query",
      service: "MongoDB",
      status: 500, // a plain throw is never silently upgraded to a 503
      errorName: "Error",
      message: "E11000 duplicate key error",
    });
    expect(fault.code).toBe("IGN_DB_QUERY");
    expect(fault.causes).toEqual([
      { name: "MongoServerError", message: "E11000 duplicate key error", code: "11000" },
    ]);
  });

  it("classifies network, dependency, config, port and abort shapes", () => {
    expect(
      toFault(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
    ).toMatchObject({ origin: "network", kind: "unreachable", retryable: true });
    expect(toFault(new Error("Cannot find module 'sharp'"))).toMatchObject({
      origin: "dependency",
      kind: "dependency",
    });
    expect(
      toFault(new Error("listen EADDRINUSE: address already in use 0.0.0.0:8080")),
    ).toMatchObject({ origin: "internal", kind: "port" });
    expect(
      toFault(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
    ).toMatchObject({ origin: "request", kind: "aborted" });
    expect(toFault(new TypeError("x is not a function"))).toMatchObject({
      origin: "internal",
      kind: "unexpected",
      summary: "Unhandled TypeError",
    });
  });

  it("adopts the service a typed error declares", () => {
    const fault = toFault(new DBError("insert failed", { kind: "query", service: "MongoDB" }));
    expect(fault).toMatchObject({ origin: "db", kind: "query", service: "MongoDB" });
  });

  it("masks credentials in every quoted string", () => {
    const fault = toFault(
      new Error("connect failed for mongodb://root:s3cret@db:27017/app?password=s3cret"),
    );
    expect(fault.message).not.toContain("s3cret");
    expect(fault.message).toContain("root:***@");
    expect(fault.message).toContain("password=***");
  });

  it("never throws on exotic or cyclic input", () => {
    const cyclic: Record<string, unknown> = { message: "boom" };
    cyclic.cause = cyclic;
    expect(() => toFault(cyclic)).not.toThrow();
    expect(toFault(undefined)).toMatchObject({ origin: "internal", kind: "unexpected" });
    expect(toFault({})).toMatchObject({ origin: "internal", kind: "unexpected" });
    expect(toFault(42)).toMatchObject({ origin: "internal", kind: "unexpected" });
  });
});

describe("reportFault", () => {
  it("prints once per failure, marks it, and returns the fault", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new DBError("credentials rejected", { kind: "credentials" });

    const first = reportFault(thrown, { label: "[ignex] request failed" });
    const second = reportFault(thrown, { label: "[ignex] request failed" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.message).toBe("[ignex] request failed: Database unavailable");
    expect(faultOf(first)?.kind).toBe("credentials");
    expect(isFaultReported(thrown)).toBe(true);
    expect(faultOf(second)?.code).toBe("IGN_DB_ERROR");
    spy.mockRestore();
  });

  it("adds request facts when a context is supplied, and skips what it lacks", () => {
    const info = faultRequestInfo({
      requestId: "lazy-id",
      method: "POST",
      path: "/api/gigs",
      route: "/api/gigs",
      getState: (key: string) => (key === "requestId" ? "mw-id" : undefined),
    });
    expect(info).toEqual({
      requestId: "mw-id",
      method: "POST",
      path: "/api/gigs",
      route: "/api/gigs",
    });
    // A specialized AOT context may carry only some members.
    expect(faultRequestInfo({ method: "GET" })).toEqual({ method: "GET" });
    expect(faultRequestInfo(undefined)).toBeUndefined();
    expect(
      faultRequestInfo({
        getState: () => {
          throw new Error("nope");
        },
      }),
    ).toBeUndefined();
  });

  it("prints the business location above the frame that raised it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new DBError("aggregate rejected", { kind: "query", service: "MongoDB" });
    reportFault(thrown, {
      label: "[ignex] request failed",
      inYourCode: "/srv/app/src/routes/api/gigs/index.get.ts:7:27",
    });
    const block = String(spy.mock.calls[0]?.[0] ?? "");
    const inCode = block.indexOf("in code");
    // `padKey` pads the label to the report's 9-char value column.
    expect(block).toContain("in code  /srv/app/src/routes/api/gigs/index.get.ts:7:27");
    // The business line leads `where` (the frame that actually raised it).
    const where = block.indexOf("where");
    expect(inCode).toBeGreaterThan(block.indexOf("message"));
    expect(where === -1 || inCode < where).toBe(true);
    spy.mockRestore();
  });

  it("omits the business line when nothing can supply one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportFault(new DBError("boom"), { label: "[ignex] request failed" });
    expect(String(spy.mock.calls[0]?.[0] ?? "")).not.toContain("in code");
    spy.mockRestore();
  });
});

describe("requestInYourCode", () => {
  afterEach(() => {
    setRequestFrameResolver(null);
  });

  it("resolves through the installed hook", () => {
    setRequestFrameResolver(() => "/srv/app/src/routes/x.ts:1:2");
    expect(requestInYourCode({})).toBe("/srv/app/src/routes/x.ts:1:2");
  });

  it("degrades to undefined without a hook, a context, or a working resolver", () => {
    expect(requestInYourCode({})).toBeUndefined();
    setRequestFrameResolver(() => "/srv/app/src/x.ts:1:1");
    expect(requestInYourCode(undefined)).toBeUndefined();
    setRequestFrameResolver(() => {
      throw new Error("resolver exploded");
    });
    // A broken resolver must never break a report.
    expect(requestInYourCode({})).toBeUndefined();
  });
});

describe("errorToResponse taxonomy", () => {
  it("maps typed 5xx errors to their status and code", async () => {
    const cases: Array<[Error, number, string]> = [
      [new DBError("insert failed", { kind: "unreachable" }), 503, "IGN_DB_ERROR"],
      [new UpstreamError(), 502, "IGN_UPSTREAM_ERROR"],
      [new ConfigError(), 500, "IGN_CONFIG_ERROR"],
      [new InternalError(), 500, "INTERNAL_ERROR"],
    ];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const [error, status, code] of cases) {
      const res = errorToResponse(error);
      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toMatchObject({ status, code });
    }
    // Every 5xx is reported; nothing 4xx is.
    expect(spy.mock.calls.length).toBe(cases.length);
    spy.mockRestore();
  });

  it("answers a masked 500 for a plain throw but reports the classification", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorToResponse(new Error("secret db password"), false, {
      requestId: "abc-1",
      method: "GET",
      path: "/x",
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Internal Server Error",
      status: 500,
      code: "INTERNAL_ERROR",
    });
    const rendered = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(rendered).toContain("IGN_INTERNAL_UNEXPECTED");
    expect(rendered).toContain("abc-1 · GET /x");
    spy.mockRestore();
  });

  it("never reports a client error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorToResponse(new NotFoundError("user"));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "user not found", code: "NOT_FOUND" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("keeps a typed non-HTTP 5xx message operator-only, and reveals it in dev", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new ApplicationError("order 42 has no items");

    // Production posture: the client gets the generic phrase + the code.
    const res = errorToResponse(error);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Internal Server Error",
      status: 500,
      code: "IGN_APP_UNEXPECTED",
    });

    // `exposeErrors` (dev) reveals the authored message, redacted.
    const dev = errorToResponse(error, true);
    await expect(dev.json()).resolves.toEqual({
      error: "order 42 has no items",
      status: 500,
      code: "IGN_APP_UNEXPECTED",
    });
    spy.mockRestore();
  });

  it("never puts an operator message or driver text in a 5xx envelope", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const db = errorToResponse(
      new DBError("mongodb://root:s3cret@db:27017 refused the insert", { kind: "unreachable" }),
    );
    expect(db.status).toBe(503);
    await expect(db.json()).resolves.toEqual({
      error: "Service Unavailable",
      status: 503,
      code: "IGN_DB_ERROR",
    });

    // `details` are gated with the message, not leaked next to it.
    const configured = errorToResponse(
      new ConfigError("MONGO_URL is missing", { details: { env: "MONGO_URL" } }),
    );
    await expect(configured.json()).resolves.toEqual({
      error: "Internal Server Error",
      status: 500,
      code: "IGN_CONFIG_ERROR",
    });
    spy.mockRestore();
  });
});

describe("library-mapped errors (statusCode + code, no dependency)", () => {
  /** The shape an ORM (ninox) throws: `code` + `statusCode` + `message`. */
  const mapped = (code: string, message: string, statusCode: number): Error =>
    Object.assign(new Error(message), { code, statusCode });

  it("keeps a mapped 4xx status and its client-facing message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = errorToResponse(mapped("NOT_FOUND", "Gig not found", 404));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Gig not found",
      status: 404,
      code: "NOT_FOUND",
    });
    expect(spy).not.toHaveBeenCalled(); // a 4xx is not an incident
    spy.mockRestore();
  });

  it("classifies a mapped datastore error and keeps its 5xx message out of the envelope", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = mapped("MONGO_TIMEOUT", "operation exceeded 30s on gigs.insertOne", 504);

    expect(toFault(thrown)).toMatchObject({
      origin: "db",
      kind: "timeout",
      service: "MongoDB",
      code: "MONGO_TIMEOUT",
      status: 504,
      retryable: true,
    });

    const res = errorToResponse(thrown);
    expect(res.status).toBe(504);
    await expect(res.json()).resolves.toEqual({
      error: "Gateway Timeout",
      status: 504,
      code: "MONGO_TIMEOUT",
    });

    // The operator still sees the detail in the report.
    const rendered = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(rendered).toContain("operation exceeded 30s on gigs.insertOne");
    spy.mockRestore();
  });

  it("does not treat an unrelated `status` field as a typed error", () => {
    const fake = Object.assign(new Error("socket closed"), { status: 500 });
    expect(readMappedError(fake)).toBeUndefined();
    expect(toFault(fake)).toMatchObject({ origin: "internal", status: 500 });
  });

  it("honours an explicit expose flag on a mapped 5xx", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = Object.assign(new Error("queue is draining"), {
      code: "DRAINING",
      statusCode: 503,
      expose: true,
    });

    const res = errorToResponse(thrown);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "queue is draining" });
    spy.mockRestore();
  });
});

describe("identical-fault aggregation (production log protection)", () => {
  const boom = (): Error =>
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetFaultDedupe();
  });

  it("prints every failing request in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("IGNEX_ERROR_DEDUPE_MS", "");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reportFault(boom(), { label: "[ignex] request failed" });
    reportFault(boom(), { label: "[ignex] request failed" });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("suppresses repeats inside the window and reports the count", () => {
    vi.stubEnv("IGNEX_ERROR_DEDUPE_MS", "5000");
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reportFault(boom(), { label: "[ignex] request failed" });
    for (let i = 0; i < 3; i += 1) reportFault(boom(), { label: "[ignex] request failed" });
    expect(spy).toHaveBeenCalledTimes(1);

    // After the window, the next occurrence prints and names what was hidden.
    vi.advanceTimersByTime(5_001);
    reportFault(boom(), { label: "[ignex] request failed" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1]?.[0])).toContain("3 identical report(s) suppressed");

    // A DIFFERENT failure is never suppressed by another one's window.
    reportFault(Object.assign(new Error("disk full"), { code: "ENOSPC" }), {
      label: "[ignex] request failed",
    });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("is disabled with IGNEX_ERROR_DEDUPE_MS=0", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IGNEX_ERROR_DEDUPE_MS", "0");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    reportFault(boom(), { label: "[ignex] request failed" });
    reportFault(boom(), { label: "[ignex] request failed" });

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("redactLogText", () => {
  it("masks URL credentials and secret pairs, then collapses to one line", () => {
    expect(redactLogText("line one\npostgres://u:p@h/db?token=abc&x=1")).toBe("line one");
    expect(redactLogText("postgres://u:p@h/db")).toBe("postgres://u:***@h/db");
    expect(redactLogText("api_key=abc123&next=1")).toBe("api_key=***&next=1");
    expect(redactLogText("x".repeat(300)).length).toBe(240);
  });
});

/* ── `where` frame selection ────────────────────────────────────────────── */

describe("fault `where`", () => {
  /** A throw whose stack is exactly the frames given (no real throw site). */
  const withStack = (...frames: string[]): Error => {
    const err = new Error("boom");
    err.stack = ["Error: boom", ...frames].join("\n");
    return err;
  };

  it("reports the application frame", () => {
    const err = withStack(
      "    at handler (/app/src/routes/gigs.get.ts:42:11)",
      "    at run (native:7:39)",
    );
    expect(toFault(err).where).toBe("/app/src/routes/gigs.get.ts:42:11");
  });

  it("never reports a synthetic `native:`/`node:` frame", () => {
    // Reporting these produced useless `where native:7:39` lines: they name no
    // file, so the honest answer is "no location".
    const err = withStack(
      "    at processTicksAndRejections (native:7:39)",
      "    at node:internal/process/task_queues:95:5",
    );
    expect(toFault(err).where).toBeUndefined();
  });

  it("falls back to the dependency frame that raised the error", () => {
    // A driver error (ninox, a Mongo client) has no application frame in its
    // stack — the dependency's own file is the most useful location there is.
    const err = withStack(
      "    at mapMongoDriverError (/app/node_modules/@x/db/src/driver-map.ts:131:14)",
      "    at processTicksAndRejections (native:7:39)",
    );
    expect(toFault(err).where).toBe("/app/node_modules/@x/db/src/driver-map.ts:131:14");
  });

  it("prefers application code over framework code", () => {
    const err = withStack(
      "    at sendFile (/repo/packages/core/src/http/files.ts:88:9)",
      "    at route (/app/src/routes/files.get.ts:12:3)",
    );
    expect(toFault(err).where).toBe("/app/src/routes/files.get.ts:12:3");
  });

  it("prefers application code over an installed core copy too", () => {
    const err = withStack(
      "    at parse (/app/node_modules/@ignex/core/src/http/body.ts:61:5)",
      "    at route (/app/src/routes/upload.post.ts:19:7)",
    );
    expect(toFault(err).where).toBe("/app/src/routes/upload.post.ts:19:7");
  });

  it("prefers SOURCE over compiled, even when the source frame is a dependency's", () => {
    // The mixed case that matters: a map-less app bundle plus a dependency that
    // ships (or was mapped to) TypeScript. A bundle offset is not a location
    // anyone can act on, so the dependency's real line wins.
    const err = withStack(
      "    at get (/app/dist/__server.js:50743:1)",
      "    at mapDriverError (/app/node_modules/@x/db/src/driver-map.ts:131:14)",
    );
    expect(toFault(err).where).toBe("/app/node_modules/@x/db/src/driver-map.ts:131:14");
  });

  it("prefers application code when both frames are compiled", () => {
    const err = withStack(
      "    at call (/app/node_modules/@x/db/dist/index.js:88:2)",
      "    at get (/app/dist/__server.js:50743:1)",
    );
    expect(toFault(err).where).toBe("/app/dist/__server.js:50743:1");
  });

  it("keeps the first frame on a tie, and ignores the error system itself", () => {
    const err = withStack(
      "    at classify (/repo/packages/core/src/platform/fault.ts:200:3)",
      "    at first (/app/src/a.ts:1:1)",
      "    at second (/app/src/b.ts:2:2)",
    );
    expect(toFault(err).where).toBe("/app/src/a.ts:1:1");
  });
});
