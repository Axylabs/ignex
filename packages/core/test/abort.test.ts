import { abortedResponse, createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";

describe("abortedResponse (shared pre-abort helper)", () => {
  it("is an empty 200", async () => {
    const res = abortedResponse();
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("");
  });

  it("matches the shape the interpreted lifecycle returns for a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await createApp({ handler: () => new Response("ran") }).handler(
      new Request("http://localhost/", { signal: controller.signal }),
    );

    expect(res.status).toBe(abortedResponse().status);
    await expect(res.text()).resolves.toBe("");
  });
});
