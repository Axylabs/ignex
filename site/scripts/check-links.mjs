#!/usr/bin/env bun
/**
 * Post-build link validator for the docs site.
 *
 * VitePress's dead-link check only covers markdown links to source pages —
 * it does not validate raw-HTML anchors, base-path correctness, in-page
 * anchors, or external URLs. This script walks the BUILT output:
 *
 *   1. internal hrefs   — must resolve to a built file (base-aware) and,
 *                         when they carry a #fragment, the target page must
 *                         contain that anchor id
 *   2. src assets       — must exist in the built output
 *   3. external http(s) — must respond (HEAD, GET fallback) with < 400
 *
 * Usage: bun scripts/check-links.mjs [--skip-external]
 * Exit non-zero on any internal/anchor failure or unreachable external.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const DIST = new URL("../.vitepress/dist", import.meta.url).pathname;
const BASE = "/ignex/"; // keep in sync with .vitepress/config.mts
const SKIP_EXTERNAL = process.argv.includes("--skip-external");
const TIMEOUT_MS = 12_000;

const stripTags = (html) => html.replace(/<!--[\s\S]*?-->/g, " ");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// /ignex/guide/routing.html#x -> dist-relative path + fragment
function resolveInternal(rawHref, fromFile) {
  // Decide ABSOLUTE vs RELATIVE on the raw href — after base-stripping an
  // absolute link no longer starts with "/" and would look relative.
  if (rawHref.startsWith("/")) {
    if (!rawHref.startsWith(BASE)) return { invalidBase: rawHref, path: null, hash: "" };
    const [pure, hash = ""] = rawHref.slice(BASE.length).split("#");
    return { invalidBase: null, path: pure, hash };
  }
  // Relative hrefs resolve against the page's own directory.
  const [pure, hash = ""] = rawHref.split("#");
  return { invalidBase: null, path: relative(DIST, resolve(dirname(fromFile), pure)), hash };
}

function findBuiltFile(path) {
  const clean = decodeURIComponent(path).replace(/\/+$/, "");
  if (!clean) return join(DIST, "index.html");
  const candidates = [
    join(DIST, clean),
    clean.endsWith(".html") ? null : join(DIST, `${clean}.html`),
    clean.endsWith(".html") ? null : join(DIST, clean, "index.html"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function hasAnchor(html, id) {
  return new RegExp(`(?:id|name)=["']${id.replace(/"/g, '\\"')}["']`).test(stripTags(html));
}

async function checkExternal(url) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status < 400) return { ok: true };
      if (method === "GET") return { ok: false, detail: `HTTP ${res.status}` };
    } catch (e) {
      if (method === "GET") return { ok: false, detail: String(e).slice(0, 80) };
    }
  }
  return { ok: false, detail: "unreachable" };
}

const files = [...walk(DIST)].filter((f) => f.endsWith(".html"));
const pages = new Map(files.map((f) => [f, stripTags(readFileSync(f, "utf8"))]));

const seen = new Set();
const internalFailures = [];
const external = new Set();
let checked = 0;

const HREF = /(?:href|src)="([^"]+)"/g;
for (const file of files) {
  const html = pages.get(file);
  for (const match of html.matchAll(HREF)) {
    const href = match[1];
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("javascript:") ||
      href.startsWith("data:")
    ) {
      continue;
    }
    checked++;
    if (/^https?:\/\//.test(href)) {
      external.add(href);
      continue;
    }
    const key = `${file} -> ${href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { invalidBase, path, hash } = resolveInternal(href, file);
    if (invalidBase) {
      internalFailures.push(
        `${relative(DIST, file)}: "${href}" is missing the ${BASE} base prefix`,
      );
      continue;
    }
    const target = findBuiltFile(path);
    if (!target) {
      internalFailures.push(`${relative(DIST, file)}: "${href}" -> no built file`);
      continue;
    }
    if (hash && target.endsWith(".html")) {
      const targetHtml = pages.get(target) ?? stripTags(readFileSync(target, "utf8"));
      if (!hasAnchor(targetHtml, hash)) {
        internalFailures.push(
          `${relative(DIST, file)}: "${href}" -> anchor #${hash} not found in target`,
        );
      }
    }
  }
}

const externalFailures = [];
if (!SKIP_EXTERNAL) {
  console.log(`checking ${external.size} external URLs…`);
  const uniq = [...external];
  const batch = 8;
  for (let i = 0; i < uniq.length; i += batch) {
    await Promise.all(
      uniq.slice(i, i + batch).map(async (url) => {
        const res = await checkExternal(url);
        if (!res.ok) externalFailures.push(`${url} — ${res.detail}`);
      }),
    );
  }
}

console.log(`\nchecked ${checked} href/src refs across ${files.length} pages`);
console.log(`  internal: ${internalFailures.length} broken`);
console.log(
  `  external: ${externalFailures.length} unreachable (${SKIP_EXTERNAL ? "skipped" : `${external.size} unique`})`,
);

if (internalFailures.length) {
  console.log("\nBROKEN INTERNAL LINKS:");
  for (const f of internalFailures) console.log(`  ✖ ${f}`);
}
if (externalFailures.length) {
  console.log("\nUNREACHABLE EXTERNAL LINKS:");
  for (const f of externalFailures) console.log(`  ✖ ${f}`);
}

const failed = internalFailures.length + externalFailures.length > 0;
console.log(failed ? "\n✖ links: FAIL" : "\n✔ links: OK");
process.exit(failed ? 1 : 0);
