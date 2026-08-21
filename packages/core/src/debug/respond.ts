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

/** Standard 404 JSON body for unknown dashboard API paths. */
export const notFound = (): Response => json({ error: "not_found", status: 404 }, 404);

/** Read a request body preview (bounded). */
export const readBodyPreview = async (res: Response, maxBytes: number): Promise<string> => {
  try {
    const text = await res.clone().text();
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… (truncated)` : text;
  } catch {
    return "";
  }
};
