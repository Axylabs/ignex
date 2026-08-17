// Auth-only guarded route: bare `withGuards` requires an authenticated user.
import { withGuards } from "@ignex/core";
import { get } from "@ignex/core/http";

export default withGuards(get((ctx) => ctx.json({ ok: true })));
