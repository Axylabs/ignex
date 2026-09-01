/**
 * @fileoverview Reproducible `curl` command generation from a stored trace.
 *
 * The dashboard previously emitted a bare `curl -i -X GET '<url>'` — useless
 * for authenticated or POST requests. This builder renders the full command:
 * method, URL, captured (already-redacted) headers and body when present.
 */

import type { RequestTrace } from "./types";

/** True when the value is safe to inline in a single-quoted shell string. */
const needsQuoting = (value: string): boolean => /['\\\n]/.test(value);

/** POSIX-safe single-quoted shell word. */
const shellWord = (value: string): string =>
  needsQuoting(value) ? `'${value.replace(/'/g, `'\\''`)}'` : `'${value}'`;

/**
 * Build a copy-pasteable `curl` command reproducing a stored request.
 * Headers must already be redacted (`redactRequestTrace`) — this function
 * never un-redacts; whatever it receives goes into the command verbatim.
 */
export const buildCurl = (
  trace: Pick<RequestTrace, "method" | "request">,
  options: { includeHeaders?: boolean; includeBody?: boolean } = {},
): string => {
  const { method, request } = trace;
  const parts = ["curl", "-i", "-X", method, shellWord(request.url)];

  if (options.includeHeaders !== false && request.headers) {
    for (const [name, value] of Object.entries(request.headers)) {
      // Hop-by-hop + pseudo headers the replayer strips anyway.
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "content-length" || lower === "connection") continue;
      if (value === "") continue;
      parts.push("-H", shellWord(`${name}: ${value}`));
    }
  }

  if (options.includeBody !== false && request.body) {
    parts.push("--data-raw", shellWord(request.body));
  }

  return parts.join(" ");
};
