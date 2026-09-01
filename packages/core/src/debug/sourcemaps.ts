/**
 * @fileoverview Source-map frame remapper for the debug surfaces.
 *
 * The AOT compiler bundles (and can minify) the server into
 * `.ignex/server.js` / `dist/__server.js`. Bun does NOT remap `Error().stack`
 * from the emitted `//# sourceMappingURL` at runtime (verified on
 * 1.4.1-canary) — every stack frame the tracer captures (`Trace.errorStack`,
 * span `origin`) points at bundle coordinates like `__server.js:1:48213`,
 * which are useless when debugging.
 *
 * This module closes the gap: for a stack frame it looks for a source map
 * next to the referenced file (the compiler emits `<out>.js.map` whenever
 * `sourceMap` is enabled), decodes the v3 VLQ mappings, and rewrites the
 * frame back to the ORIGINAL TypeScript position. Frames whose file has no
 * adjacent `.map` pass through untouched (negative-cached, so the common
 * un-bundled case costs one existence check per unique file).
 *
 * Functional surface only: factories + pure helpers, no classes.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** One decoded mapping segment: generated position → original position. */
export interface MappingSegment {
  /** Generated column (0-based). */
  readonly genCol: number;
  /** Original source AS WRITTEN in the map (resolve against the map dir). */
  readonly source: string;
  /** Original line (0-based). */
  readonly srcLine: number;
  /** Original column (0-based). */
  readonly srcCol: number;
}

/** Decoded mappings: generated line (0-based) → segments sorted by genCol. */
export type DecodedMappings = Map<number, readonly MappingSegment[]>;

/** Minimal v3 source-map document shape this module consumes. */
export interface RawSourceMap {
  version?: number;
  sources?: unknown;
  mappings?: unknown;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map<string, number>();
for (let i = 0; i < B64.length; i++) B64_INDEX.set(B64[i] as string, i);

/** Decode one base-64 VLQ field (a run of digits ending at a clear cont-bit). */
export const decodeVlq = (field: string): number => {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < field.length; i++) {
    const digit = B64_INDEX.get(field[i] as string);
    if (digit === undefined) throw new Error(`invalid VLQ char "${field[i]}"`);
    result += (digit & 31) << shift;
    if ((digit & 32) === 0) {
      // Sign is encoded as the LSB of the accumulated value.
      const negative = (result & 1) === 1;
      result >>= 1;
      return negative ? -result : result;
    }
    shift += 5;
  }
  throw new Error("truncated VLQ");
};

/** Split one mapping segment into its VLQ fields (delimiter = clear cont-bit). */
const splitVlqFields = (segment: string): string[] => {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < segment.length; i++) {
    const digit = B64_INDEX.get(segment[i] as string);
    if (digit === undefined) throw new Error(`invalid VLQ char "${segment[i]}"`);
    if ((digit & 32) === 0) {
      fields.push(segment.slice(start, i + 1));
      start = i + 1;
    }
  }
  return fields;
};

/** Running decode state shared across mapping lines (src fields persist). */
interface DecodeState {
  genLine: number;
  srcIdx: number;
  srcLine: number;
  srcCol: number;
}

/** Apply one segment's deltas; append it when it maps to a known source. */
const applySegment = (
  fields: number[],
  genCol: number,
  state: DecodeState,
  sources: readonly string[],
  byLine: Map<number, MappingSegment[]>,
): void => {
  if (fields.length < 4) return;
  state.srcIdx += fields[1] as number;
  state.srcLine += fields[2] as number;
  state.srcCol += fields[3] as number;
  const source = sources[state.srcIdx];
  if (source === undefined) return;
  const segment: MappingSegment = {
    genCol,
    source,
    srcLine: state.srcLine,
    srcCol: state.srcCol,
  };
  const line = byLine.get(state.genLine);
  if (line) line.push(segment);
  else byLine.set(state.genLine, [segment]);
};

