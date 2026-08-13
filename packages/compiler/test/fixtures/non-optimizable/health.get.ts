// AOT-optimizable control: ctx.json(...) must NOT trigger the warning.
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.json({ ok: true }));
