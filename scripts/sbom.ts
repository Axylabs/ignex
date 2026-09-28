/**
 * @fileoverview SBOM generator — a standards-compliant SPDX 2.3 JSON document
 * describing every dependency in `bun.lock`.
 *
 * Software-bill-of-materials output is an enterprise/OSS-consumer expectation
 * (procurement, vulnerability response, license audits); this produces it from
 * the lockfile the build already trusts, with no extra dependency and no
 * network call. The document is **deterministic** for a given lockfile — same
 * input, byte-identical output (bar the `created` timestamp) — so it can be
 * diffed and committed as a CI artifact.
 *
 * Usage:
 *   bun scripts/sbom.ts                      # write the SPDX document to stdout
 *   bun scripts/sbom.ts --out sbom.spdx.json # write it to a file
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** One entry of `bun.lock`'s `packages` map. */
type LockEntry = [spec: string, registry: string, meta: unknown, integrity?: string];

/** The next non-whitespace character at or after `from` (empty at EOF). */
const nextNonSpace = (text: string, from: number): string => {
  let j = from;
  while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
  return text[j] ?? "";
};

/**
 * Parse JSONC (the lockfile allows trailing commas) without a dependency.
 * Commas inside string literals are left untouched.
 */
const parseJsonc = (text: string): unknown => {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    // Drop a trailing comma when the next non-whitespace character closes a block.
    if (ch === "," && ["}", "]"].includes(nextNonSpace(text, i + 1))) continue;
    out += ch;
  }
  return JSON.parse(out);
};

/** `@babel/core@8.0.1` → `{ name: "@babel/core", version: "8.0.1" }`. */
const splitSpec = (spec: string): { name: string; version: string } => {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "0.0.0" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
};

/** Scoped npm names are `%40`-encoded in a purl, per the purl spec. */
const purlName = (name: string): string => (name.startsWith("@") ? `%40${name.slice(1)}` : name);

/** `SPDXRef-Package-@babel/core@8.0.1` → an SPDX-ID-safe identifier. */
const spdxId = (name: string, version: string): string =>
  `SPDXRef-Package-${`${name}-${version}`.replace(/[^A-Za-z0-9.-]/g, "-")}`;

/** `sha512-<base64>` → SPDX `SHA512` hex checksum. */
const checksumOf = (
  integrity: string | undefined,
): Array<{ algorithm: string; checksumValue: string }> => {
  if (!integrity?.startsWith("sha512-")) return [];
  const base64 = integrity.slice("sha512-".length);
  return [{ algorithm: "SHA512", checksumValue: Buffer.from(base64, "base64").toString("hex") }];
};

const main = (): void => {
  const lock = parseJsonc(readFileSync(join(ROOT, "bun.lock"), "utf8")) as {
    packages?: Record<string, LockEntry>;
  };
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };

  const entries = Object.values(lock.packages ?? {})
    .map((entry) => ({ ...splitSpec(entry[0]), integrity: entry[3] }))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

  const packages = entries.map((entry) => ({
    SPDXID: spdxId(entry.name, entry.version),
    name: entry.name,
    versionInfo: entry.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    checksums: checksumOf(entry.integrity),
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:npm/${purlName(entry.name)}@${entry.version}`,
      },
    ],
  }));

  // A deterministic namespace: same lockfile → same URI (SPDX only asks that
  // it be unique per document, and it embeds the workspace name + version).
  const digest = createHash("sha256")
    .update(packages.map((p) => `${p.name}@${p.versionInfo}`).join("\n"))
    .digest("hex")
    .slice(0, 12);

  const document = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${root.name}-${root.version}`,
    documentNamespace: `https://ignex.dev/spdx/${root.name}-${root.version}-${digest}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: ignex-sbom"],
    },
    packages,
    relationships: packages.map((pkg) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relatedSpdxElement: pkg.SPDXID,
      relationshipType: "DESCRIBES",
    })),
  };

  const json = `${JSON.stringify(document, null, 2)}\n`;
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (out) {
    writeFileSync(out, json);
    console.error(`\u2714 SBOM: ${packages.length} packages → ${out}`);
  } else {
    process.stdout.write(json);
  }
};

main();
