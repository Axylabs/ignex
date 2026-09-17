/** Real Bun subprocess: Vitest workers do not expose bun:ffi. */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("shared castrum ingress binding", () => {
  it("contains shared writer exceptions and honors fail-closed policy", () => {
    const output = execFileSync(
      "bun",
      [
        "-e",
        `
      const { getFfiIngress } = await import('./packages/native/src/ffi.ts');
      const { createNativeIngress } = await import('./packages/native/src/ingress.ts');
      const binding = getFfiIngress();
      binding.ingressHandleComponents = () => { throw new Error('injected native fault'); };
      const open = createNativeIngress({}, { failClosed: false });
      const closed = createNativeIngress({}, { failClosed: true });
      const req = new Request('http://localhost/');
      const a = open.preprocess(req), b = closed.preprocess(req);
      console.log(JSON.stringify({ open: a.terminal, closed: b.response.status }));
    `,
      ],
      { encoding: "utf8", env: { ...process.env, IGNEX_NATIVE: "on" } },
    );
    expect(JSON.parse(output.trim())).toEqual({ open: false, closed: 503 });
  });
  it("uses castrum's actual writers without rebinding", () => {
    const output = execFileSync(
      "bun",
      [
        "-e",
        `
      const { getFfiIngress } = await import('./packages/native/src/ffi.ts');
      const { loadCastrumModule } = await import('./packages/native/src/loader.ts');
      const mod = await loadCastrumModule();
      const shared = mod.getIngressBinding();
      const actual = getFfiIngress();
      console.log(JSON.stringify({ available: !!actual,
        same: !!actual && actual.ingressHandleComponents === shared.ingressHandleComponents
          && actual.ingressHandlePacked === shared.ingressHandlePacked
          && actual.ingressLayout === shared.ingressLayout }));
    `,
      ],
      { encoding: "utf8", env: { ...process.env, IGNEX_NATIVE: "on" } },
    );
    expect(JSON.parse(output.trim())).toEqual({ available: true, same: true });
  });
});
