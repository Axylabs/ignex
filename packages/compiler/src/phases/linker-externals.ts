/**
 * @fileoverview Optional dependency externalization for the linker.
 */

const OPTIONAL_EXTERNALS: ReadonlySet<string> = new Set([
  "castrum",
  "ioredis",
  "nodemailer",
  "flatbuffers",
  "@ignex/nova",
]);

/** True only for documented optional integration packages. */
export const isOptionalExternal = (specifier: string): boolean =>
  OPTIONAL_EXTERNALS.has(specifier) ||
  specifier.startsWith("@opentelemetry/") ||
  specifier.startsWith("@ignex/nova/");

/** Extract unresolvable bare specifiers without hiding missing app dependencies. */
export const unresolvedSpecifiers = (logs: readonly { message?: string }[]): string[] => {
  const out = new Set<string>();
  for (const log of logs) {
    const match = /Could not resolve:\s+"([^"]+)"/.exec(log.message ?? "");
    if (match?.[1] && !match[1].startsWith(".") && !match[1].startsWith("/")) {
      out.add(match[1]);
    }
  }
  return [...out];
};