/**
 * Decode the `mappings` field of a v3 source map into per-line segments.
 * Relative fields (genCol resets per line; srcIdx/srcLine/srcCol persist)
 * are resolved here so lookups stay O(log n).
 */
export const buildDecodedMappings = (
  mappings: string,
  sources: readonly string[],
): DecodedMappings => {
  const byLine = new Map<number, MappingSegment[]>();
  const state: DecodeState = { genLine: 0, srcIdx: 0, srcLine: 0, srcCol: 0 };
  for (const lineStr of mappings.split(";")) {
    let genCol = 0; // resets every generated line
    if (lineStr.length > 0) {
      for (const segStr of lineStr.split(",")) {
        if (segStr.length === 0) continue;
        const fields = splitVlqFields(segStr).map(decodeVlq);
        genCol += fields[0] ?? 0;
        applySegment(fields, genCol, state, sources, byLine);
      }
    }
    state.genLine += 1;
  }
  for (const line of byLine.values()) line.sort((a, b) => a.genCol - b.genCol);
  return byLine;
};

/** Find the mapping for a generated position (segment with genCol ≤ target). */
export const lookupMapping = (
  mappings: DecodedMappings,
  line: number,
  column: number,
): MappingSegment | null => {
  const segments = mappings.get(line);
  if (!segments || segments.length === 0) return null;
  let lo = 0;
  let hi = segments.length - 1;
  let best: MappingSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid] as MappingSegment;
    if (seg.genCol <= column) {
      best = seg;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
};

/** A stack-frame location parsed out of a frame line. */
export interface FrameLocation {
  readonly text: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Extracts the `path:line:col` tail of V8/Bun frames: `"    at fn (/abs/f.js:1:2)"`,
 * `"    at f.js:1:2"`, and bare `"f.js:1:2"` lines (Bun crash output). The
 * prefix is matched lazily so named/async frames parse; the path charset
 * excludes whitespace, parens and colons (POSIX paths — Windows drive
 * letters are out of scope for this runtime).
 */
const FRAME_RE = /^(?<prefix>.*?)(?<loc>[^\s():]+):(?<line>\d+):(?<col>\d+)\)?\s*$/;

/**
 * Parse one stack-frame line into its location parts.
 *
 * @param frame - A raw stack line (V8/Bun format).
 * @returns The normalized text plus `path:line:column`, or null for
 * non-location lines and remote (http/https) frames.
 */
