import { createWSHandler } from "@ignex/core";

/** WS /echo — used by the multi-WS-route codegen test (dispatcher by path). */
export const wsHandler = createWSHandler({
  message(ws, message) {
    ws.send(`echo:${String(message)}`);
  },
});
