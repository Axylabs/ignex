// RBAC-guarded route: `withGuards` wraps the handler with roles + permissions.
import { withGuards } from "@ignex/core";
import { get } from "@ignex/core/http";

export default withGuards(
  get((ctx) => ctx.json({ secret: "42" })),
  { roles: ["admin"], permissions: ["users:read"] },
);
