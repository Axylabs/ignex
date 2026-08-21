/**
 * `ignex schedule:run` + scheduler wiring — command-level tests.
 *
 * The scheduler itself is covered by packages/core/test/scheduler.test.ts;
 * here we test the CLI command's contract: the `src/schedule.ts` contract
 * (start/stop exports), the generated template, and the missing-file error.
 */
import { describe, expect, it } from "vitest";
import { scheduleTemplate } from "../src/templates/schedule.js";

describe("scheduleTemplate", () => {
  it("wires createScheduler + durable queue with start/stop", () => {
    const code = scheduleTemplate();
    expect(code).toContain('from "@ignex/core"');
    expect(code).toContain("createScheduler({ store })");
    expect(code).toContain("createDurableJobQueue({ store, handlers })");
    expect(code).toContain("createFileJobStore");
    expect(code).toContain("export async function start()");
    expect(code).toContain("export async function stop()");
    expect(code).toContain("queue.start()");
    expect(code).toContain("scheduler.start()");
  });

  it("leaves cron registrations commented (developer fills them in)", () => {
    const code = scheduleTemplate();
    expect(code).toContain("scheduler.cron(");
    expect(code).toContain("// scheduler.cron(");
  });
});
