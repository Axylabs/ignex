import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Bun.file stand-in for the node test environment (see http.test.ts).
beforeAll(() => {
  vi.stubGlobal("Bun", {
    file: (p: string) => new File([readFileSync(p)], basename(p)),
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

import {
  DEFAULT_UPLOAD_TYPES,
  sanitizeFileName,
  saveUpload,
  serveUpload,
} from "../src/http/uploads";

const dirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "uploads-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ctxWithFile = (file: File | string, field = "file"): { body: never } => {
  const form = new FormData();
  if (file instanceof File) form.set(field, file);
  return {
    body: {
      formData: async () => form,
    } as never,
  };
};

describe("saveUpload", () => {
  it("stores under an unguessable server-generated name and reports metadata", async () => {
    const dir = makeDir();
    const result = await saveUpload(
      ctxWithFile(new File(["hello"], "my photo.PNG", { type: "image/png" })),
      {
        dir,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.name).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(result.file.url).toBe(`/uploads/${result.file.name}`);
    expect(result.file.uploaded).toBe("my photo.PNG");
    const stored = readdirSync(dir);
    expect(stored).toEqual([result.file.name]);
    const storedName = stored[0] ?? "";
    expect(readFileSync(join(dir, storedName), "utf8")).toBe("hello");
  });

  it("rejects missing/empty/oversized files with the right statuses", async () => {
    const dir = makeDir();
    expect((await saveUpload(ctxWithFile("not-a-file"), { dir })).status).toBe(400);
    expect(
      (await saveUpload(ctxWithFile(new File([], "empty", { type: "image/png" })), { dir })).status,
    ).toBe(400);
    const big = new File([new Uint8Array(16)], "big", { type: "image/png" });
    expect((await saveUpload(ctxWithFile(big), { dir, maxBytes: 8 })).status).toBe(413);
  });

  it("rejects non-allowlisted content types (incl. SVG) with 415", async () => {
    const dir = makeDir();
    const svg = new File(["<svg/>"], "evil.svg", { type: "image/svg+xml" });
    expect((await saveUpload(ctxWithFile(svg), { dir })).status).toBe(415);
    expect(Object.keys(DEFAULT_UPLOAD_TYPES)).not.toContain("image/svg+xml");
  });
});

describe("serveUpload", () => {
  it("serves stored uploads with immutable caching and rejects traversal", async () => {
    const dir = makeDir();
    const saved = await saveUpload(
      ctxWithFile(new File(["pdf-bytes"], "doc.pdf", { type: "application/pdf" })),
      { dir },
    );
    if (!saved.ok) throw new Error("save failed");
    const res = await serveUpload(saved.file.name, { dir, req: new Request("https://x/y") });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pdf-bytes");
    expect(res.headers.get("cache-control")).toContain("31536000");

    for (const bad of ["../../etc/passwd", "not-a-uuid.png", `${saved.file.name}/extra`]) {
      await expect(serveUpload(bad, { dir })).rejects.toMatchObject({ status: 404 });
    }
  });
});

describe("sanitizeFileName", () => {
  it("strips separators/control chars and caps length", () => {
    expect(sanitizeFileName("a/b\\c:d*e?.txt")).toBe("a_b_c_d_e_.txt");
    expect(sanitizeFileName(`${"x".repeat(300)}.pdf`).length).toBeLessThanOrEqual(160);
    expect(sanitizeFileName("")).toBe("upload");
  });
});
