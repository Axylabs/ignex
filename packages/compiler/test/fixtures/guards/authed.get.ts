// Auth-only guarded route: bare `withGuards` requires an authenticated user.
import { get } from "@ignex/core/http";
import { withGuards } from "../../lib/guards";

export default withGuards(get((ctx) => ctx.json({ ok: true })));
