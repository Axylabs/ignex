import { createI18n } from "@ignus/core";
import { get } from "@ignus/core/http";

const i18n = createI18n(
  {
    en: { greeting: "Hello {name}" },
    es: { greeting: "Hola {name}" },
    fr: { greeting: "Bonjour {name}" },
    de: { greeting: "Hallo {name}" },
  },
  { fallbackLocale: "en" },
);

/** GET /i18n — locale negotiation (Accept-Language) + translation. */
export default get((ctx) => {
  const locale = i18n.locale(ctx);
  const name = ctx.query.get("name") ?? "world";

  return ctx.json({
    locale,
    accepted: ctx.headers.get("accept-language") ?? null,
    message: i18n.t("greeting", { name }, locale),
  });
});
