/**
 * `createNotifier` — notifications over nova events with an email fallback.
 */

import { createMailer, createNotifier } from "@ignex/core";
import { describe, expect, it, vi } from "vitest";

describe("createNotifier", () => {
  it("degrades gracefully when @ignex/nova is absent (email fallback only)", async () => {
    const log = vi.fn();
    const mailer = createMailer({ driver: "log", log: { log } as unknown as Console });
    const notify = createNotifier({
      mailer,
      emailSubjects: { "order.update": "Your order changed" },
    });

    // Without nova installed, emitToUser is undefined → email fallback only.
    await expect(
      notify.user({ id: "u-1", email: "u@x.com" }, "order.update", { orderId: "o-1" }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("skips email when no subject is registered for the name", async () => {
    const log = vi.fn();
    const mailer = createMailer({ driver: "log", log: { log } as unknown as Console });
    const notify = createNotifier({ mailer }); // no emailSubjects
    await notify.user({ id: "u-1", email: "u@x.com" }, "order.update", { orderId: "o-1" });
    expect(log).not.toHaveBeenCalled();
  });

  it("does not send email when the user has no address", async () => {
    const log = vi.fn();
    const mailer = createMailer({ driver: "log", log: { log } as unknown as Console });
    const notify = createNotifier({ mailer, emailSubjects: { x: "X" } });
    await notify.user({ id: "u-1" }, "x", {});
    expect(log).not.toHaveBeenCalled();
  });
});
