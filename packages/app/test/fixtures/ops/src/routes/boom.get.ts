import { get } from "@ignex/core/http";

/** GET /boom — throws → exercises the central error handler (500). */
export default get(async () => {
  throw new Error("kaboom");
});
