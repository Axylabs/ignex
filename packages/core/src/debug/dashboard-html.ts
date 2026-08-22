/**
 * @fileoverview Debugbar dashboard shell — served at `{path}/`.
 *
 * The shell is intentionally dependency-free: a single `<link>` to the
 * stylesheet (`{path}/app.css`) and a single `<script>` to the app
 * (`{path}/app.js`). `__BASE__` is replaced by the plugin with the configured
 * mount path so relative asset URLs resolve correctly in both AOT and router
 * modes.
 */

export const DEBUGBAR_DASHBOARD_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>IgnEx Debugbar</title>
    <link rel="stylesheet" href="__BASE__/app.css" />
  </head>
  <body>
    <header class="topbar">
      <div class="brand">
        <span class="logo">⚡</span>
        <div>
          <h1>IgnEx Debugbar</h1>
          <span class="sub" id="env">loading…</span>
        </div>
      </div>
      <nav id="nav">
        <button data-view="requests" class="active">Requests</button>
        <button data-view="errors">Errors</button>
        <button data-view="jobs">Jobs</button>
        <button data-view="routes">Routes</button>
        <button data-view="system">System</button>
        <button data-view="kt">KT</button>
      </nav>
      <div class="topbar-actions">
        <span class="live-dot" id="live" title="live tail"></span>
        <button class="icon-btn" id="theme-toggle" title="toggle theme (t)">◐</button>
      </div>
    </header>

    <main id="view"></main>

    <footer class="statusbar">
      <span id="status-native">native —</span>
      <span id="status-buffer"></span>
      <span class="grow"></span>
      <span>1–6 views · / search · r refresh · t theme</span>
    </footer>

    <div class="toast" id="toast"></div>
    <script src="__BASE__/app.js"></script>
  </body>
</html>`;
