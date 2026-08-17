// Permission guard with `all: true` → `canAll(...)`.
import { withGuards } from "@ignex/core";
import { get } from "@ignex/core/http";

export default withGuards(
  get((ctx) => ctx.json({ ok: true })),
  {
    permissions: ["orders:read", "orders:write"],
    all: true,
  },
);
