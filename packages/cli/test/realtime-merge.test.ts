/**
 * Unit tests for the additive realtime-contract merge (`realtime-merge.ts`) —
 * the piece that lets `ignex event bus` run more than once without dropping
 * events or leaving consumers referencing unregistered event names.
 */

import { describe, expect, it } from "vitest";
import { mergeEventIntoRealtimeSource } from "../src/utils/realtime-merge.js";

const CONTRACT_SINGLE_LINE = `import { Type } from "@sinclair/typebox";

export const realtime = {
  subjectPrefix: "order",
  events: {
    "order.created": Type.Object({ id: Type.String(), at: Type.Integer() }),
  },
  controlEvents: {},
};
`;

describe("mergeEventIntoRealtimeSource", () => {
  it("adds an event after existing single-line entries", () => {
    const { source, added } = mergeEventIntoRealtimeSource(CONTRACT_SINGLE_LINE, "chat.message");
    expect(added).toBe(true);
    expect(source).toContain(
      '"order.created": Type.Object({ id: Type.String(), at: Type.Integer() }),',
    );
    expect(source).toContain(
      '"chat.message": Type.Object({ id: Type.String(), at: Type.Integer() }),',
    );
    // The events object is still opened/closed exactly once.
    expect(source.match(/events: \{/g)).toHaveLength(1);
  });

  it("adds after a multi-line Type.Object entry", () => {
    const multi = `import { Type } from "@sinclair/typebox";

export const realtime = {
  subjectPrefix: "a",
  events: {
    "order.created": Type.Object({
      id: Type.String(),
      at: Type.Integer(),
    }),
  },
  controlEvents: {},
};
`;
    const { source, added } = mergeEventIntoRealtimeSource(multi, "order.updated");
    expect(added).toBe(true);
    expect(source).toContain(
      '"order.updated": Type.Object({ id: Type.String(), at: Type.Integer() }),',
    );
  });

  it("expands an empty inline events object", () => {
    const empty = `import { Type } from "@sinclair/typebox";

export const realtime = {
  subjectPrefix: "a",
  events: {},
  controlEvents: {},
};
`;
    const { source, added } = mergeEventIntoRealtimeSource(empty, "order.created");
    expect(added).toBe(true);
    expect(source).toContain(
      '"order.created": Type.Object({ id: Type.String(), at: Type.Integer() }),',
    );
  });

  it("is idempotent when the event already exists", () => {
    const { source, added, reason } = mergeEventIntoRealtimeSource(
      CONTRACT_SINGLE_LINE,
      "order.created",
    );
    expect(added).toBe(false);
    expect(reason).toBe("present");
    expect(source).toBe(CONTRACT_SINGLE_LINE);
  });

  it("refuses to touch a contract without an events object", () => {
    const source = "export const realtime = {};";
    const result = mergeEventIntoRealtimeSource(source, "x.y");
    expect(result.added).toBe(false);
    expect(result.reason).toBe("unparseable");
    expect(result.source).toBe(source);
  });
});
