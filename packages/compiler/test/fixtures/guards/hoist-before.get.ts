// A hoistable constant body WITH a before-guard array: the compiler must NOT
// hoist it to a frozen body (the guard would be bypassed) — regression test
// for the localHooks hoist gate.
import { get } from "@ignex/core/http";
import { withGuards } from "../../lib/guards";

export default get(() => ({ ok: true }), { before: [withGuards({ permissions: ["hoist:read"] })] });
