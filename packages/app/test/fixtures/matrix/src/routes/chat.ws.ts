import { createWSHandler } from "@ignex/core";

/**
 * WS /chat — module-level connection counter + echo, used by the real-socket
 * E2E suite to exercise upgrade, messaging and concurrency against the
 * compiled server.
 */
let connections = 0;

export const wsHandler = createWSHandler({
  open(ws) {
    connections += 1;
    ws.send(JSON.stringify({ event: "open", connections }));
  },
  message(ws, message) {
    ws.send(`echo:${String(message)}`);
  },
  close() {
    connections -= 1;
  },
});
