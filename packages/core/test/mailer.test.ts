/**
 * `createMailer` — transactional email with a built-in log driver.
 *
 * The log driver is the default (writes to the sink — perfect for dev/tests)
 * and is fully covered here. The SMTP driver delegates to nodemailer (an
 * optional dependency) and is exercised only when nodemailer is installed.
 */

import { createMailer } from "@ignex/core";
import { describe, expect, it, vi } from "vitest";

describe("createMailer (log driver)", () => {
  it("sends via the log sink and returns an accepted result", async () => {
    const log = vi.fn();
    const mailer = createMailer({
      driver: "log",
      log: { log } as unknown as Console,
    });
    const result = await mailer.send({
      to: "user@example.com",
      subject: "Welcome",
      text: "hi",
    });

    expect(result.accepted).toEqual(["user@example.com"]);
    expect(result.rejected).toEqual([]);
    expect(log).toHaveBeenCalled();
    const args = log.mock.calls[0] as unknown[];
    expect(JSON.stringify(args)).toContain("Welcome");
  });

  it("supports multiple recipients + html + meta", async () => {
    const mailer = createMailer({ driver: "log" });
    const result = await mailer.send({
      to: ["a@x.com", "b@x.com"],
      subject: "Digest",
      html: "<p>hi</p>",
      meta: { campaign: "onboard" },
    });
    expect(result.accepted).toEqual(["a@x.com", "b@x.com"]);
  });

  it("never throws for a basic send (request-path safety)", async () => {
    const mailer = createMailer();
    await expect(mailer.send({ to: "x@y.z", subject: "t", text: "body" })).resolves.toMatchObject({
      accepted: ["x@y.z"],
    });
  });

  it("throws when SMTP driver is configured without smtp options", () => {
    expect(() => createMailer({ driver: "smtp" })).toThrow(/requires smtp options/);
  });
});
