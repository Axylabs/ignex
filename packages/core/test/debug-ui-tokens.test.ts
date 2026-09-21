/**
 * @fileoverview Style-guide guard — asserts the token layer honours the
 * documented scale and contrast floor, so the design system cannot drift.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("../src/debug/ui/styles.css", import.meta.url)),
  "utf8",
);
const UI_DIR = fileURLToPath(new URL("../src/debug/ui", import.meta.url));
const RAMP = ["11px", "12px", "13px", "15px", "20px", "28px"];

/** Recursively collect `.ts`/`.tsx` sources under a directory. */
const listSources = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
};

/** Tokens deleted by Task 1; nothing in `ui/` may reference them again. */
const REMOVED_TOKENS = [
  "var(--k-",
  "var(--m-",
  "var(--accent2",
  "var(--accent-dim",
  "var(--panel",
  "var(--raised",
  "var(--panel2",
  "var(--faint)",
  "var(--muted)",
];

/** Extract the declarations of a selector block (first match). */
const block = (selector: string): string => {
  const i = CSS.indexOf(selector);
  if (i < 0) throw new Error(`selector not found: ${selector}`);
  return CSS.slice(i, CSS.indexOf("}", i));
};

/** Parse `--name: value` pairs from a block body. */
const vars = (body: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
};

/** WCAG relative luminance of a #rrggbb color. */
const lum = (hex: string): number => {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => {
    const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
};

/** WCAG contrast ratio between two #rrggbb colors. */
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("debugbar design tokens", () => {
  it("exposes exactly the documented 6-step type ramp", () => {
    const v = vars(block(":root"));
    expect(
      ["--fs-xs", "--fs-sm", "--fs-md", "--fs-lg", "--fs-xl", "--fs-2xl"].map((k) => v.get(k)),
    ).toEqual(RAMP);
  });

  it("meets 4.5:1 for all three text levels in both themes", () => {
    for (const sel of [":root", 'html[data-theme="light"]']) {
      const v = vars(block(sel));
      for (const [fg, bg] of [
        ["--text", "--surface-1"],
        ["--text-muted", "--surface-1"],
        ["--text-faint", "--surface-1"],
      ] as const) {
        const ratio = contrast(v.get(fg)!, v.get(bg)!);
        expect(ratio, `${sel} ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("every @theme color mapping points at a defined token", () => {
    const theme = block("@theme inline");
    const defs = new Set([
      ...vars(block(":root")).keys(),
      ...vars(block('html[data-theme="light"]')).keys(),
    ]);
    for (const m of theme.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g)) {
      expect(defs.has(m[1] as string), `undefined token ${m[1]}`).toBe(true);
    }
  });

  it("references no removed design token in ui/ sources", () => {
    const offenders: string[] = [];
    for (const file of listSources(UI_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const token of REMOVED_TOKENS) {
        if (src.includes(token)) offenders.push(`${file.slice(UI_DIR.length + 1)} → ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses no arbitrary typography or color values", () => {
    // The normative rule is "tokens for color; components for appearance".
    // Arbitrary *layout* dimensions (grid templates, max-widths, fixed chart
    // heights) are allowed; arbitrary font sizes and literal colors are not.
    const offenders: string[] = [];
    for (const file of listSources(UI_DIR)) {
      const src = readFileSync(file, "utf8");
      const rel = file.slice(UI_DIR.length + 1);
      if (/text-\[/.test(src)) offenders.push(`${rel} → arbitrary typography (text-[…])`);
      if (/\[#[0-9a-fA-F]{3,8}\]/.test(src)) offenders.push(`${rel} → arbitrary color ([#…])`);
    }
    expect(offenders).toEqual([]);
  });

  it("uses no raw palette colors for scrims in ui/ sources", () => {
    // `--overlay` is the one translucent surface for palette/dialog/drawer
    // scrims; raw Tailwind palette classes (`bg-black`, `bg-white`) and
    // arbitrary color literals would bypass it and drift from the token layer.
    const offenders: string[] = [];
    for (const file of listSources(UI_DIR)) {
      const src = readFileSync(file, "utf8");
      const rel = file.slice(UI_DIR.length + 1);
      for (const m of src.matchAll(/\b(?:bg-black|bg-white|bg-\[#|text-\[#)/g)) {
        offenders.push(`${rel} → ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never pairs text-accent with bg-accent-soft in one source", () => {
    // `--accent` on `--accent-soft` is ~3.9:1 in the light theme, below the
    // 4.5:1 text floor. Selected/active surfaces keep the `bg-accent-soft`
    // tint but must use `text-ink` (see `Button`'s pressed state). A
    // file-level pairing is the proxy here; `text-accent-fg` is excluded by
    // the negative lookahead, so only a bare `text-accent` trips it.
    const offenders: string[] = [];
    for (const file of listSources(UI_DIR)) {
      const src = readFileSync(file, "utf8");
      if (/bg-accent-soft/.test(src) && /\btext-accent(?!-)/.test(src)) {
        offenders.push(file.slice(UI_DIR.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
