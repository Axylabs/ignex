/**
 * Ambient type surface for the OPTIONAL `nodemailer` dependency used by
 * `createMailer`'s SMTP driver. Mapped through the root tsconfig `paths`, so
 * TypeScript resolves the module even when nodemailer isn't installed (the
 * log driver is the default; SMTP is opt-in). Mirrors the `castrum` vendor
 * pattern.
 */
declare module "nodemailer" {
  export interface TransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: { user: string; pass: string };
  }
  export interface SentMessageInfo {
    accepted?: unknown[];
    rejected?: unknown[];
    messageId?: string;
  }
  export function createTransport(options: TransportOptions): {
    sendMail(message: Record<string, unknown>): Promise<SentMessageInfo>;
  };
}
