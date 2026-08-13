import { createWSHandler } from "@ignex/core";

export const wsHandler = createWSHandler({
  open(ws) {
    ws.send("Welcome to Ignex");
  },
  message(ws, message) {
    ws.send(String(message));
  },
});
