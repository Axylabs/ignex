/**
 * Static-file hardening pins — Content-Disposition framing safety (RFC 6266
 * quoted-string) and streamed 206 range bodies (a suffix range must not
 * materialize the whole file in memory).
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sendFile, streamDownload } from "../src/http/files";

// The node test environment has no Bun global; provide a Bun.file stand-in
// (File-backed Blob supports .slice().stream() — same pattern as
// static-app.test.ts).
beforeAll(() => {
  vi.stubGlobal("Bun", {
    file: (p: string) => new File([readFileSync(p)], basename(p)),
  });
});

const dir = await mkdtemp(join(tmpdir(), "ignex-files-hardening-"));
const filePath = join(dir, "sample.txt");
await writeFile(filePath, "hello-world-bytes");

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("content-disposition sanitization", () => {
  it("strips CR/LF/backslash/quote from download filenames", async () => {
    const res = await sendFile(filePath, {
      download: 'evil\r\nx\r\n"injected"\\path.txt',
    });
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).not.toContain('"injected"');
    expect(disposition).not.toContain("\\path");
  });

  it("streamDownload sanitizes user-supplied names the same way", () => {
    const res = streamDownload(new ReadableStream(), {
      filename: 'a"b\r\nc\\d.txt',
      size: 0,
    });
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toBe('attachment; filename="abcd.txt"');
  });
});

describe("streamed range responses", () => {
  const req = (range: string) => new Request("http://localhost/f", { headers: { range } });

  it("prefix range streams the exact byte slice", async () => {
    const res = await sendFile(filePath, { req: req("bytes=0-4") });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/17");
    expect(await res.text()).toBe("hello");
  });

  it("suffix range (bytes=-N) streams only the tail, not the whole file", async () => {
    const res = await sendFile(filePath, { req: req("bytes=-5") });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 12-16/17");
    expect(await res.text()).toBe("bytes");
    // The body is a stream (not a pre-materialized ArrayBuffer).
    expect(res.body).not.toBeNull();
  });

  it("unsatisfiable ranges still 416 with the size envelope", async () => {
    const res = await sendFile(filePath, { req: req("bytes=999-") });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */17");
  });
});
