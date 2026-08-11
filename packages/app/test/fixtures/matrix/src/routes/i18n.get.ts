import { get } from "@ignus/core/http";

/** GET /i18n — echoes the negotiated locale (set by the i18n middleware). */
export default get(async (ctx) => ctx.json({ locale: ctx.getState<string>("locale") ?? "en" }));
