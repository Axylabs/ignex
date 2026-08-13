import { get } from "@ignex/core/http";

export default get(async () => {
  const file = Bun.file("dist/openapi.json");

  return new Response(file, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});
