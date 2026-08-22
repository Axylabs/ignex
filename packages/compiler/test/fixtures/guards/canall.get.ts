// Permission guard with `all: true` → `canAll(...)`.
import { get } from "@ignex/core/http";
import { withGuards } from "../../lib/guards";

export default withGuards(
  get((ctx) => ctx.json({ ok: true })),
  {
    permissions: ["orders:read", "orders:write"],
    all: true,
  },
);
