import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serveStaticApp } from "../src/http/static-app";

// The node test environment has no Bun global; provide a Bun.file stand-in
// so sendFile's Blob-based slicing is exercised end-to-end (same pattern as
// http.test.ts).
beforeAll(() => {
  vi.stubGlobal("Bun", {
    file: (p: string) => new File([readFileSync(p)], basename(p)),
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const dirs: string[] = [];
const makeDist = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "static-app-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ctxFor = (path?: string): { req: Request; params: Record<string, string> } => ({
  req: new Request(`https://app.test/${path ?? ""}`),
  params: path === undefined ? {} : { path },
});

describe("serveStaticApp", () => {
  it("serves index.html for the site root", async () => {
    const dir = makeDist({ "index.html": "<h1>home</h1>" });
    const res = await serveStaticApp(ctxFor(), { root: dir });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
    // Pages always revalidate — no immutable caching.
    expect(res.headers.get("cache-control")).not.toContain("31536000");
  });

  it("gives hashed assets a one-year immutable cache", async () => {
    const dir = makeDist({ "_astro/app.abc123.css": "body{}" });
    const res = await serveStaticApp(ctxFor("_astro/app.abc123.css"), { root: dir });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("31536000");
  });

  it("falls back to the SPA shell for unknown paths", async () => {
    const dir = makeDist({ "index.html": "home", "404.html": "shell" });
    const res = await serveStaticApp(ctxFor("orders/abc"), { root: dir });
    expect(await res.text()).toBe("shell");
  });

  it("resolves directories to their index.html", async () => {
    const dir = makeDist({ "browse/index.html": "listing" });
    const res = await serveStaticApp(ctxFor("browse"), { root: dir });
    expect(await res.text()).toBe("listing");
  });

  it("emits Cache-Tag via tagsFor and 404s when nothing is built", async () => {
    const dir = makeDist({
      "index.html": "x",
      "gigs/507f1f77bcf86cd799439011/index.html": "detail",
    });
    const tagged = await serveStaticApp(ctxFor("gigs/507f1f77bcf86cd799439011"), {
      root: dir,
      tagsFor: (rel) => /^(gigs|jobs)\/([0-9a-f]{24})/.exec(rel)?.[0] ?? null,
    });
    expect(tagged.headers.get("Cache-Tag")).toBe("gigs/507f1f77bcf86cd799439011");

    const empty = makeDist({});
    const missing = await serveStaticApp(ctxFor("anything"), { root: empty });
    expect(missing.status).toBe(404);
  });
});
