/**
 * @fileoverview Minimal 6-field (second-precision) cron next-match calculator.
 *
 * `Bun.cron` — the primary transport of {@link createScheduler} — only accepts
 * standard 5-field expressions (minute hour day month weekday; no seconds).
 * Legacy croner-style expressions such as `"*&#47;5 * * * * *"` (every 5 seconds)
 * keep working through this in-process matcher: a `setTimeout` chain armed at
 * the exact next matching second. It implements the POSIX day rule (when both
 * day-of-month and day-of-week are restricted, either may match) and the
 * common token syntax (`*`, `*&#47;step`, `value`, `a-b`, `a-b/step`, comma
 * lists). Unknown or out-of-range fields throw, mirroring `Bun.cron.parse`.
 *
 * Local time semantics match `Bun.cron` and croner (both evaluate in the
 * process's local timezone).
 */

/** Parse one cron field token into allowed values; `null` means `*` (all). */
export function parseCronField(field: string, min: number, max: number): Set<number> | null {
  let all = true;
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") throw new Error(`invalid cron field "${field}"`);
    if (part === "*") continue;
    const m = part.match(/^(?:(\d+)(?:-(\d+))?|\*)(?:\/(\d+))?$/);
    if (m === null) throw new Error(`invalid cron field "${part}"`);
    const from = m[1] === undefined ? min : Number(m[1]);
    const to = m[2] === undefined ? (m[1] === undefined ? max : from) : Number(m[2]);
    const step = m[3] === undefined ? 1 : Number(m[3]);
    if (from < min || to > max || from > to || step < 1) {
      throw new Error(`invalid cron field "${part}" (values must be within ${min}-${max})`);
    }
    all = false;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return all ? null : out;
}

/** Validate a full 6-field expression (`second minute hour day month weekday`). */
export function validateCron6(expression: string): void {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 6) {
    throw new Error(
      `expected 6 fields (second minute hour day month weekday), got ${parts.length}`,
    );
  }
  const [sec, min, hour, dom, mon, dow] = parts as [string, string, string, string, string, string];
  parseCronField(sec, 0, 59);
  parseCronField(min, 0, 59);
  parseCronField(hour, 0, 23);
  parseCronField(dom, 1, 31);
  parseCronField(mon, 1, 12);
  parseCronField(dow, 0, 7);
}

/**
 * Compute the next fire time (strictly after `from`, local time) for a
 * 6-field expression. Throws if the expression is invalid or no match exists
 * within 5 years (e.g. `"0 0 30 2 *"`).
 */
export function nextTick6(expression: string, from: Date = new Date()): Date {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 6) {
    throw new Error(
      `expected 6 fields (second minute hour day month weekday), got ${parts.length}`,
    );
  }
  const [secField, minField, hourField, domField, monField, dowField] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const secs = parseCronField(secField, 0, 59);
  const mins = parseCronField(minField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const doms = parseCronField(domField, 1, 31);
  const mons = parseCronField(monField, 1, 12);
  const dowsRaw = parseCronField(dowField, 0, 7);
  // Normalize Sunday-as-7 to Sunday-as-0 (both are valid cron spellings).
  const dows = dowsRaw === null ? null : new Set([...dowsRaw].map((d) => (d === 7 ? 0 : d)));

  /** POSIX day rule: restricted dom OR dow → either matching is enough. */
  const dayMatches = (d: Date): boolean => {
    const domOk = doms === null || doms.has(d.getDate());
    const dowOk = dows === null || dows.has(d.getDay());
    return doms !== null && dows !== null ? domOk || dowOk : domOk && dowOk;
  };

  const next = new Date(from.getTime());
  next.setMilliseconds(0);
  next.setSeconds(next.getSeconds() + 1); // strictly after `from`

  const limit = from.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  while (next.getTime() <= limit) {
    if (mons !== null && !mons.has(next.getMonth() + 1)) {
      next.setDate(1);
      next.setMonth(next.getMonth() + 1);
      next.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(next)) {
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      continue;
    }
    if (hours !== null && !hours.has(next.getHours())) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(0, 0, 0);
      continue;
    }
    if (mins !== null && !mins.has(next.getMinutes())) {
      next.setMinutes(next.getMinutes() + 1);
      next.setSeconds(0, 0);
      continue;
    }
    if (secs !== null && !secs.has(next.getSeconds())) {
      next.setSeconds(next.getSeconds() + 1);
      continue;
    }
    return next;
  }
  throw new Error(`no matching time for "${expression}" within 5 years`);
}
