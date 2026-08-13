import { get } from "@ignex/core/http";

/** GET /home — relative redirect (must survive compilation without crashing). */
export default get((ctx) => ctx.redirect("/login", 303));
