/**
 * @fileoverview Debugbar dashboard app — served at `{path}/app.js`.
 *
 * A dependency-free vanilla JS SPA: it renders the Requests / Errors / Jobs /
 * Routes / System / KT views from the `{path}/api/*` endpoints, with live
 * auto-refresh (pausable), client-side filtering, keyboard shortcuts, a
 * light/dark theme toggle and copy-to-clipboard helpers. The literal below
 * deliberately avoids backticks and `${` (string concat only) so it needs no
 * escaping in the TS template literal; every backslash the served JS needs is
 * written `\\` in this source.
 */

export const DEBUGBAR_DASHBOARD_JS = `
"use strict";
var BASE = document.currentScript ? document.currentScript.getAttribute("data-base") || "." : ".";
var TOKEN = (window.location.search.match(/[?&]token=([^&]+)/) || [])[1] || "";
var REFRESH_MS = 5000;
var THEME_KEY = "ignex-debugbar-theme";
var state = {
  view: "requests", errorOnly: false, paused: false, search: "",
  method: "", status: "", timer: null, detailId: null, detailTab: "overview"
};

/* ── tiny helpers ─────────────────────────────────────────── */
function $(id) { return document.getElementById(id); }
function esc(s) { if (s == null) return ""; return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function fmtMs(ms) { if (ms == null) return "—"; return ms.toFixed(2) + " ms"; }
function fmtNum(n) { if (n == null) return "—"; return String(n); }
function durClass(ms) { if (ms < 100) return "dur-ok"; if (ms < 500) return "dur-warn"; return "dur-slow"; }
function timeAgo(ts) {
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return new Date(ts).toLocaleDateString();
}
function timeHM(ts) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function methodCls(m) { return (m || "").toLowerCase(); }
function statusCls(s) { if (s >= 500) return "err"; if (s >= 400) return "warn"; if (s >= 300) return "info"; return "ok"; }
function kindVar(k) {
  return { request: "var(--k-lifecycle)", lifecycle: "var(--k-lifecycle)", db: "var(--k-db)", cache: "var(--k-cache)", http: "var(--k-http)", render: "var(--k-render)", auth: "var(--k-auth)", custom: "var(--k-custom)", error: "var(--k-error)" }[k] || "var(--k-custom)";
}
function methodPill(m) { return '<span class="pill method ' + methodCls(m) + '">' + esc(m) + "</span>"; }
function statusPill(s) { return '<span class="pill status ' + statusCls(s) + '">' + esc(s) + "</span>"; }
function toast(msg) {
  var t = $("toast");
  t.textContent = msg;
  t.className = "toast show";
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.className = "toast"; }, 2600);
}
function copyText(text) {
  var done = function () { toast("copied to clipboard"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
  } else { fallbackCopy(text, done); }
}
function fallbackCopy(text, done) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { toast("copy failed"); }
  document.body.removeChild(ta);
}
function statCard(v, k, sub, extraCls) {
  return '<div class="stat ' + (extraCls || "") + '"><div class="v">' + v + '</div><div class="k">' + k + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>";
}
function panel(title, body, headExtra) {
  return '<div class="panel"><div class="panel-head"><h2>' + title + "</h2>" + (headExtra || "") + "</div>" + body + "</div>";
}

/* ── api ──────────────────────────────────────────────────── */
function withToken(p) { return p + (p.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(TOKEN); }
function api(p) { return fetch(withToken(BASE + "/api" + p), { headers: { "accept": "application/json" } }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }
function postApi(p) { return fetch(withToken(BASE + "/api" + p), { method: "POST" }).then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); }); }
function apiError(e) { $("view").innerHTML = '<div class="panel"><div class="empty"><div class="big">⚠</div>' + esc(e.message) + '<div class="hint">Is the debugbar enabled and the server running?</div></div></div>'; }

/* ── theme ────────────────────────────────────────────────── */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
}
function toggleTheme() {
  var current = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(current);
}

/* ── navigation ───────────────────────────────────────────── */
function setView(name) {
  state.view = name;
  state.errorOnly = name === "errors";
  state.detailId = null;
  var navs = document.querySelectorAll("nav button");
  for (var i = 0; i < navs.length; i++) navs[i].className = navs[i].getAttribute("data-view") === name ? "active" : "";
  render();
  scheduleRefresh();
}
document.addEventListener("click", function (e) {
  var el = e.target;
  var nav = el.closest ? el.closest("nav button") : null;
  if (nav) { setView(nav.getAttribute("data-view")); return; }
  var tab = el.closest ? el.closest(".tabs button") : null;
  if (tab) { state.detailTab = tab.getAttribute("data-tab"); render(); return; }
  var row = el.closest ? el.closest("tr[data-id]") : null;
  if (row) { state.detailId = row.getAttribute("data-id"); state.detailTab = "overview"; state.view = "detail"; render(); scheduleRefresh(); return; }
  var copy = el.closest ? el.closest("button[data-copy]") : null;
  if (copy) { copyText(copy.getAttribute("data-copy")); return; }
  var replay = el.closest ? el.closest("button[data-replay]") : null;
  if (replay) { doReplay(replay.getAttribute("data-replay")); return; }
  var back = el.closest ? el.closest("button[data-back]") : null;
  if (back) { state.detailId = null; state.view = state.errorOnly ? "errors" : "requests"; render(); scheduleRefresh(); return; }
  var refresh = el.closest ? el.closest("button[data-refresh]") : null;
  if (refresh) { render(); return; }
});
document.addEventListener("keydown", function (e) {
  var tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    if (e.key === "Escape") { e.target.blur(); render(); }
    return;
  }
  if (e.key === "/") { e.preventDefault(); var s = $("search"); if (s) s.focus(); return; }
  if (e.key === "r" || e.key === "R") { render(); return; }
  if (e.key === "t" || e.key === "T") { toggleTheme(); return; }
  var views = ["requests", "errors", "jobs", "routes", "system", "kt"];
  var idx = views.indexOf(e.key);
  if (idx >= 0) setView(views[idx]);
});
function scheduleRefresh() {
  if (state.timer) clearInterval(state.timer);
  if (state.paused) return;
  state.timer = setInterval(function () {
    if (state.view === "requests" || state.view === "errors" || state.view === "system") render();
  }, REFRESH_MS);
}

/* ── requests list ────────────────────────────────────────── */
function renderList(errorOnly) {
  state.errorOnly = errorOnly;
  var qs = "?limit=200" + (errorOnly ? "&error=1" : "");
  if (state.search) qs += "&q=" + encodeURIComponent(state.search);
  if (state.method) qs += "&method=" + encodeURIComponent(state.method);
  if (state.status) qs += "&status=" + encodeURIComponent(state.status);
  api("/requests" + qs).then(function (rows) {
    var v = $("view");
    var html = [];
    var n4xx = 0, n5xx = 0, errs = 0, totalMs = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.status >= 500) n5xx++; else if (r.status >= 400) n4xx++;
      if (r.error) errs++;
      totalMs += r.durationMs;
    }
    var avg = rows.length ? (totalMs / rows.length).toFixed(1) : "0";
    var title = errorOnly ? "Errors" : "Requests";
    html.push('<div class="stats">');
    html.push(statCard(fmtNum(rows.length), title + " (window)", "last 200"));
    html.push(statCard(fmtNum(errs), "Errors", null, errs ? "err" : ""));
    html.push(statCard(fmtNum(n4xx), "4xx", null, n4xx ? "warn" : ""));
    html.push(statCard(fmtNum(n5xx), "5xx", null, n5xx ? "err" : ""));
    html.push(statCard(avg, "avg ms", "this window"));
    html.push("</div>");
    html.push('<div class="panel"><div class="toolbar">');
    html.push('<input class="search" id="search" type="text" placeholder="filter method / path / error…" value="' + esc(state.search) + '" />');
    html.push('<select id="method-filter"><option value="">all methods</option><option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option><option value="HEAD">HEAD</option><option value="OPTIONS">OPTIONS</option></select>');
    html.push('<select id="status-filter"><option value="">all statuses</option><option value="2xx">2xx</option><option value="3xx">3xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option></select>');
    html.push('<span class="grow"></span>');
    html.push('<button class="ghost mini" id="pause">' + (state.paused ? "▶ resume" : "⏸ pause") + "</button>");
    html.push('<button class="ghost mini" data-refresh>↻ refresh</button>');
    html.push('<button class="ghost mini" id="clear">✕ clear</button>');
    html.push("</div></div>");
    html.push('<div class="panel"><table><thead><tr><th>When</th><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>DB</th><th>Spans</th><th>Error</th></tr></thead><tbody>');
    if (rows.length === 0) {
      html.push('<tr><td colspan="8"><div class="empty"><div class="big">🗒</div>No ' + (errorOnly ? "errors" : "requests") + ' captured yet.<div class="hint">Hit your API, then come back. Traces are kept in memory (ring buffer).</div></div></td></tr>');
    }
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var pct = Math.min((row.durationMs / Math.max(500, row.durationMs)) * 100, 100);
      html.push('<tr data-id="' + esc(row.id) + '">');
      html.push('<td class="muted" title="' + esc(timeHM(row.ts)) + '">' + esc(timeAgo(row.ts)) + "</td>");
      html.push("<td>" + methodPill(row.method) + "</td>");
      html.push('<td class="mono">' + esc(row.path) + "</td>");
      html.push("<td>" + statusPill(row.status) + "</td>");
      html.push('<td><div class="bar-row"><span class="mono ' + durClass(row.durationMs) + '">' + fmtMs(row.durationMs) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct.toFixed(1) + '%;' + (row.status >= 500 ? "background:var(--err)" : row.status >= 400 ? "background:var(--warn)" : "") + '"></span></span></div></td>');
      html.push('<td class="mono muted">' + (row.dbCount > 0 ? fmtMs(row.dbTimeMs) + " · " + row.dbCount + "q" : "—") + "</td>");
      html.push('<td class="mono muted">' + row.spanCount + "</td>");
      html.push('<td class="muted">' + (row.error ? '<span class="pill status err">' + esc(row.error) + "</span>" : "—") + "</td>");
      html.push("</tr>");
    }
    html.push("</tbody></table></div>");
    v.innerHTML = html.join("");
    var search = $("search");
    if (search) search.addEventListener("input", function () { state.search = search.value; debounceRender(); });
    var mf = $("method-filter");
    if (mf) { mf.value = state.method; mf.addEventListener("change", function () { state.method = mf.value; renderList(errorOnly); }); }
    var sf = $("status-filter");
    if (sf) { sf.value = state.status; sf.addEventListener("change", function () { state.status = sf.value; renderList(errorOnly); }); }
    var pause = $("pause");
    if (pause) pause.addEventListener("click", function () { state.paused = !state.paused; $("live").className = "live-dot" + (state.paused ? " paused" : ""); scheduleRefresh(); renderList(errorOnly); });
    var clear = $("clear");
    if (clear) clear.addEventListener("click", function () { api("/requests/clear").then(function () { toast("store cleared"); renderList(errorOnly); }); });
  }).catch(apiError);
}
var debounceTimer = null;
function debounceRender() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(function () { render(); }, 250);
}

/* ── request detail ───────────────────────────────────────── */
function renderDetail(id) {
  api("/requests/" + encodeURIComponent(id)).then(function (t) {
    var v = $("view");
    var html = [];
    var curl = "curl -i -X " + t.method + " '" + t.request.url + "'";
    html.push('<div class="summary">');
    html.push('<button class="ghost mini" data-back>← back</button>');
    html.push(methodPill(t.method));
    html.push('<span class="route-path">' + esc(t.path) + "</span>");
    html.push(statusPill(t.status));
    html.push('<span class="meta">' + esc(t.requestId) + " · " + esc(t.ip) + " · " + esc(timeHM(t.ts)) + "</span>");
    html.push('<span class="spacer"></span>');
    html.push('<button class="ghost mini" data-copy="' + esc(curl) + '">⧉ copy curl</button>');
    html.push('<button class="primary mini" data-replay="' + esc(t.id) + '">↻ replay</button>');
    html.push("</div>");
    html.push('<div class="tabs">');
    var tabs = [["overview", "Overview"], ["waterfall", "Waterfall"], ["queries", "Queries"], ["headers", "Headers"], ["body", "Body"], ["error", "Error"], ["replay", "Replay"]];
    for (var ti = 0; ti < tabs.length; ti++) {
      var tdef = tabs[ti];
      var showTab = tdef[0] !== "error" || !!t.error;
      if (!showTab) continue;
      html.push('<button data-tab="' + tdef[0] + '" class="' + (state.detailTab === tdef[0] ? "active" : "") + '">' + tdef[1] + "</button>");
    }
    html.push("</div>");
    var total = Math.max(t.durationMs, 1);

    if (state.detailTab === "overview" || state.detailTab === "error") {
      html.push('<div class="stats">');
      html.push('<div class="stat accent"><div class="v ' + durClass(t.durationMs) + '">' + fmtMs(t.durationMs) + "</div><div class=\\"k\\">total</div></div>");
      html.push('<div class="stat"><div class="v">' + t.dbCount + '</div><div class="k">db queries</div><div class="sub">' + fmtMs(t.dbTimeMs) + "</div></div>");
      html.push('<div class="stat"><div class="v">' + t.spans.length + "</div><div class=\\"k\\">spans</div></div>");
      html.push('<div class="stat"><div class="v">' + esc(t.route || "—") + "</div><div class=\\"k\\">route</div></div>");
      html.push("</div>");
      if (state.detailTab === "error" && t.error) {
        html.push(panel("Error", '<pre class="stack">' + esc(t.error) + (t.errorStack ? "\\n\\n" + esc(t.errorStack) : "") + "</pre>", '<button class="ghost mini" data-copy="' + esc(t.error + (t.errorStack ? "\\n\\n" + t.errorStack : "")) + '">copy</button>'));
      }
      if (t.stages && t.stages.length) html.push(panel("Lifecycle stages", '<div>' + t.stages.map(function (s) { return '<span class="chip">' + esc(s) + "</span>"; }).join("") + "</div>"));
      html.push(renderSpanTree(t));
      html.push(renderKvs("Request", requestKvs(t), t.request.headers));
    } else if (state.detailTab === "waterfall") {
      html.push(renderWaterfall(t, total));
    } else if (state.detailTab === "queries") {
      html.push(renderQueries(t));
    } else if (state.detailTab === "headers") {
      html.push(renderKvs("Request headers", requestKvs(t), t.request.headers));
      html.push(renderKvs("Response headers", [], t.responseHeaders || {}));
    } else if (state.detailTab === "body") {
      html.push('<div class="panel"><div class="panel-head"><h2>Request body</h2><button class="ghost mini" data-copy="' + esc(t.request.body || "") + '">copy</button></div><pre class="body">' + esc(prettyJson(t.request.body)) + "</pre></div>");
    } else if (state.detailTab === "replay") {
      html.push('<div class="panel" id="replay-out"><div class="panel-head"><h2>Replay</h2></div><div class="empty">Press “↻ replay” above to re-issue this exact request through the server.</div></div>');
    }
    v.innerHTML = html.join("");
  }).catch(apiError);
}
function requestKvs(t) {
  return [["requestId", t.requestId], ["url", t.request.url], ["route", t.route || "—"], ["client ip", t.ip], ["started", timeHM(t.ts)], ["duration", fmtMs(t.durationMs)]];
}
function renderKvs(title, pairs, headers) {
  var html = '<div class="panel"><div class="panel-head"><h2>' + title + "</h2></div><div class=\\"kvs\\">";
  for (var i = 0; i < pairs.length; i++) html += "<div><span class=\\"k\\">" + esc(pairs[i][0]) + "</span><span class=\\"v\\">" + esc(pairs[i][1]) + "</span></div>";
  for (var hk in headers) html += "<div><span class=\\"k\\">" + esc(hk) + "</span><span class=\\"v\\">" + esc(headers[hk]) + "</span></div>";
  return html + "</div></div>";
}
function renderSpanTree(t) {
  var html = '<div class="panel"><div class="panel-head"><h2>Span tree</h2></div><div class="tree">';
  var byParent = {};
  for (var j = 0; j < t.spans.length; j++) { var sp = t.spans[j]; (byParent[sp.parentId] = byParent[sp.parentId] || []).push(sp); }
  (function walk(pid, depth) {
    var kids = byParent[pid] || [];
    for (var k = 0; k < kids.length; k++) {
      var kid = kids[k];
      var cls = pid === 0 && depth === 0 ? "node root" : "node";
      html += '<div class="' + cls + '"><span class="' + durClass(kid.durationMs) + '">' + fmtMs(kid.durationMs) + "</span> · <b>" + esc(kid.name) + '</b> <span class="pill kind" style="--kc:' + kindVar(kid.kind) + '">' + kid.kind + "</span>" + (kid.error ? ' <span class="pill status err">' + esc(kid.error) + "</span>" : "") + "</div>";
      walk(kid.id, depth + 1);
    }
  })(0, 0);
  return html + "</div></div>";
}
function renderWaterfall(t, total) {
  var html = '<div class="panel"><div class="panel-head"><h2>Waterfall</h2></div>';
  var kinds = ["db", "cache", "http", "render", "auth", "lifecycle", "custom", "error"];
  html += '<div class="wf-legend">';
  for (var li = 0; li < kinds.length; li++) html += '<span><i class="dot" style="background:' + kindVar(kinds[li]) + '"></i>' + kinds[li] + "</span>";
  html += "</div>";
  html += '<div class="wf-ruler"><span>0 ms</span><span>' + Math.round(total / 2) + " ms</span><span>" + Math.round(total) + " ms</span></div><div class=\\"wf\\">";
  var rows = t.spans.slice().sort(function (a, b) { return a.startMs - b.startMs; });
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i];
    var left = (s.startMs / total) * 100;
    var width = Math.max((s.durationMs / total) * 100, 0.35);
    var label = (s.open ? "⏳ " : s.error ? "✕ " : "") + esc(s.name);
    var hint = s.kind + " · start " + s.startMs.toFixed(1) + "ms · dur " + s.durationMs.toFixed(2) + "ms" + (s.error ? " · " + esc(s.error) : "");
    html += '<div class="wf-row" title="' + hint + '"><div class="wf-label">' + label + '</div><div class="wf-track"><div class="wf-bar" style="left:' + left.toFixed(2) + "%;width:" + width.toFixed(2) + "%;background:" + kindVar(s.kind) + '"></div></div></div>';
  }
  return html + "</div></div>";
}
function renderQueries(t) {
  var queries = t.spans.filter(function (s) { return s.kind === "db"; });
  if (queries.length === 0) return '<div class="panel"><div class="empty"><div class="big">🗄</div>No database queries recorded.</div></div>';
  var html = '<div class="panel"><div class="panel-head"><h2>Database (' + queries.length + ")</h2></div><table><thead><tr><th>#</th><th>Duration</th><th>Query</th><th>Params</th><th>Origin</th></tr></thead><tbody>";
  for (var q = 0; q < queries.length; q++) {
    var qs2 = queries[q];
    html += "<tr><td class=\\"num\\">" + (q + 1) + '</td><td class="mono ' + durClass(qs2.durationMs) + '">' + fmtMs(qs2.durationMs) + "</td><td class=\\"mono\\">" + esc(qs2.name) + "</td><td class=\\"muted\\">" + esc(qs2.attrs && qs2.attrs.params ? JSON.stringify(qs2.attrs.params) : "") + '</td><td class="muted">' + esc(qs2.origin || "") + "</td></tr>";
  }
  return html + "</tbody></table></div>";
}
function prettyJson(body) {
  if (!body) return "(empty body)";
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch (e) { return body; }
}
function doReplay(id) {
  var out = $("replay-out");
  if (!out) out = $("view").querySelector("#replay-out");
  if (out) out.innerHTML = '<div class="panel-head"><h2>Replay</h2></div><div class="skeleton" style="height:60px"></div>';
  postApi("/requests/" + encodeURIComponent(id) + "/replay").then(function (res) {
    if (!out) return;
    var html = ['<div class="panel-head"><h2>Replay</h2></div>'];
    if (res.error) { html.push('<pre class="replay">Error: ' + esc(res.error) + "</pre>"); }
    else {
      html.push('<div class="stats">');
      html.push('<div class="stat"><div class="v">' + res.status + "</div><div class=\\"k\\">status</div></div>");
      html.push('<div class="stat"><div class="v ' + durClass(res.durationMs) + '">' + fmtMs(res.durationMs) + "</div><div class=\\"k\\">duration</div></div>");
      html.push('<div class="stat"><div class="v mono">' + esc(res.requestId) + "</div><div class=\\"k\\">requestId</div></div>");
      html.push("</div>");
      html.push('<pre class="replay">' + esc(res.body) + "</pre>");
    }
    out.innerHTML = html.join("");
  }).catch(function (e) { if (out) out.innerHTML = '<div class="panel-head"><h2>Replay</h2></div><pre class="replay">' + esc(e.message) + "</pre>"; });
}

/* ── jobs ─────────────────────────────────────────────────── */
function renderJobs() {
  api("/jobs").then(function (res) {
    if (!res.enabled) {
      $("view").innerHTML = '<div class="panel"><div class="empty"><div class="big">⚙</div>No job store wired.<div class="hint">Pass debugbar({ data: { jobs } }) to enable this panel.</div></div></div>';
      return;
    }
    if (res.error) { $("view").innerHTML = '<div class="panel"><div class="empty">' + esc(res.error) + "</div></div>"; return; }
    var html = '<div class="stats">';
    var order = [["queued", ""], ["running", "accent"], ["completed", "ok"], ["failed", "err"]];
    for (var i = 0; i < order.length; i++) {
      var st = order[i];
      html += statCard(fmtNum(res.byStatus[st[0]] || 0), st[0], null, st[1]);
    }
    html += "</div>";
    html += '<div class="panel"><div class="panel-head"><h2>Recent jobs (' + res.total + ")</h2></div><table><thead><tr><th>Name</th><th>Status</th><th>Run at</th></tr></thead><tbody>";
    var rows = res.recent || [];
    if (rows.length === 0) html += '<tr><td colspan="3"><div class="empty">No jobs yet.</div></td></tr>';
    for (var j = 0; j < rows.length; j++) {
      var jr = rows[j];
      html += "<tr><td class=\\"mono\\">" + esc(jr.name) + "</td><td>" + statusPill(jr.status) + "</td><td class=\\"muted\\">" + esc(new Date(jr.runAt).toISOString()) + "</td></tr>";
    }
    html += "</tbody></table></div>";
    $("view").innerHTML = html;
  }).catch(apiError);
}

/* ── routes ───────────────────────────────────────────────── */
function renderRoutes() {
  api("/routes").then(function (res) {
    if (!res.enabled) {
      $("view").innerHTML = '<div class="panel"><div class="empty"><div class="big">🗺</div>No route provider.<div class="hint">The KT page still lists routes from the manifest / router.</div></div></div>';
      return;
    }
    if (res.error) { $("view").innerHTML = '<div class="panel"><div class="empty">' + esc(res.error) + "</div></div>"; return; }
    var rows = res.routes || [];
    var html = '<div class="panel"><div class="toolbar"><input class="search" id="search" type="text" placeholder="filter method / path / file…" /><span class="grow"></span><span class="muted">' + rows.length + " routes</span></div></div>";
    html += '<div class="panel"><table><thead><tr><th>Method</th><th>Path</th><th>File</th><th></th></tr></thead><tbody id="routes-body">';
    html += "</tbody></table></div>";
    $("view").innerHTML = html;
    var renderRows = function (q) {
      var body = $("routes-body");
      if (!body) return;
      var ql = (q || "").toLowerCase();
      var out = "";
      var count = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (ql && (r.method + " " + r.path + " " + (r.file || "")).toLowerCase().indexOf(ql) === -1) continue;
        count++;
        out += "<tr><td>" + methodPill(r.method) + "</td><td class=\\"mono\\">" + esc(r.path) + "</td><td class=\\"muted\\">" + esc(r.file || "") + "</td><td><button class=\\"ghost mini\\" data-copy=\\"" + esc(r.method + " " + r.path) + '">copy</button></td></tr>';
      }
      if (count === 0) out = '<tr><td colspan="4"><div class="empty">No routes match.</div></td></tr>';
      body.innerHTML = out;
    };
    renderRows("");
    var search = $("search");
    if (search) search.addEventListener("input", function () { renderRows(search.value); });
  }).catch(apiError);
}

/* ── system ───────────────────────────────────────────────── */
function drawChart(id, samples, key, color, labelFn) {
  var canvas = document.getElementById(id);
  if (!canvas || !samples || !samples.length) return;
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  var ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  var vals = samples.map(function (s) { return s[key]; });
  var max = Math.max.apply(null, vals.concat([1]));
  var min = Math.min.apply(null, vals.concat([0]));
  var span = Math.max(max - min, 1);
  var px = function (i) { return (i / Math.max(vals.length - 1, 1)) * (w - 4) + 2; };
  var py = function (v) { return h - 4 - ((v - min) / span) * (h - 8); };
  // gradient fill
  var grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(px(0), py(vals[0]));
  for (var i = 1; i < vals.length; i++) ctx.lineTo(px(i), py(vals[i]));
  ctx.lineTo(px(vals.length - 1), h - 2);
  ctx.lineTo(px(0), h - 2);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(px(0), py(vals[0]));
  for (var j = 1; j < vals.length; j++) ctx.lineTo(px(j), py(vals[j]));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  var label = document.getElementById(id + "-label");
  if (label) label.textContent = labelFn(vals[vals.length - 1]);
  var range = document.getElementById(id + "-range");
  if (range) range.textContent = "min " + labelFn(min) + " · max " + labelFn(max);
}
function renderSystem() {
  api("/system").then(function (stats) {
    var v = $("view");
    var html = [];
    var rps = (stats.totals.requests / Math.max(stats.uptimeSec, 1)).toFixed(1);
    html.push('<div class="stats">');
    html.push('<div class="stat accent"><div class="v">' + fmtNum(stats.totals.requests) + "</div><div class=\\"k\\">requests traced</div><div class=\\"sub\\">" + rps + " req/s avg</div></div>");
    html.push('<div class="stat' + (stats.totals.errors ? " err" : "") + '"><div class="v">' + fmtNum(stats.totals.errors) + "</div><div class=\\"k\\">errors</div></div>");
    html.push('<div class="stat"><div class="v">' + stats.totals.avgDurationMs.toFixed(1) + "</div><div class=\\"k\\">avg duration ms</div></div>");
    html.push('<div class="stat"><div class="v">' + stats.totals.p95DurationMs.toFixed(1) + "</div><div class=\\"k\\">p95 duration ms</div></div>");
    html.push('<div class="stat"><div class="v">' + stats.uptimeSec + "</div><div class=\\"k\\">uptime s</div></div>");
    html.push("</div>");
    var charts = [
      ["cpu", "cpuPct", "var(--err)", function (x) { return x + " %"; }],
      ["rss", "rssMiB", "var(--ok)", function (x) { return x + " MiB"; }],
      ["heap", "heapMiB", "var(--warn)", function (x) { return x + " MiB"; }],
      ["el", "eventLoopDelayMs", "var(--accent2)", function (x) { return x + " ms"; }]
    ];
    for (var i = 0; i < charts.length; i++) {
      var c = charts[i];
      html.push('<div class="panel chart-panel"><div class="chart-head"><span class="now" id="' + c[0] + '-label">…</span><span class="lbl">' + c[0] + '</span><span class="grow"></span><span class="range" id="' + c[0] + '-range"></span></div><canvas id="' + c[0] + '" height="110"></canvas></div>');
    }
    html.push('<div class="panel"><div class="muted" style="font-size:11.5px">Sampled every ' + stats.sampleMs + " ms" + (stats.sampling ? "" : " (sampling disabled)") + ". CPU is process-wide (can exceed 100% on multicore). Event-loop delay is measured with a staggered timer.</div></div>");
    v.innerHTML = html.join("");
    drawChart("cpu", stats.samples, "cpuPct", "var(--err)", function (x) { return x + " %"; });
    drawChart("rss", stats.samples, "rssMiB", "var(--ok)", function (x) { return x + " MiB"; });
    drawChart("heap", stats.samples, "heapMiB", "var(--warn)", function (x) { return x + " MiB"; });
    drawChart("el", stats.samples, "eventLoopDelayMs", "var(--accent2)", function (x) { return x + " ms"; });
  }).catch(apiError);
}

/* ── KT ───────────────────────────────────────────────────── */
function renderKt() {
  api("/kt").then(function (res) {
    var body = res.html || md(res.markdown);
    $("view").innerHTML = '<div class="panel markdown">' + body + "</div>";
  }).catch(apiError);
}

/* tiny markdown fallback (used when the API returns raw markdown only) */
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
  return esc(s).replace(/\\*\\*(.+?)\\*\\*/g, "<b>$1</b>").replace(/\\\`(.+?)\\\`/g, "<code>$1</code>");
}

/* ── render dispatch ──────────────────────────────────────── */
function render() {
  if (state.view === "requests") renderList(false);
  else if (state.view === "errors") renderList(true);
  else if (state.view === "detail") renderDetail(state.detailId);
  else if (state.view === "jobs") renderJobs();
  else if (state.view === "routes") renderRoutes();
  else if (state.view === "system") renderSystem();
  else if (state.view === "kt") renderKt();
}

/* ── boot ─────────────────────────────────────────────────── */
(function boot() {
  try {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved) applyTheme(saved);
  } catch (e) {}
  $("theme-toggle").addEventListener("click", toggleTheme);
  api("/meta").then(function (m) {
    $("env").textContent = m.serviceName + "@" + m.version + " · " + m.environment;
    document.title = m.serviceName + " · Debugbar";
    var native = $("status-native");
    if (native) native.textContent = "native " + (m.nativeAvailable ? "on" : "off") + " · buffer " + (m.bufferSize != null ? m.bufferSize + " traces" : "");
  }).catch(function () {});
  render();
  scheduleRefresh();
})();
`;
