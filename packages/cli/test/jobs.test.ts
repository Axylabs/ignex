/**
 * `ignex queue:work` — the src/jobs.ts template contract.
 */
import { describe, expect, it } from "vitest";
import { jobsTemplate } from "../src/templates/jobs.js";

describe("jobsTemplate", () => {
  it("wires createDurableJobQueue + store with start/stop", () => {
    const code = jobsTemplate();
    expect(code).toContain('from "@ignex/core"');
    expect(code).toContain("createDurableJobQueue({ store, handlers })");
    expect(code).toContain("createFileJobStore");
    expect(code).toContain("export const queue = createDurableJobQueue");
    expect(code).toContain("export async function start()");
    expect(code).toContain("export async function stop()");
    expect(code).toContain("queue.start()");
  });
});
