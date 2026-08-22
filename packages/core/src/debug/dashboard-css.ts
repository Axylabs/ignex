/**
 * @fileoverview Debugbar dashboard stylesheet — served at `{path}/app.css`.
 *
 * A self-contained design system: tokenized dark theme (light via
 * `[data-theme="light"]`), layered surfaces, method/status/span-kind colors,
 * stat cards, tables, waterfalls, charts and toasts. Vanilla CSS — no
 * framework, no fonts, no network — so the dashboard works on any Bun dev box
 * with zero installs. `__BASE__` is replaced by the plugin when serving.
 */

export const DEBUGBAR_DASHBOARD_CSS = `
:root {
  color-scheme: dark;
  --bg: #0b0f14;
  --panel: #11171f;
  --panel2: #161e28;
  --raised: #1b2431;
  --border: #212c3a;
  --border-strong: #2d3b4d;
  --text: #dce5ef;
  --muted: #8b9cb1;
  --faint: #5d6d80;
  --accent: #4da3ff;
  --accent-dim: #2f6fb8;
  --accent2: #8b7bff;
  --ok: #34d399;
  --warn: #fbbf24;
  --err: #f87171;
  --info: #38bdf8;
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  --radius: 12px;
  --radius-sm: 8px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --m-get: #34d399;
  --m-post: #4da3ff;
  --m-put: #fbbf24;
  --m-patch: #2dd4bf;
  --m-delete: #f87171;
  --m-head: #a78bfa;
  --m-options: #94a3b8;
  --k-db: #4da3ff;
  --k-cache: #34d399;
  --k-http: #a78bfa;
  --k-render: #fbbf24;
  --k-auth: #fb7185;
  --k-lifecycle: #22d3ee;
  --k-custom: #8b9cb1;
  --k-error: #f87171;
  --k-request: #22d3ee;
}
html[data-theme="light"] {
  color-scheme: light;
  --bg: #f4f6f9;
  --panel: #ffffff;
  --panel2: #eef2f7;
  --raised: #e6ecf3;
  --border: #dbe3ec;
  --border-strong: #c3cfdd;
  --text: #1a2332;
  --muted: #5a6b80;
  --faint: #8a99ab;
  --accent: #1877e0;
  --accent2: #6d5bd0;
  --ok: #0f9d6e;
  --warn: #b47a08;
  --err: #d93025;
  --info: #0b7bb8;
  --shadow: 0 10px 30px rgba(30, 45, 70, 0.12);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 var(--font);
  -webkit-font-smoothing: antialiased;
}

/* ── top bar ─────────────────────────────────────────────── */
.topbar {
  position: sticky; top: 0; z-index: 50;
  display: flex; align-items: center; gap: 18px;
  padding: 0 18px; height: 54px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand .logo {
  display: grid; place-items: center; width: 30px; height: 30px;
  border-radius: 8px; font-size: 16px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff; box-shadow: var(--shadow);
}
.brand h1 { font-size: 14px; font-weight: 700; margin: 0; letter-spacing: .01em; }
.brand .sub { font-size: 11px; color: var(--muted); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
nav { display: flex; gap: 2px; margin-left: auto; align-items: center; }
nav button {
  appearance: none; border: 0; background: transparent; color: var(--muted);
  font: 600 12.5px var(--font); padding: 7px 12px; border-radius: 7px; cursor: pointer;
  transition: background .12s, color .12s;
}
nav button:hover { background: var(--panel2); color: var(--text); }
nav button.active { background: var(--accent); color: #fff; box-shadow: 0 2px 10px color-mix(in srgb, var(--accent) 45%, transparent); }
.topbar-actions { display: flex; align-items: center; gap: 8px; }
.icon-btn {
  appearance: none; border: 1px solid var(--border); background: var(--panel2); color: var(--muted);
  width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 14px;
  display: grid; place-items: center; transition: color .12s, border-color .12s;
}
.icon-btn:hover { color: var(--text); border-color: var(--border-strong); }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.live-dot.paused { background: var(--warn); box-shadow: 0 0 8px var(--warn); }

/* ── layout ──────────────────────────────────────────────── */
main { max-width: 1400px; margin: 0 auto; padding: 18px 18px 60px; }
.panel {
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 2px rgba(0,0,0,.12);
}
.panel h2 { margin: 0 0 12px; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); }
.panel-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.panel-head h2 { margin: 0; }
.grow { flex: 1; min-width: 0; }

/* ── stat cards ──────────────────────────────────────────── */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.stat {
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px 14px; position: relative; overflow: hidden;
}
.stat .v { font-size: 22px; font-weight: 800; font-family: var(--mono); line-height: 1.1; letter-spacing: -.02em; }
.stat .k { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; margin-top: 3px; }
.stat .sub { font-size: 11px; color: var(--faint); font-family: var(--mono); margin-top: 2px; }
.stat.accent { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.stat.accent .v { color: var(--accent); }
.stat.err .v { color: var(--err); }
.stat.ok .v { color: var(--ok); }
.stat::after {
  content: ""; position: absolute; right: -20px; top: -20px; width: 70px; height: 70px;
  border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%);
}

/* ── toolbar / filters ───────────────────────────────────── */
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
input[type="text"], select, .search {
  background: var(--panel2); border: 1px solid var(--border); color: var(--text);
  padding: 7px 10px; border-radius: 8px; font: 13px var(--font); outline: none;
  transition: border-color .12s, box-shadow .12s;
}
input[type="text"]:focus, select:focus, .search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
.search { min-width: 220px; }
textarea.search {
  resize: vertical; min-height: 58px; width: 100%; font-family: var(--mono); font-size: 12px;
  background: var(--panel2); border: 1px solid var(--border); color: var(--text);
  padding: 7px 10px; border-radius: 8px; outline: none;
}
textarea.search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
button.ghost, button.primary {
  appearance: none; font: 600 12.5px var(--font); padding: 7px 12px; border-radius: 8px; cursor: pointer;
  transition: filter .12s, background .12s, border-color .12s;
}
button.ghost { background: transparent; border: 1px solid var(--border); color: var(--muted); }
button.ghost:hover { color: var(--text); border-color: var(--border-strong); }
button.primary { background: var(--accent); border: 1px solid var(--accent); color: #fff; }
button.primary:hover { filter: brightness(1.08); }
button.mini { padding: 4px 8px; font-size: 11.5px; border-radius: 6px; }

/* ── tables ──────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; }
tbody tr { cursor: pointer; transition: background .1s; }
tbody tr:hover { background: var(--panel2); }
tbody tr:last-child td { border-bottom: 0; }
td.mono, .mono { font-family: var(--mono); }
td.num, .num { font-family: var(--mono); text-align: right; }

/* ── pills / badges ──────────────────────────────────────── */
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700;
  font-family: var(--mono); letter-spacing: .02em; border: 1px solid transparent;
}
.pill.method { background: color-mix(in srgb, var(--mc, var(--muted)) 14%, transparent); color: var(--mc, var(--muted)); border-color: color-mix(in srgb, var(--mc, var(--muted)) 35%, transparent); }
.pill.method.get { --mc: var(--m-get); } .pill.method.post { --mc: var(--m-post); }
.pill.method.put { --mc: var(--m-put); } .pill.method.patch { --mc: var(--m-patch); }
.pill.method.delete { --mc: var(--m-delete); } .pill.method.head { --mc: var(--m-head); }
.pill.method.options { --mc: var(--m-options); }
.pill.status { background: color-mix(in srgb, var(--sc, var(--muted)) 14%, transparent); color: var(--sc, var(--muted)); border-color: color-mix(in srgb, var(--sc, var(--muted)) 35%, transparent); }
.pill.status.ok { --sc: var(--ok); } .pill.status.warn { --sc: var(--warn); } .pill.status.err { --sc: var(--err); } .pill.status.info { --sc: var(--info); }
.pill.kind { background: color-mix(in srgb, var(--kc, var(--muted)) 14%, transparent); color: var(--kc, var(--muted)); border-color: color-mix(in srgb, var(--kc, var(--muted)) 30%, transparent); font-weight: 600; }
.chip {
  display: inline-block; padding: 1px 7px; border-radius: 5px; font-size: 10.5px;
  font-family: var(--mono); border: 1px solid var(--border); margin: 0 4px 4px 0; color: var(--muted); background: var(--panel2);
}
.dot { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }

/* ── duration / status coloring ──────────────────────────── */
.dur-ok { color: var(--ok); } .dur-warn { color: var(--warn); } .dur-slow { color: var(--err); }
.muted { color: var(--muted); } .faint { color: var(--faint); }
.bar-row { display: flex; align-items: center; gap: 8px; }
.bar-track { flex: 1; height: 6px; background: var(--panel2); border-radius: 3px; overflow: hidden; min-width: 40px; }
.bar-fill { height: 100%; border-radius: 3px; background: var(--bar-color, var(--accent)); }

/* ── waterfall ───────────────────────────────────────────── */
.wf { position: relative; }
.wf-row { display: grid; grid-template-columns: 230px 1fr; gap: 10px; align-items: center; padding: 2.5px 0; }
.wf-label { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11.5px; font-family: var(--mono); }
.wf-label .pill.kind { margin-right: 4px; }
.wf-track { position: relative; height: 16px; background: var(--panel2); border-radius: 4px; overflow: hidden; }
.wf-bar { position: absolute; top: 2px; bottom: 2px; border-radius: 3px; min-width: 2px; box-shadow: 0 0 6px color-mix(in srgb, currentColor 40%, transparent); }
.wf-bar:hover { outline: 1px solid #fff; }
.wf-ruler { display: flex; justify-content: space-between; color: var(--faint); font-size: 10px; font-family: var(--mono); padding: 4px 0 6px; }
.wf-legend { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0 10px; }
.wf-legend span { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }

/* Expandable span rows: the bar row is the <summary>, details unfold below. */
.wf-item > summary { list-style: none; cursor: pointer; }
.wf-item > summary::-webkit-details-marker { display: none; }
.wf-item[open] > summary .wf-label { color: var(--text); }
.wf-detail {
  margin: 4px 0 10px 240px; padding: 8px 12px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-size: 11.5px; font-family: var(--mono);
}
.wf-detail .kvs .k { min-width: 120px; }
.wf-detail .kvs div { padding: 2.5px 0; }
pre.mini {
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 8px; margin: 3px 0 0; overflow: auto; white-space: pre-wrap; font-size: 11px;
}

/* Unaccounted idle gaps between spans (event-loop / untraced waits). */
.wf-row.wf-gap { padding: 0; }
.wf-row.wf-gap .wf-label { font-size: 10px; color: var(--faint); }
.wf-row.wf-gap .wf-track { height: 6px; background: transparent; }
.wf-bar.gap {
  top: 1px; bottom: 1px; background: repeating-linear-gradient(45deg, var(--faint) 0 2px, transparent 2px 5px);
  opacity: 0.55; box-shadow: none;
}

/* ── time breakdown (stacked bar + kind rows) ────────────── */
.panel-head .hint { color: var(--faint); font-size: 11px; font-family: var(--mono); margin-left: auto; }
.stack { display: flex; height: 14px; border-radius: 4px; overflow: hidden; background: var(--panel2); margin: 4px 0 10px; }
.stack .seg { height: 100%; min-width: 1px; }
.stack .seg.unacc { background: repeating-linear-gradient(45deg, var(--faint) 0 2px, transparent 2px 5px); opacity: 0.6; }
.bd-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; padding: 3px 0; font-family: var(--mono); border-bottom: 1px dashed var(--border); }
.bd-row:last-child { border-bottom: 0; }
.bd-row .dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
.bd-row .name { color: var(--muted); width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-row .count { color: var(--faint); font-size: 10.5px; width: 34px; text-align: right; }
.bd-row .ms { margin-left: auto; }
.bd-row .pct { width: 48px; text-align: right; color: var(--faint); }

/* ── tree ────────────────────────────────────────────────── */
.tree { font-size: 12.5px; }
.tree .node { padding: 3px 0 3px 18px; border-left: 1px solid var(--border); margin-left: 8px; }
.tree .node.root { padding-left: 0; border-left: none; margin-left: 0; }
.tree-meta { margin: -2px 0 4px 34px; font-size: 10.5px; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-meta .faint + .faint::before { content: " · "; }

/* ── kvs (key/value) ─────────────────────────────────────── */
.kvs { font-size: 12px; }
.kvs div { padding: 4px 0; border-bottom: 1px dashed var(--border); display: flex; gap: 12px; align-items: baseline; }
.kvs .k { color: var(--muted); min-width: 190px; font-family: var(--mono); font-size: 11px; }
.kvs .v { word-break: break-all; }

/* ── pre / stacks / replay ───────────────────────────────── */
pre.stack, pre.replay, pre.body {
  background: var(--panel2); border: 1px solid var(--border); padding: 12px; border-radius: 8px;
  overflow: auto; font-size: 12px; font-family: var(--mono); white-space: pre-wrap; max-height: 340px;
}
pre.stack { color: var(--err); }
pre.body { color: var(--text); }

/* ── tabs (request detail) ───────────────────────────────── */
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 14px; flex-wrap: wrap; }
.tabs button {
  appearance: none; border: 0; background: transparent; color: var(--muted); font: 600 12.5px var(--font);
  padding: 8px 13px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }

/* ── summary strip (detail header) ───────────────────────── */
.summary {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px 16px; margin-bottom: 14px;
}
.summary .route-path { font-family: var(--mono); font-size: 13px; font-weight: 600; word-break: break-all; }
.summary .meta { color: var(--muted); font-size: 11.5px; font-family: var(--mono); }
.summary .spacer { flex: 1; }

/* ── markdown (KT) ───────────────────────────────────────── */
.markdown { line-height: 1.65; }
.markdown h1 { font-size: 22px; color: var(--accent); margin: 6px 0 14px; }
.markdown h2 { font-size: 15px; margin-top: 24px; border-bottom: 1px solid var(--border); padding-bottom: 5px; }
.markdown h3 { font-size: 13px; margin-top: 16px; }
.markdown p { margin: 8px 0; }
.markdown table { font-size: 12px; margin: 10px 0; }
.markdown code { background: var(--panel2); padding: 1px 6px; border-radius: 5px; font-size: 11.5px; font-family: var(--mono); }
.markdown pre { background: var(--panel2); padding: 12px; border-radius: 8px; overflow: auto; }
.markdown pre code { background: transparent; padding: 0; }
.markdown blockquote { border-left: 3px solid var(--accent); margin: 10px 0; padding: 2px 14px; color: var(--muted); }
.markdown ul, .markdown ol { padding-left: 22px; }
.markdown a { color: var(--accent); text-decoration: none; }
.markdown a:hover { text-decoration: underline; }

/* ── charts ──────────────────────────────────────────────── */
canvas { width: 100%; height: 110px; display: block; }
.chart-panel { padding-top: 8px; }
.chart-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.chart-head .now { font-size: 17px; font-weight: 800; font-family: var(--mono); }
.chart-head .lbl { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; }
.chart-head .range { color: var(--faint); font-size: 10.5px; font-family: var(--mono); }

/* ── empty / states ──────────────────────────────────────── */
.empty { color: var(--muted); text-align: center; padding: 34px 16px; }
.empty .big { font-size: 26px; margin-bottom: 6px; }
.empty .hint { font-size: 12px; color: var(--faint); margin-top: 4px; }
.skeleton { border-radius: 8px; background: linear-gradient(90deg, var(--panel2) 25%, var(--raised) 50%, var(--panel2) 75%); background-size: 200% 100%; animation: shimmer 1.3s infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }

/* ── toast ───────────────────────────────────────────────── */
.toast {
  position: fixed; bottom: 20px; right: 20px; z-index: 200;
  background: var(--raised); border: 1px solid var(--border-strong); border-radius: 10px;
  padding: 10px 16px; font-size: 12.5px; box-shadow: var(--shadow);
  display: none; max-width: 420px;
}
.toast.show { display: block; animation: toast-in .15s ease-out; }
@keyframes toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

/* ── status bar ──────────────────────────────────────────── */
.statusbar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: flex; gap: 18px; align-items: center;
  padding: 6px 18px; font-size: 10.5px; font-family: var(--mono); color: var(--faint);
  background: color-mix(in srgb, var(--panel) 92%, transparent); backdrop-filter: blur(8px);
  border-top: 1px solid var(--border);
}
.statusbar .grow { flex: 1; }

/* ── events (NATS) ───────────────────────────────────────── */
.publish-composer { display: grid; grid-template-columns: 1fr 1.6fr auto; gap: 8px; align-items: start; }
.publish-composer .hint { align-self: center; font-size: 11.5px; }
.publish-composer textarea { grid-row: span 2; }
@media (max-width: 860px) { .publish-composer { grid-template-columns: 1fr; } .publish-composer textarea { grid-row: auto; } }

/* ── clients (published SDK / frontend clients) ──────────── */
.client-card { margin-bottom: 12px; padding: 14px 16px; }
.client-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.client-head .spacer { flex: 1; }
.client-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px 18px; margin-top: 10px; }
.client-meta .k { color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; display: block; }
.client-meta .v { font-size: 12px; word-break: break-all; }
.client-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.client-tags .chip { font-family: var(--mono); }
.client-files { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.client-files code {
  font-family: var(--mono); font-size: 10.5px; color: var(--muted);
  background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px;
}
.hint code { font-family: var(--mono); font-size: 11px; background: var(--panel2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; color: var(--text); }

@media (max-width: 860px) {
  .wf-row { grid-template-columns: 140px 1fr; }
  .wf-detail { margin-left: 150px; }
  .brand .sub { display: none; }
  nav button { padding: 7px 8px; font-size: 11.5px; }
}
`;
