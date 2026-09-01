/**
 * @fileoverview `createNotifier` — user notifications over the typed realtime
 * transport (@ignex/nova) with an optional email fallback.
 *
 * DX over the standard approach: notifications are just typed events pushed
 * to a user's sockets via `@ignex/nova/events` (`emitToUser`), with a mailer
 * fallback so a user who is offline still gets the message. The nova events
 * facade is imported lazily (it's an optional dependency); when absent, the
 * notifier degrades to email-only.
 *
 * ```ts
 * import { createNotifier, createMailer } from "@ignex/core";
 *
 * const notify = createNotifier({
 *   mailer: createMailer(),               // log driver in dev
 *   onUserEvent: { "order.update": "order.update" },
 * });
 *
 * await notify.user("u-42", "order.update", { orderId: "o-1" });
 * ```
 */
import type { Mailer, MailMessage } from "./mailer";

/** Options for {@link createNotifier}. */
export interface NotifierOptions {
  /** Mailer used as the offline/email fallback. Optional. */
  mailer?: Mailer;
  /**
   * Map a notification name → an email template subject. When set, a
   * notification named `name` also sends an email to the user (the address
   * must be derivable from `user`). Optional.
   */
  emailSubjects?: Record<string, string>;
  /** Default from address for fallback emails (default `process.env.MAIL_FROM`). */
  from?: string;
}

/** A user identity the notifier can reach. */
export interface NotifyUser {
  /** The user id (targets the user's sockets via nova). */
  id: string;
  /** Email address (used by the email fallback). */
  email?: string;
}

/** The notifier surface. */
export interface Notifier {
  /**
   * Push `payload` to the user's sockets as a typed nova event named `name`,
   * and (when an email subject is registered) send a fallback email.
   */
  user(user: NotifyUser, name: string, payload: unknown): Promise<void>;
}

/**
 * Create a notifier. Nova events are loaded lazily — the transport is an
 * optional peer; when it's absent or a user has no sockets, the email
 * fallback (if configured) still delivers.
 */
export const createNotifier = (options: NotifierOptions = {}): Notifier => {
  const emailSubjects = options.emailSubjects ?? {};

  return {
    async user(user, name, payload) {
      // 1. Realtime delivery via @ignex/nova (lazy, optional).
      let nova: Record<string, unknown> | undefined;
      try {
        const spec = "@ignex/nova/events";
        nova = (await import(spec)) as Record<string, unknown>;
      } catch {
        nova = undefined;
      }
      const emitToUser = nova?.emitToUser as
        | ((userId: string, eventName: string, data: unknown) => unknown)
        | undefined;
      if (emitToUser) {
        try {
          emitToUser(user.id, name, payload);
        } catch {
          // Realtime delivery is best-effort — fall through to email.
        }
      }

      // 2. Email fallback (only when a subject is registered for this name).
      const subject = emailSubjects[name];
      if (subject && options.mailer && user.email) {
        const message: MailMessage = {
          to: user.email,
          subject,
          text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
          meta: { notification: name },
        };
        // A silently swallowed send failure meant notifications vanished
        // without a trace — log it (the notification flow itself still
        // continues; email failure must not fail the request).
        await options.mailer.send(message).catch((err) => {
          console.error(
            `[ignex] notifier: mail delivery failed for "${name}" → ${user.email}:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    },
  };
};
