/**
 * @fileoverview Debugbar dashboard HTTP responders — shared by the dashboard
 * serving and request-replay paths of the `debugbar()` plugin.
 */

/** JSON response with `no-store` (dashboard data must never be cached). */
export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** HTML response with `no-store` (dashboard pages must never be cached). */
export const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * JavaScript response with `no-store`. The dashboard app at `{path}/app.js`
 * must be served with a JS MIME type — `text/html` is refused by strict MIME
 * checking ("Refused to execute script … MIME type ('text/html')").
 */
export const jsResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
  });

/** Standard 404 JSON body for unknown dashboard API paths. */
export const notFound = (): Response => json({ error: "not_found", status: 404 }, 404);

/** Read a request body preview (bounded — never buffers more than `maxBytes`). */
export const readBodyPreview = async (res: Response, maxBytes: number): Promise<string> => {
  try {
    const body = res.clone().body;
    if (body === null) return "";
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let preview = "";
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      preview += decoder.decode(value, { stream: true });
      if (preview.length > maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    preview += decoder.decode();
    if (preview.length > maxBytes) {
      preview = preview.slice(0, maxBytes);
      truncated = true;
    }
    return truncated ? `${preview}\n… (truncated)` : preview;
  } catch {
    return "";
  }
};
