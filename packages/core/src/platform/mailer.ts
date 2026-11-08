/**
 * @fileoverview `createMailer` — send transactional email through a standard
 * driver, wrapped in an ignex-shaped API.
 *
 * This is DX over the STANDARD approach, not a new SMTP stack: the `log`
 * driver is built-in (writes to console/pino — perfect for dev + tests), and
 * the `smtp` driver delegates to a pooled, reusable `nodemailer` transport.
 * Delivery failures reject so callers can report, retry, or queue them.
 *
 * ```ts
 * import { createMailer } from "@ignex/core";
 *
 * const mailer = createMailer({ driver: "log" });
 * await mailer.send({
 *   to: "user@example.com",
 *   subject: "Welcome!",
 *   text: "Thanks for signing up.",
 *   html: "<p>Thanks for signing up.</p>",
 * });
 * ```
 */

/** A single email message. */
export interface MailMessage {
  to: string | readonly string[];
  from?: string;
  subject: string;
  text?: string;
  html?: string;
  /** Optional metadata (ids, tags) surfaced by drivers/logging. */
  meta?: Record<string, unknown>;
}

/** Result of a send. */
export interface MailSendResult {
  accepted: readonly string[];
  rejected: readonly string[];
  /** Driver-provided id (SMTP message id, etc.). */
  messageId?: string;
}

/** Options for {@link createMailer}. */
export interface MailerOptions {
  /** Driver: "log" (default — writes to the sink) or "smtp" (nodemailer). */
  driver?: "log" | "smtp";
  /** Default from address (used when a message omits `from`). */
  from?: string;
  /** nodemailer transport options (SMTP driver only). */
  smtp?: {
    host: string;
    port: number;
    secure?: boolean;
    auth?: { user: string; pass: string };
  };
  /** Log sink (default `console`). */
  log?: Console;
  /** Reusable transport override for custom drivers and tests. */
  transport?: (smtp: NonNullable<MailerOptions["smtp"]>) => MailTransport | Promise<MailTransport>;
}

/** Minimal reusable transport contract used by SMTP and tests. */
export interface MailTransport {
  sendMail(message: Record<string, unknown>): Promise<{
    accepted?: unknown;
    rejected?: unknown;
    messageId?: string;
  }>;
  close?(): void | Promise<void>;
}

/** The mailer surface. Delivery failures reject so callers can retry or queue them. */
export interface Mailer {
  send(message: MailMessage): Promise<MailSendResult>;
  /** Close the reusable transport, if the driver owns one. */
  close(): Promise<void>;
}

/** Resolve the default `from` (option or process.env.MAIL_FROM). */
const resolveFrom = (options: MailerOptions): string | undefined =>
  options.from ?? process.env.MAIL_FROM;

/** Build a {@link MailSendResult} from a resolved recipient list. */
const resultFor = (message: MailMessage, messageId?: string): MailSendResult => {
  const to = Array.isArray(message.to) ? message.to : [message.to];
  return {
    accepted: to,
    rejected: [],
    ...(messageId !== undefined ? { messageId } : {}),
  };
};

/** The built-in "log" driver — writes the message to the sink. */
const createLogDriver = (options: MailerOptions, sink: Console) => {
  return async (message: MailMessage): Promise<MailSendResult> => {
    const to = Array.isArray(message.to) ? message.to : [message.to];
    const record: Record<string, unknown> = {
      to,
      from: message.from ?? resolveFrom(options),
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.meta ? { meta: message.meta } : {}),
    };
    sink.log(`[mailer] to=${to.join(",")} subject="${message.subject}"`, record);
    return resultFor(message, `log-${Date.now()}`);
  };
};

/**
 * Create a mailer. `driver: "log"` (default) writes to the sink — perfect for
 * dev, tests, and a no-op in preview environments; `driver: "smtp"` delegates
 * to nodemailer with the given transport options.
 */
export const createMailer = (options: MailerOptions = {}): Mailer => {
  const sink = options.log ?? console;
  const driver = options.driver ?? "log";

  if (driver === "smtp") {
    const smtpOptions = options.smtp;
    if (!smtpOptions) {
      throw new Error("createMailer({ driver: 'smtp' }) requires smtp options (host/port).");
    }
    let transportPromise: Promise<MailTransport> | null = null;
    let closed = false;
    const getTransport = (): Promise<MailTransport> => {
      transportPromise ??= (async () => {
        if (options.transport) return options.transport(smtpOptions);
        const nodemailerSpecifier = "nodemailer";
        const nodemailer = (await import(nodemailerSpecifier)) as {
          createTransport(config: unknown): MailTransport;
        };
        return nodemailer.createTransport({ ...smtpOptions, pool: true });
      })();
      return transportPromise;
    };

    return {
      async send(message): Promise<MailSendResult> {
        if (closed) throw new Error("mailer is closed");
        const transport = await getTransport();
        const info = await transport.sendMail({
          from: message.from ?? resolveFrom(options),
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        const accepted = Array.isArray(info.accepted)
          ? (info.accepted as string[])
          : Array.isArray(message.to)
            ? message.to
            : [message.to];
        return {
          accepted,
          rejected: (info.rejected as readonly string[] | undefined) ?? [],
          ...(info.messageId !== undefined ? { messageId: info.messageId } : {}),
        };
      },
      async close() {
        closed = true;
        const transport = await transportPromise;
        await transport?.close?.();
      },
    };
  }

  const logDriver = createLogDriver(options, sink);
  return { send: (message) => logDriver(message), close: async () => {} };
};
