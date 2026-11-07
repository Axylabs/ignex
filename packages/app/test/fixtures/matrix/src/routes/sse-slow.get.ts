import { sse } from "@ignex/core";
import { get } from "@ignex/core/http";

/** GET /sse-slow — paced SSE (one `tick` every 30ms) for client-abort journeys. */
export default get(async () => {
  async function* events() {
    for (let i = 1; i <= 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield { event: "tick", data: String(i) };
    }
  }

  return sse(events());
});
