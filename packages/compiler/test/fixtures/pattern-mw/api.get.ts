import { get } from "@ignex/core/http";

export default get((ctx) => ctx.json({ ok: true }));
