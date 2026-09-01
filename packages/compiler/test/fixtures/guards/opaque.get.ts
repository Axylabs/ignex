// Opaque guards: the guards object references an imported constant the
// compiler cannot fold. The runtime wrapper MUST be preserved (the route must
// NOT be inlined), otherwise authorization silently degrades.
import { get } from "@ignex/core/http";
import { withGuards } from "../../lib/guards";
import { ADMIN_PERMS } from "../../lib/perms";

export default withGuards(
  get((ctx) => ctx.json({ marker: "opaque-body" })),
  { permissions: ADMIN_PERMS },
);