export const parseFrameLocation = (frame: string): FrameLocation | null => {
  // Normalize file:// URLs up front so path/text stay consistent (the frame
  // is rewritten against this normalized copy).
  const text = frame.replace(/file:\/\//g, "");
  const m = FRAME_RE.exec(text);
  if (!m?.groups?.loc || !m.groups.line || !m.groups.col) return null;
  const path = m.groups.loc;
  // Remote frames have no local `.map`. The location charset cannot carry
  // ":", so an "https://host/x.js" frame extracts as "//host/x.js" — reject
  // protocol-relative remnants too.
  if (path.startsWith("//") || path.startsWith("http://") || path.startsWith("https://")) {
    return null;
  }
  const line = Number(m.groups.line);
  const column = Number(m.groups.col);
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
  return { text, path, line, column };
};

/** Loader seam (tests inject fixtures); default reads `<path>` from disk. */
export type MapLoader = (mapPath: string) => RawSourceMap | null | undefined;

/** Options for {@link createSourceFrameResolver}. */
export interface SourceFrameResolverOptions {
  /**
   * Directories tried in order for frame paths that are RELATIVE. Absolute
   * paths use their own directory. Defaults to `[process.cwd()]`.
   */
  readonly roots?: readonly string[];
  /** Injectable map loader (tests). Default: JSON.parse(readFileSync). */
  readonly loadMap?: MapLoader;
}

/** A resolver instance produced by {@link createSourceFrameResolver}. */
export interface SourceFrameResolver {
  /**
   * Rewrite one stack-frame line to its original source position when a map
   * is available; any other input returns verbatim.
   */
  remapFrame(frame: string): string;
}

/** Create a resolver (factory — state stays inside the closure). */
export const createSourceFrameResolver = (
  options: SourceFrameResolverOptions = {},
): SourceFrameResolver => {
  const roots = options.roots ?? [process.cwd()];
  // A custom loader (tests / alternate stores) also disables the filesystem
  // existence probe — the loader itself decides what exists.
  const customLoader = options.loadMap !== undefined;
  const loadMap = options.loadMap ?? defaultLoadMap;
  /** Decoded maps per .map path; entries set once (null = missing/invalid). */
  const cache = new Map<string, DecodedMappings | null>();
  /** Frame bundle path → `.map` path (null = no adjacent map). */
  const resolveCache = new Map<string, string | null>();

  const decodedFor = (mapPath: string): DecodedMappings | null => {
    const hit = cache.get(mapPath);
    if (hit !== undefined) return hit;
    let decoded: DecodedMappings | null = null;
    try {
      const raw = loadMap(mapPath);
      if (
        typeof raw === "object" &&
        raw !== null &&
        Array.isArray(raw.sources) &&
        typeof raw.mappings === "string"
      ) {
        decoded = buildDecodedMappings(
          raw.mappings,
          (raw.sources as unknown[]).map((s) => String(s)),
        );
      }
    } catch {
      decoded = null; // corrupt map — degrade to passthrough
    }
    cache.set(mapPath, decoded);
    return decoded;
  };

  /** Locate `<bundle>.map` for a frame path, or null (cached either way). */
  const findMapPath = (framePath: string): string | null => {
    const hit = resolveCache.get(framePath);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    const candidates = isAbsolute(framePath)
      ? [framePath]
      : roots.map((root) => join(root, framePath));
    for (const candidate of candidates) {
      if (customLoader || existsSync(`${candidate}.map`)) {
        found = `${candidate}.map`;
        break;
      }
    }
    resolveCache.set(framePath, found);
    return found;
  };

  return {
    remapFrame(frame: string): string {
      const loc = parseFrameLocation(frame);
      if (!loc || loc.line < 1 || loc.column < 1) return frame;
      const mapPath = findMapPath(loc.path);
      if (!mapPath) return frame;
      const decoded = decodedFor(mapPath);
      if (!decoded) return frame;
      const seg = lookupMapping(decoded, loc.line - 1, loc.column - 1);
      if (!seg) return frame;
      const source =
        /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(seg.source) || seg.source.startsWith("/")
          ? seg.source
          : resolve(dirname(mapPath), seg.source);
      const rebuilt = `${source}:${seg.srcLine + 1}:${seg.srcCol + 1}`;
      // Replace ONLY the location tail; preserve the "    at fn (" prefix.
      const needle = `${loc.path}:${loc.line}:${loc.column}`;
      const idx = loc.text.lastIndexOf(needle);
      if (idx === -1) return frame;
      return loc.text.slice(0, idx) + rebuilt + loc.text.slice(idx + needle.length);
    },
  };
};

/** Default loader: read + parse the `.map` document. */
const defaultLoadMap: MapLoader = (mapPath) => {
  if (!existsSync(mapPath)) return null;
  try {
    return JSON.parse(readFileSync(mapPath, "utf8")) as RawSourceMap;
  } catch {
    return null;
  }
};

/* ── process-wide shared resolver (used by the tracer) ─────────────────── */

let shared: SourceFrameResolver | null = null;

/** The process-wide resolver (created lazily; roots default to cwd). */
export const sharedSourceFrames = (): SourceFrameResolver => {
  if (!shared) shared = createSourceFrameResolver();
  return shared;
};

/** Swap/reset the process-wide resolver (tests). Null resets to lazy default. */
export const setSharedSourceFrames = (resolver: SourceFrameResolver | null): void => {
  shared = resolver;
};
