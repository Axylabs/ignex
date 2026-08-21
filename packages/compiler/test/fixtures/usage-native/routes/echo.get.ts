// Schema-less route that READS the query — the castrum-aligned usage-only
// native path (parse in Rust, seed ctx.query with the NativeQueryParams
// facade, no record/URLSearchParams/JS-fallback machinery).
export default (ctx) => ctx.json({ hello: ctx.query.get("name") ?? "world", size: ctx.query.size });
