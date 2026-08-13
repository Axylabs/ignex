// Deliberately non-optimizable: returns Response.json(...) directly, which
// bypasses AOT optimizations. The compiler must warn (IGN_NON_OPTIMIZABLE_RESPONSE).
import { get } from "@ignex/core/http";

export default get(() => Response.json({ ok: true }));
