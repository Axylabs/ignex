/**
 * @fileoverview Formatting + classification helpers shared by every view.
 *
 * Pure functions only: durations, counts, relative times, Tailwind class
 * picks and span-kind color tokens. Text always reaches the DOM via Solid's
 * text interpolation, so no HTML escaping is needed anywhere.
 */

/** Format milliseconds for table cells (`—` when absent). */
export const fmtMs = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? "—" : `${ms.toFixed(2)} ms`;

/** Format a count (`—` when absent). */
export const fmtNum = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : String(n);

/** Duration severity Tailwind class (<100 ok, <500 warn, else slow). */
export const durClass = (ms: number): string =>
  ms < 100 ? "text-ok" : ms < 500 ? "text-warn" : "text-err";

/** Compact relative time ("just now", "42s ago", "3m ago", "2h ago", date). */
export const timeAgo = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
};

/** Local HH:MM:SS. */
export const timeHM = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Lowercase method token used by the method pill's color class. */
export const methodCls = (method: string | null | undefined): string =>
  (method ?? "").toLowerCase();

/** Status family token: err ≥500, warn ≥400, info ≥300, else ok. */
export const statusCls = (status: number): string =>
  status >= 500 ? "err" : status >= 400 ? "warn" : status >= 300 ? "info" : "ok";

/** Span-kind → CSS custom property holding its palette color. */
export const kindColor = (kind: string): string =>
  ({
    request: "var(--k-request)",
    lifecycle: "var(--k-lifecycle)",
    db: "var(--k-db)",
    cache: "var(--k-cache)",
    http: "var(--k-http)",
    render: "var(--k-render)",
    auth: "var(--k-auth)",
    custom: "var(--k-custom)",
    error: "var(--k-error)",
  })[kind] ?? "var(--k-custom)";

/** SQL action → pill class family (select/insert/update/delete/other). */
export const sqlPillCls = (action: string | null | undefined): string => {
  const a = String(action ?? "SQL").toUpperCase();
  return a === "SELECT"
    ? "select"
    : a === "INSERT"
      ? "insert"
      : a === "UPDATE"
        ? "update"
        : a === "DELETE"
          ? "delete"
          : "other";
};

/** Human uptime ("3d 4h", "12m", "45s"). */
export const fmtUptime = (sec: number): string => {
  const total = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
};

/** Environment chip tone: prod=err, dev/local=ok, else warn. */
export const envTone = (value: string): string =>
  /prod/i.test(value) ? "err" : /dev|local/i.test(value) ? "ok" : "warn";

/** Pretty-print JSON-ish text; returns input untouched when not parseable. */
export const prettyJson = (text: string | null | undefined): string => {
  if (!text) return "(empty body)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** True when the text looks like a JSON object/array literal. */
export const looksLikeJson = (text: string | null | undefined): boolean => {
  if (!text) return false;
  const t = text.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
};

/** Case-insensitive header lookup in a plain header record. */
export const headerValue = (
  headers: Record<string, string> | null | undefined,
  name: string,
): string | null => {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] ?? null;
  }
  return null;
};
