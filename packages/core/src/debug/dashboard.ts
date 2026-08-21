/**
 * @fileoverview Debugbar dashboard — self-contained SPA (no external deps).
 *
 * The dashboard is two same-origin resources:
 *   - index.html — the shell (inline styles only; CSP `style-src 'unsafe-inline'`)
 *   - app.js     — the app (served as a file so CSP `script-src 'self'` allows it)
 *
 * Views: Requests (list + filters), Request detail (waterfall, spans, queries,
 * headers, error stack, replay), System (CPU/memory/event-loop sparklines) and
 * KT (the generated knowledge doc). All data comes from the `{path}/api/*`
 * endpoints; the whole UI is vanilla JS so it works on any Bun dev box with
 * zero installs. `__BASE__` in the HTML is replaced by the plugin with the
 * configured path.
 */

/** Shell page. */
export const DEBUGBAR_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>IgnEx Debugbar</title>
    <style>
      :root {
        --bg: #0f1419; --panel: #161c23; --panel2: #1b232c; --border: #26313c;
        --text: #d7e0e8; --muted: #8aa0b2; --accent: #4da3ff; --green: #3fb97f;
        --red: #ff5d5d; --amber: #f5a623; --purple: #b18cff; --blue: #4da3ff;
        --db: #4da3ff; --cache: #3fb97f; --http: #b18cff; --render: #f5a623;
        --auth: #ff7eb6; --custom: #8aa0b2; --error: #ff5d5d; --lifecycle: #5ac8d8;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
      header { display: flex; align-items: center; gap: 14px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; flex-wrap: wrap; }
      header h1 { font-size: 15px; margin: 0; color: var(--accent); }
      header .sub { color: var(--muted); font-size: 12px; }
      nav { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; }
      nav button { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 5px 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12px; }
      nav button.active { color: #fff; background: var(--accent); border-color: var(--accent); }
      main { padding: 16px; max-width: 1200px; margin: 0 auto; }
      .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 14px; }
      .panel h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
      th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
      tbody tr { cursor: pointer; }
      tbody tr:hover { background: var(--panel2); }
      .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); }
      .badge.ok { color: var(--green); border-color: var(--green); }
      .badge.err { color: var(--red); border-color: var(--red); }
      .badge.warn { color: var(--amber); border-color: var(--amber); }
      .muted { color: var(--muted); }
      .flex { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .grow { flex: 1; }
      input, select { background: var(--panel2); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font: inherit; font-size: 13px; }
      button.primary { background: var(--accent); border: 1px solid var(--accent); color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 13px; }
      button.ghost { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 5px 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12px; }
      .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
      .stat { background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
      .stat .v { font-size: 20px; font-weight: 700; }
      .stat .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
      .wf { position: relative; }
      .wf-row { display: grid; grid-template-columns: 240px 1fr; gap: 10px; align-items: center; padding: 2px 0; }
      .wf-label { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
      .wf-track { position: relative; height: 18px; background: var(--panel2); border-radius: 3px; overflow: hidden; }
      .wf-bar { position: absolute; top: 1px; bottom: 1px; border-radius: 3px; min-width: 2px; }
      .wf-bar:hover { outline: 1px solid #fff; }
      .wf-legend { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0; }
      .wf-legend span { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }
      .dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
      .tree { font-size: 13px; }
      .tree .node { padding: 3px 0 3px 18px; border-left: 1px solid var(--border); margin-left: 8px; }
      .tree .node.root { padding-left: 0; border-left: none; margin-left: 0; }
      pre.stack { background: var(--panel2); padding: 10px; border-radius: 8px; overflow: auto; font-size: 12px; color: var(--red); white-space: pre-wrap; }
      pre.replay { background: var(--panel2); padding: 10px; border-radius: 8px; overflow: auto; font-size: 12px; max-height: 300px; }
      .kvs { font-size: 12px; }
      .kvs div { padding: 2px 0; border-bottom: 1px dashed var(--border); display: flex; gap: 10px; }
      .kvs .k { color: var(--muted); min-width: 180px; }
      .kvs .v { word-break: break-all; }
      canvas { width: 100%; height: 120px; }
      .markdown h1 { font-size: 20px; color: var(--accent); }
      .markdown h2 { font-size: 15px; margin-top: 22px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
      .markdown h3 { font-size: 13px; }
      .markdown table { font-size: 12px; }
      .markdown code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
      .markdown blockquote { border-left: 3px solid var(--accent); margin: 8px 0; padding: 2px 12px; color: var(--muted); }
      .markdown ul, .markdown ol { padding-left: 22px; }
      .toast { position: fixed; bottom: 16px; right: 16px; background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; display: none; z-index: 100; }
      .empty { color: var(--muted); text-align: center; padding: 30px; }
      .dur-ok { color: var(--green); } .dur-warn { color: var(--amber); } .dur-slow { color: var(--red); }
      .chip { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 11px; border: 1px solid var(--border); margin-right: 4px; color: var(--muted); }
    </style>
  </head>
  <body>
    <header>
      <h1>⚡ IgnEx Debugbar</h1>
      <span class="sub" id="env"></span>
      <nav>
        <button data-view="requests" class="active">Requests</button>
        <button data-view="errors">Errors</button>
        <button data-view="system">System</button>
        <button data-view="kt">KT · How it works</button>
      </nav>
    </header>
    <main id="view"></main>
    <div class="toast" id="toast"></div>
    <script src="__BASE__/app.js"></script>
  </body>
</html>`;

/**
 * Dashboard app (served at `{path}/app.js`).
 *
 * Written as a single TS template literal; the embedded JS deliberately avoids
 * backticks and `${` sequences so the string needs no escaping.
 */
export const DEBUGBAR_DASHBOARD_JS = `
"use strict";
var BASE = document.currentScript ? document.currentScript.getAttribute("data-base") || "." : ".";
var TOKEN = (window.location.search.match(/[?&]token=([^&]+)/) || [])[1] || "";
var REFRESH_MS = 5000;
var state = { view: "requests", errorOnly: false, paused: false, search: "", timer: null, detailId: null };

function withToken(p) { return p + (p.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(TOKEN); }
function api(p) { return fetch(withToken(BASE + "/api" + p), { headers: { "accept": "application/json" } }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }
function postApi(p) { return fetch(withToken(BASE + "/api" + p), { method: "POST" }).then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); }); }
function $(id) { return document.getElementById(id); }
function esc(s) { if (s == null) return ""; return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function fmtMs(ms) { if (ms == null) return "—"; return ms.toFixed(2) + " ms"; }
function durClass(ms) { if (ms < 100) return "dur-ok"; if (ms < 500) return "dur-warn"; return "dur-slow"; }
function kindColor(k) { return { request: "var(--lifecycle)", lifecycle: "var(--lifecycle)", db: "var(--db)", cache: "var(--cache)", http: "var(--http)", render: "var(--render)", auth: "var(--auth)", custom: "var(--custom)", error: "var(--error)" }[k] || "var(--custom)"; }
function toast(msg) { var t = $("toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast._t); toast._t = setTimeout(function () { t.style.display = "none"; }, 2600); }

/* ── navigation ─────────────────────────────────────────────── */
function setView(name) {
  state.view = name;
  var navs = document.querySelectorAll("nav button");
  for (var i = 0; i < navs.length; i++) navs[i].className = navs[i].getAttribute("data-view") === name ? "active" : "";
  state.detailId = null;
  render();
  scheduleRefresh();
}
document.addEventListener("click", function (e) {
  var nav = e.target.closest ? e.target.closest("nav button") : null;
  if (nav) { setView(nav.getAttribute("data-view")); return; }
  var row = e.target.closest ? e.target.closest("tr[data-id]") : null;
  if (row) { state.detailId = row.getAttribute("data-id"); state.view = "detail"; render(); scheduleRefresh(); return; }
  var replay = e.target.closest ? e.target.closest("button[data-replay]") : null;
  if (replay) { doReplay(replay.getAttribute("data-replay")); return; }
  var back = e.target.closest ? e.target.closest("button[data-back]") : null;
  if (back) { state.detailId = null; state.view = state.errorOnly ? "errors" : "requests"; render(); scheduleRefresh(); return; }
});
function scheduleRefresh() {
  if (state.timer) clearInterval(state.timer);
  if (state.paused) return;
  state.timer = setInterval(function () {
    if (state.view === "requests" || state.view === "errors") render();
    else if (state.view === "system") render();
  }, REFRESH_MS);
}

/* ── markdown (tiny renderer) ───────────────────────────────── */
function md(src) {
  var lines = (src || "").split("\\n");
  var out = [], i, line;
  var inTable = false;
  for (i = 0; i < lines.length; i++) {
    line = lines[i];
    if (/^\\|/.test(line)) {
      if (!inTable) { out.push("<table>"); inTable = true; }
      var cells = line.replace(/^\\|/, "").replace(/\\|$/, "").split("|").map(function (c) { return mdInline(c); });
      if (/^[-: ]+$/.test(cells.join("").replace(/<[^>]*>/g, ""))) continue;
      out.push("<tr>" + cells.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>");
      continue;
    }
    if (inTable) { out.push("</table>"); inTable = false; }
    if (/^### /.test(line)) out.push("<h3>" + mdInline(line.slice(4)) + "</h3>");
    else if (/^## /.test(line)) out.push("<h2>" + mdInline(line.slice(3)) + "</h2>");
    else if (/^# /.test(line)) out.push("<h1>" + mdInline(line.slice(2)) + "</h1>");
    else if (/^> /.test(line)) out.push("<blockquote>" + mdInline(line.slice(2)) + "</blockquote>");
    else if (/^- /.test(line)) out.push("<li>" + mdInline(line.slice(2)) + "</li>");
    else if (line.trim() === "") out.push("<p></p>");
    else out.push("<p>" + mdInline(line) + "</p>");
  }
  if (inTable) out.push("</table>");
  return out.join("");
}
function mdInline(s) {
  return esc(s).replace(/\\*\\*(.+?)\\*\\*/g, "<b>$1</b>").replace(/\`(.+?)\`/g, "<code>$1</code>");
}

/* ── requests list ──────────────────────────────────────────── */
function renderList(errorOnly) {
  state.errorOnly = errorOnly;
  var q = state.search.trim().toLowerCase();
  var qs = "?limit=200" + (errorOnly ? "&error=1" : "");
  api("/requests" + qs).then(function (rows) {
    var v = $("view");
    var filtered = rows.filter(function (r) {
      if (!q) return true;
      return (r.method + " " + r.path + " " + (r.error || "")).toLowerCase().indexOf(q) !== -1;
    });
    var html = [];
    html.push('<div class="panel"><div class="flex"><h2 class="grow">' + (errorOnly ? "Errors" : "Requests") + " (" + rows.length + ")</h2>");
    html.push('<input id="search" placeholder="filter method / path / error…" value="' + esc(state.search) + '" />');
    html.push('<button class="ghost" id="pause">' + (state.paused ? "resume auto-refresh" : "pause auto-refresh") + "</button>");
    html.push('<button class="ghost" id="clear">clear</button></div></div>');
    html.push('<div class="panel"><table><thead><tr><th>When</th><th>Method</th><th>Path</th><th>Route</th><th>Status</th><th>Duration</th><th>DB</th><th>Spans</th><th>Error</th></tr></thead><tbody>');
    if (filtered.length === 0) html.push('<tr><td colspan="9"><div class="empty">No requests captured yet — hit your API, then come back. Requests are kept in memory (ring buffer).</div></td></tr>');
    for (var i = 0; i < filtered.length; i++) {
      var r = filtered[i];
      var when = new Date(r.ts).toLocaleTimeString();
      html.push("<tr data-id=\\"" + esc(r.id) + '">');
      html.push("<td class=\\"muted\\">" + esc(when) + "</td>");
      html.push("<td>" + esc(r.method) + "</td>");
      html.push("<td>" + esc(r.path) + "</td>");
      html.push("<td class=\\"muted\\">" + esc(r.route || "—") + "</td>");
      html.push("<td>" + (r.status >= 500 ? '<span class="badge err">' : r.status >= 400 ? '<span class="badge warn">' : '<span class="badge ok">') + r.status + "</span></td>");
      html.push('<td class="' + durClass(r.durationMs) + '">' + fmtMs(r.durationMs) + "</td>");
      html.push('<td class="muted">' + (r.dbCount > 0 ? fmtMs(r.dbTimeMs) + " · " + r.dbCount + "q" : "—") + "</td>");
      html.push('<td class="muted">' + r.spanCount + "</td>");
      html.push('<td class="muted">' + (r.error ? '<span class="badge err">' + esc(r.error) + "</span>" : "—") + "</td>");
      html.push("</tr>");
    }
    html.push("</tbody></table></div>");
    v.innerHTML = html.join("");
    var search = $("search");
    if (search) search.addEventListener("input", function () { state.search = search.value; renderList(errorOnly); });
    var pause = $("pause");
    if (pause) pause.addEventListener("click", function () { state.paused = !state.paused; scheduleRefresh(); renderList(errorOnly); });
    var clear = $("clear");
    if (clear) clear.addEventListener("click", function () { api("/requests/clear").then(function () { renderList(errorOnly); }); });
  }).catch(function (e) { $("view").innerHTML = '<div class="panel"><div class="empty">Failed to load: ' + esc(e.message) + "</div></div>"; });
}

/* ── request detail + waterfall ─────────────────────────────── */
function renderDetail(id) {
  api("/requests/" + encodeURIComponent(id)).then(function (t) {
    var v = $("view");
    var html = [];
    html.push('<div class="panel"><div class="flex">');
    html.push('<button class="ghost" data-back>← back</button>');
    html.push("<h2 class=\\"grow\\">" + esc(t.method + " " + t.path) + "</h2>");
    html.push('<span class="badge ' + (t.status >= 500 ? "err" : t.status >= 400 ? "warn" : "ok") + '">' + t.status + "</span>");
    html.push('<button class="primary" data-replay="' + esc(t.id) + '">↻ Replay request</button>');
    html.push("</div></div>");
    html.push('<div class="stats">');
    html.push('<div class="stat"><div class="v ' + durClass(t.durationMs) + '">' + fmtMs(t.durationMs) + "</div><div class=\\"k\\">total</div></div>");
    html.push('<div class="stat"><div class="v">' + t.dbCount + '</div><div class="k">db queries · ' + fmtMs(t.dbTimeMs) + "</div></div>");
    html.push('<div class="stat"><div class="v">' + t.spans.length + "</div><div class=\\"k\\">spans</div></div>");
    html.push('<div class="stat"><div class="v">' + t.ip + "</div><div class=\\"k\\">client ip</div></div>");
    html.push("</div>");

    // waterfall
    var total = Math.max(t.durationMs, 1);
    var kinds = ["db", "cache", "http", "render", "auth", "lifecycle", "custom", "error"];
    var legend = '<div class="wf-legend">';
    for (var li = 0; li < kinds.length; li++) legend += '<span><i class="dot" style="background:' + kindColor(kinds[li]) + '"></i>' + kinds[li] + "</span>";
    legend += "</div>";
    html.push('<div class="panel"><h2>Waterfall</h2>' + legend + '<div class="wf">');
    var rows = t.spans.slice().sort(function (a, b) { return a.startMs - b.startMs; });
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i];
      var left = (s.startMs / total) * 100;
      var width = Math.max((s.durationMs / total) * 100, 0.35);
      var label = (s.open ? "⏳ " : s.error ? "✕ " : "") + esc(s.name);
      var hint = s.kind + " · start " + s.startMs.toFixed(1) + "ms · dur " + s.durationMs.toFixed(2) + "ms" + (s.error ? " · " + esc(s.error) : "");
      html.push('<div class="wf-row" title="' + hint + '"><div class="wf-label">' + label + "</div><div class=\\"wf-track\\"><div class=\\"wf-bar\\" style=\\"left:" + left.toFixed(2) + "%;width:" + width.toFixed(2) + "%;background:" + kindColor(s.kind) + '"></div></div></div>');
    }
    html.push("</div>");
    if (t.stages && t.stages.length) html.push('<div style="margin-top:8px">' + t.stages.map(function (s) { return '<span class="chip">' + esc(s) + "</span>"; }).join("") + "</div>");
    html.push("</div>");

    // span tree
    html.push('<div class="panel"><h2>Span tree (call graph)</h2><div class="tree">');
    var byParent = {};
    for (var j = 0; j < t.spans.length; j++) { var sp = t.spans[j]; (byParent[sp.parentId] = byParent[sp.parentId] || []).push(sp); }
    (function walk(pid, depth) {
      var kids = byParent[pid] || [];
      for (var k = 0; k < kids.length; k++) {
        var kid = kids[k];
        var cls = pid === 0 && depth === 0 ? "node root" : "node";
        html.push('<div class="' + cls + '"><span class="' + durClass(kid.durationMs) + '">' + fmtMs(kid.durationMs) + "</span> · <b>" + esc(kid.name) + '</b> <span class="chip">' + kid.kind + "</span>" + (kid.error ? ' <span class="badge err">' + esc(kid.error) + "</span>" : "") + "</div>");
        walk(kid.id, depth + 1);
      }
    })(0, 0);
    html.push("</div></div>");

    // queries
    var queries = t.spans.filter(function (s) { return s.kind === "db"; });
    if (queries.length) {
      html.push('<div class="panel"><h2>Database</h2><table><thead><tr><th>#</th><th>Duration</th><th>Query</th><th>Params</th><th>Origin</th></tr></thead><tbody>');
      for (var q = 0; q < queries.length; q++) {
        var qs2 = queries[q];
        html.push("<tr><td>" + (q + 1) + '</td><td class="' + durClass(qs2.durationMs) + '">' + fmtMs(qs2.durationMs) + "</td><td>" + esc(qs2.name) + "</td><td class=\\"muted\\">" + esc(qs2.attrs && qs2.attrs.params ? JSON.stringify(qs2.attrs.params) : "") + '</td><td class="muted">' + esc(qs2.origin || "") + "</td></tr>");
      }
      html.push("</tbody></table></div>");
    }

    // request / response
    html.push('<div class="panel"><h2>Request</h2><div class="kvs">');
    html.push("<div><span class=\\"k\\">requestId</span><span class=\\"v\\">" + esc(t.requestId) + "</span></div>");
    html.push("<div><span class=\\"k\\">url</span><span class=\\"v\\">" + esc(t.request.url) + "</span></div>");
    html.push("<div><span class=\\"k\\">route</span><span class=\\"v\\">" + esc(t.route || "—") + "</span></div>");
    for (var hk in t.request.headers) html.push("<div><span class=\\"k\\">" + esc(hk) + "</span><span class=\\"v\\">" + esc(t.request.headers[hk]) + "</span></div>");
    if (t.request.body != null) html.push("<div><span class=\\"k\\">body</span><span class=\\"v\\">" + esc(String(t.request.body).slice(0, 2000)) + "</span></div>");
    html.push("</div></div>");
    if (t.responseHeaders) {
      html.push('<div class="panel"><h2>Response</h2><div class="kvs">');
      for (var rh in t.responseHeaders) html.push("<div><span class=\\"k\\">" + esc(rh) + "</span><span class=\\"v\\">" + esc(t.responseHeaders[rh]) + "</span></div>");
      html.push("</div></div>");
    }
    if (t.error) {
      html.push('<div class="panel"><h2>Error</h2><pre class="stack">' + esc(t.error) + (t.errorStack ? "\\n\\n" + esc(t.errorStack) : "") + "</pre></div>");
    }
    html.push('<div class="panel" id="replay-out"><h2>Replay</h2><div class="empty">Press “↻ Replay request” to re-issue this exact request through the server and see the result.</div></div>');
    v.innerHTML = html.join("");
  }).catch(function (e) { $("view").innerHTML = '<div class="panel"><div class="empty">' + esc(e.message) + "</div></div>"; });
}

function doReplay(id) {
  var out = $("replay-out");
  if (out) out.innerHTML = "<h2>Replay</h2><div class=\\"muted\\">Replaying…</div>";
  postApi("/requests/" + encodeURIComponent(id) + "/replay").then(function (res) {
    if (!out) return;
    var html = ["<h2>Replay</h2>"];
    if (res.error) { html.push('<pre class="replay">Error: ' + esc(res.error) + "</pre>"); }
    else {
      html.push('<div class="stats">');
      html.push('<div class="stat"><div class="v">' + res.status + "</div><div class=\\"k\\">status</div></div>");
      html.push('<div class="stat"><div class="v ' + durClass(res.durationMs) + '">' + fmtMs(res.durationMs) + "</div><div class=\\"k\\">duration</div></div>");
      html.push('<div class="stat"><div class="v">' + res.requestId + "</div><div class=\\"k\\">requestId</div></div>");
      html.push("</div>");
      html.push('<pre class="replay">' + esc(res.body) + "</pre>");
    }
    out.innerHTML = html.join("");
  }).catch(function (e) { if (out) out.innerHTML = "<h2>Replay</h2><pre class=\\"replay\\">" + esc(e.message) + "</pre>"; });
}

/* ── system ─────────────────────────────────────────────────── */
function spark(id, samples, key, color, fmt) {
  var canvas = document.getElementById(id);
  if (!canvas || !samples.length) return;
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  var ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  var vals = samples.map(function (s) { return s[key]; });
  var max = Math.max.apply(null, vals.concat([1]));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
  for (var i = 0; i < vals.length; i++) {
    var x = (i / Math.max(vals.length - 1, 1)) * (w - 2) + 1;
    var y = h - 2 - (vals[i] / max) * (h - 4);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  var label = document.getElementById(id + "-label");
  if (label) label.textContent = fmt(vals[vals.length - 1]);
}
function renderSystem() {
  api("/system").then(function (stats) {
    var v = $("view");
    var html = [];
    html.push('<div class="stats">');
    html.push('<div class="stat"><div class="v">' + stats.totals.requests + "</div><div class=\\"k\\">requests traced</div></div>");
    html.push('<div class="stat"><div class="v">' + stats.totals.errors + "</div><div class=\\"k\\">errors</div></div>");
    html.push('<div class="stat"><div class="v">' + stats.totals.avgDurationMs.toFixed(1) + "</div><div class=\\"k\\">avg duration ms</div></div>");
    html.push('<div class="stat"><div class="v">' + stats.totals.p95DurationMs.toFixed(1) + "</div><div class=\\"k\\">p95 duration ms</div></div>");
    html.push('<div class="stat"><div class="v">' + stats.uptimeSec + "</div><div class=\\"k\\">uptime s</div></div>");
    html.push("</div>");
    var charts = [
      ["cpu", "cpuPct", "var(--red)", function (x) { return x + " % cpu"; }],
      ["rss", "rssMiB", "var(--green)", function (x) { return x + " MiB rss"; }],
      ["heap", "heapMiB", "var(--amber)", function (x) { return x + " MiB heap"; }],
      ["el", "eventLoopDelayMs", "var(--purple)", function (x) { return x + " ms event loop"; }]
    ];
    for (var i = 0; i < charts.length; i++) {
      var c = charts[i];
      html.push('<div class="panel"><h2><span id="' + c[0] + '-label">…</span> <span class="muted" style="text-transform:none">' + c[0] + "</span></h2><canvas id=\\"" + c[0] + '" height="120"></canvas></div>');
    }
    html.push('<div class="panel"><div class="muted">Sampled every ' + stats.sampleMs + ' ms' + (stats.sampling ? "" : " (sampling disabled)") + ". CPU is process-wide (can exceed 100% on multicore). Event-loop delay is measured with a staggered timer.</div></div>");
    v.innerHTML = html.join("");
    spark("cpu", stats.samples, "cpuPct", "var(--red)", function (x) { return x + " %"; });
    spark("rss", stats.samples, "rssMiB", "var(--green)", function (x) { return x + " MiB"; });
    spark("heap", stats.samples, "heapMiB", "var(--amber)", function (x) { return x + " MiB"; });
    spark("el", stats.samples, "eventLoopDelayMs", "var(--purple)", function (x) { return x + " ms"; });
  }).catch(function (e) { $("view").innerHTML = '<div class="panel"><div class="empty">' + esc(e.message) + "</div></div>"; });
}

/* ── KT ─────────────────────────────────────────────────────── */
function renderKt() {
  api("/kt").then(function (res) {
    $("view").innerHTML = '<div class="panel markdown">' + md(res.markdown) + "</div>";
  }).catch(function (e) { $("view").innerHTML = '<div class="panel"><div class="empty">' + esc(e.message) + "</div></div>"; });
}

function render() {
  if (state.view === "requests") renderList(false);
  else if (state.view === "errors") renderList(true);
  else if (state.view === "detail") renderDetail(state.detailId);
  else if (state.view === "system") renderSystem();
  else if (state.view === "kt") renderKt();
}

/* boot */
api("/meta").then(function (m) {
  $("env").textContent = m.serviceName + "@" + m.version + " · " + m.environment;
  document.title = m.serviceName + " · Debugbar";
}).catch(function () {});
render();
scheduleRefresh();
`;
