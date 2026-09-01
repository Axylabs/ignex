/**
 * @fileoverview Typo suggestions for unknown commands and flags.
 *
 * `suggest` ranks registry names/aliases against the unknown token using a
 * bounded Damerau-Levenshtein distance (typos) plus a prefix/substring pass
 * (partial typing), so `ignex rout` proposes `route` and `ignex routlist`
 * proposes `route:list`.
 */

/** Bounded optimal-string-alignment distance (insert/remove/substitute/swap). */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const lenA = a.length;
  const lenB = b.length;
  let prev2: number[] = [];
  let prev1: number[] = Array.from({ length: lenB + 1 }, (_, j) => j);
  let curr: number[] = Array.from({ length: lenB + 1 }, () => 0);

  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // `noUncheckedIndexedAccess` narrows rows to `number | undefined`; the
      // bands are fully initialized by construction (prev1/curr are seeded to
      // length lenB+1 before the loops, prev2 is a copy of a full row).
      let value = Math.min(
        (prev1[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev1[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (prev2[j - 2] as number) + 1);
      }
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    // Whole row already too far — no need to keep going.
    if (rowMin > max) return max + 1;
    prev2 = prev1;
    prev1 = curr;
    curr = prev2.slice();
    curr.fill(0);
  }
  return prev1[lenB] ?? max + 1;
}

/**
 * Rank candidates against an unknown token.
 *
 * @param token - The unknown input (e.g. `routlist`).
 * @param candidates - Known names (commands + aliases).
 * @param limit - Maximum suggestions returned.
 * @returns Up to `limit` candidates ordered best-first.
 */
export function suggest(token: string, candidates: readonly string[], limit = 3): string[] {
  const t = token.toLowerCase();
  if (!t || candidates.length === 0) return [];

  const scored = candidates
    .filter((c) => c.toLowerCase() !== t)
    .map((c) => {
      const lower = c.toLowerCase();
      let score: number;
      if (lower.startsWith(t)) score = 0;
      else if (lower.includes(t)) score = 1;
      else score = 2 + editDistance(t, lower, 3);
      return { candidate: c, score };
    })
    .filter((s) => s.score <= 3)
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const { candidate } of scored) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}
