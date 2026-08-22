// RBAC-guarded route: `withGuards` wraps the handler with roles + permissions.
import { get } from "@ignex/core/http";
import { withGuards } from "../../lib/guards";

export default withGuards(
  get((ctx) => ctx.json({ secret: "42" })),
  { roles: ["admin"], permissions: ["users:read"] },
);
