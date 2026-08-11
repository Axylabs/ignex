import { createWSHandler } from "@ignus/core";

export const wsHandler = createWSHandler({
  open(ws) {
    ws.send("Welcome to Ignus");
  },
  message(ws, message) {
    ws.send(String(message));
  },
});
