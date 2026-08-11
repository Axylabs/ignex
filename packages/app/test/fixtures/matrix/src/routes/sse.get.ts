import { sse } from "@ignus/core";
import { get } from "@ignus/core/http";

/** GET /sse — streaming Server-Sent Events. */
export default get(async () => {
  async function* events() {
    yield { event: "ping", data: "1" };
    yield { event: "ping", data: "2" };
    yield { event: "done", data: "bye" };
  }

  return sse(events());
});
