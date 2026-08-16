/**
 * @fileoverview Core ↔ codegen helper parity.
 *
 * The interpreted pipeline (`core/src/http/finalize.ts`) and the AOT compiler
 * (`compiler/src/phases/codegen/helpers.ts`) each implement the same response
 * helpers (`withBody`/`jsonReply`/`textReply`/`htmlReply`/`finalizeResponse`
 * vs `__withBody`/`jsonReply`/`textReply`/`htmlReply`/`__finalize`) from
 * SEPARATE sources (the codegen side is emitted as a string template for
 * AOT — the documented "no shared source" tradeoff). This test pins the two
 * to identical observable behavior so the emitted templates cannot silently
 * drift from the runtime they claim to mirror.
 *
 * The codegen helpers are evaluated exactly as emitted (via `new Function`
 * with the same module prelude the compiler's emitted server uses), matching
 * the harness in `scripts/bench-hotpath.ts`.
 */

import { describe, expect, it } from "vitest";
import { HELPER_SOURCES } from "../../compiler/src/phases/codegen/helpers";
import { finalizeResponse, htmlReply, jsonReply, textReply, withBody } from "../src/http/finalize";

const __encoder = new TextEncoder();

const MODULE_PRELUDE = `
const __DEFAULT_HEADERS = null;
const __encoder = new TextEncoder();
`;

const PARITY_HELPERS = ["__withBody", "jsonReply", "textReply", "htmlReply", "__finalize"] as const;

interface EvaledHelpers {
  __withBody: (bytes: Uint8Array | null, type: string, init?: ResponseInit) => Response;
  jsonReply: (data: unknown, init?: ResponseInit) => Response;
  textReply: (data: unknown, init?: ResponseInit) => Response;
  htmlReply: (data: unknown, init?: ResponseInit) => Response;
  __finalize: (
    result: unknown,
    ctx: { set?: { status?: number } } | undefined,
    serializers?: Record<string, (value: unknown) => unknown>,
    reply?: (body: unknown, init?: ResponseInit) => Response,
  ) => Response;
}

/** Evaluate the codegen helper templates exactly as the emitted server does. */
const evaled = ((): EvaledHelpers => {
  const body = PARITY_HELPERS.map((h) => HELPER_SOURCES[h]).join("\n\n");
  const factory = new Function(
    `${MODULE_PRELUDE}\n${body}\nreturn { ${PARITY_HELPERS.join(", ")} };`,
  ) as () => EvaledHelpers;
  return factory();
})();

/** Snapshot the observable response surface for comparison. */
const snapshot = async (r: Response) => ({
  status: r.status,
  type: r.headers.get("content-type"),
  length: r.headers.get("content-length"),
  body: await r.text(),
});

const cases: Array<[string, Uint8Array | null, string, ResponseInit | undefined]> = [
  ["no init", __encoder.encode("hi"), "text/plain", undefined],
  ["status only", __encoder.encode("hi"), "text/plain", { status: 201 }],
  ["statusText", __encoder.encode("hi"), "text/plain", { status: 201, statusText: "Created" }],
  ["object headers", __encoder.encode("hi"), "text/plain", { headers: { "x-a": "1", "x-b": "2" } }],
  [
    "Headers instance",
    __encoder.encode("hi"),
    "text/plain",
    { headers: new Headers({ "x-a": "1" }) },
  ],
  [
    "array headers",
    __encoder.encode("hi"),
    "text/plain",
    {
      headers: [
        ["x-a", "1"],
        ["x-b", "2"],
      ],
    },
  ],
  [
    "headers + status",
    __encoder.encode("hi"),
    "text/plain",
    { status: 202, headers: { "x-a": "1" } },
  ],
  ["null body", null, "text/plain", undefined],
  ["null body + status", null, "text/plain", { status: 204 }],
];

describe("codegen helper parity: __withBody ↔ withBody", () => {
  it.each(cases)("%s", async (_name, bytes, type, init) => {
    const [core, compiled] = await Promise.all([
      snapshot(withBody(bytes, type, init)),
      snapshot(evaled.__withBody(bytes, type, init)),
    ]);
    expect(compiled).toEqual(core);
  });
});

describe("codegen helper parity: jsonReply/textReply/htmlReply", () => {
  const data: unknown[] = [
    { ok: true, n: 42 },
    "plain string",
    0,
    false,
    ["a", "b"],
    { status: 200, body: "not a status wrapper" },
  ];

  it.each(data)("jsonReply(%j)", async (value) => {
    const [core, compiled] = await Promise.all([
      snapshot(jsonReply(value)),
      snapshot(evaled.jsonReply(value)),
    ]);
    expect(compiled).toEqual(core);
  });

  it("jsonReply with init", async () => {
    const [core, compiled] = await Promise.all([
      snapshot(jsonReply({ a: 1 }, { status: 429, headers: { "x-rate": "1" } })),
      snapshot(evaled.jsonReply({ a: 1 }, { status: 429, headers: { "x-rate": "1" } })),
    ]);
    expect(compiled).toEqual(core);
  });

  it("textReply and htmlReply", async () => {
    const [ct, ctC] = await Promise.all([
      snapshot(textReply("<b>hi</b>")),
      snapshot(evaled.textReply("<b>hi</b>")),
    ]);
    expect(ctC).toEqual(ct);
    const [h, hC] = await Promise.all([
      snapshot(htmlReply("<b>hi</b>")),
      snapshot(evaled.htmlReply("<b>hi</b>")),
    ]);
    expect(hC).toEqual(h);
  });
});

describe("codegen helper parity: __finalize ↔ finalizeResponse", () => {
  const reply = (body: unknown, init?: ResponseInit): Response =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });

  const results: Array<[string, unknown, { set?: { status?: number } } | undefined]> = [
    ["undefined → 204", undefined, undefined],
    ["null → 204", null, undefined],
    ["null + set.status", null, { set: { status: 202 } }],
    ["plain object", { ok: true }, undefined],
    ["status+body", { status: 201, body: { a: 1 } }, undefined],
    ["status+body + set.status wins", { status: 201, body: { a: 1 } }, { set: { status: 202 } }],
  ];

  it("Response passthrough returns the same instance (no body copy)", () => {
    const core = new Response("raw", { status: 206 });
    const compiled = new Response("raw", { status: 206 });
    expect(finalizeResponse(core, undefined)).toBe(core);
    expect(evaled.__finalize(compiled, undefined)).toBe(compiled);
  });

  it.each(results)("%s", async (_name, result, ctx) => {
    const [core, compiled] = await Promise.all([
      snapshot(finalizeResponse(result, ctx, undefined, reply)),
      snapshot(evaled.__finalize(result, ctx, undefined, reply)),
    ]);
    expect(compiled).toEqual(core);
  });

  it("serializer path (per-status map)", async () => {
    const serializers = {
      "200": (v: unknown) => `serialized:${JSON.stringify(v)}`,
      "201": (v: unknown) => `created:${JSON.stringify(v)}`,
    };
    const [core, compiled] = await Promise.all([
      snapshot(finalizeResponse({ status: 201, body: { id: 1 } }, undefined, serializers, reply)),
      snapshot(evaled.__finalize({ status: 201, body: { id: 1 } }, undefined, serializers, reply)),
    ]);
    expect(compiled).toEqual(core);
  });
});
