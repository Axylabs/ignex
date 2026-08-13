import { get } from "@ignex/core/http";

export default get((ctx) => {
  const html = `<!doctype html>
<html>
  <head>
    <title>Ignex API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/openapi.json"
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

  return ctx.html(html, {
    headers: {
      "cache-control": "no-store",
    },
  });
});
