/**
 * Permanent change-stream error classification, shared by every `$changeStream`
 * watcher (service `CacheInvalidator` + hot-cache `WatchCoordinator`).
 *
 * These errors can NEVER be fixed by retrying — retrying only logs the same
 * warning every 1–5s forever and (with an un-unref'd timer) keeps the process
 * alive, which is wrong for a background watcher whose host server or build
 * should own the process lifetime. Watchers must classify them once, log once,
 * and stop (disable the watcher / fall back to the standalone ticker).
 *
 * Deliberately NARROW on purpose: replica errors that ARE transient — e.g.
 * "change stream history lost" (resume-token expiry, collection dropped),
 * network drops, failovers — must stay in the retry path, where
 * invalidate-on-reopen restores correctness. Broad patterns (like `not
 * supported` or `ChangeStream`) are rejected here because they can misfire on
 * those recoverable errors.
 */
export const isPermanentWatchError = (message: string): boolean =>
  // Standalone server: `$changeStream` is not supported at all.
  /only supported on replica sets/i.test(message) ||
  // Credentials/authorization problems: the user cannot run `aggregate` on
  // this collection/server. Wrong creds, missing roles, or a user created
  // without the `read`/`changeStream` privilege will never start working by
  // retrying — fail once and stop instead of retrying forever.
  /requires authentication|not authorized|unauthorized|authentication failed|Command .* requires authentication/i.test(
    message,
  );
