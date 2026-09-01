/**
 * @fileoverview Application shell — topbar, nav, status bar, live stream and
 * the route→view outlet. This is the SPA's composition root: it owns global
 * keyboard shortcuts, delegated copy buttons, theme persistence, the SSE
 * connection (with polling fallback) and view swapping with per-activation
 * disposal (Solid disposes each view's reactive graph when the route moves).
 */

import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";

import { getMeta, type MetaInfo, openStream } from "./api";
import { copyText } from "./clipboard";
import { ingestRevision, paused, pushPulse, setLastRevision, setPaused, setStreamUp } from "./live";
import { currentRoute, navigate } from "./router";
import { toggleTheme } from "./theme";
import { Toast } from "./toast";
import { VIEWS, viewFor } from "./views/registry";

const POLL_FALLBACK_MS = 5000;

/** Route outlet: re-mounts the active view whenever ANY route segment moves. */
const ViewOutlet = (): JSX.Element => {
  const routeKey = createMemo(
    () => `${currentRoute().view}\u0000${currentRoute().id ?? ""}\u0000${currentRoute().tab ?? ""}`,
  );
  return (
    <Show when={routeKey()} keyed>
      {(key): JSX.Element => {
        // `key` is the composite route signature; the view id is its head.
        const def = viewFor(key.split("\u0000")[0] ?? "requests");
        if (def === null) return null;
        const Comp = def.component;
        return <Comp />;
      }}
    </Show>
  );
};

/** The dashboard: topbar, outlet, status bar, toast. */
export const App = (): JSX.Element => {
  const [meta, setMeta] = createSignal<MetaInfo | null>(null);
  const [nativeText, setNativeText] = createSignal("native —");
  const [bufferText, setBufferText] = createSignal("");

  // ── boot metadata (title, env label, native/buffer status) ───────────────
  onMount((): void => {
    void getMeta()
      .then((m): void => {
        setMeta(m);
        document.title = `${m.serviceName} · Debugbar`;
        setNativeText(`native ${m.nativeAvailable ? "on" : "off"}`);
        setBufferText(
          m.bufferSize !== undefined && m.bufferSize !== null
            ? `${m.bufferSize} traces buffered`
            : "",
        );
      })
      .catch((): void => {});
  });

  // ── global keyboard shortcuts ─────────────────────────────────────────────
  const onKeydown = (ev: KeyboardEvent): void => {
    const tag = (ev.target as HTMLElement | null)?.tagName ?? "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      if (ev.key === "Escape") (ev.target as HTMLElement).blur();
      return;
    }
    if (ev.key === "/") {
      ev.preventDefault();
      document.getElementById("search")?.focus();
      return;
    }
    if (ev.key === "r") {
      pushPulse(); // manual full refresh
      return;
    }
    if (ev.key === "t") {
      toggleTheme();
      return;
    }
    const idx = "1234567890".indexOf(ev.key);
    if (idx >= 0 && idx < VIEWS.length) {
      const view = VIEWS[idx];
      if (view !== undefined) navigate(view.id);
    }
  };
  document.addEventListener("keydown", onKeydown);

  // ── delegated copy buttons ([data-copy]) anywhere in the dashboard ────────
  const onClick = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null;
    const holder = target?.closest("[data-copy]");
    if (holder !== null && holder !== undefined) {
      copyText(holder.getAttribute("data-copy") ?? "");
    }
  };
  document.addEventListener("click", onClick);

  // ── live stream + polling watchdog ────────────────────────────────────────
  // The stream pushes a revision frame whenever a data domain moves. The
  // watchdog below treats "no frame within a full poll window" as a signal to
  // bump a full-refresh pulse, so the dashboard self-heals even when the SSE
  // transport is CONNECTED but silent (server stopped pushing, counters not
  // wired for some mutation, half-open connection). While revisions are
  // flowing the watchdog stays quiet and the fast path does the work.
  let lastRevisionAt = 0;
  const closeStream = openStream({
    onRevision: (rev): void => {
      lastRevisionAt = Date.now();
      setStreamUp(true);
      setLastRevision(rev);
      ingestRevision(rev);
    },
    onDown: (): void => {
      setStreamUp(false);
    },
  });
  const pollTimer = setInterval((): void => {
    if (document.hidden) return;
    if (Date.now() - lastRevisionAt < POLL_FALLBACK_MS) return;
    pushPulse();
  }, POLL_FALLBACK_MS);

  onCleanup((): void => {
    closeStream();
    clearInterval(pollTimer);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("click", onClick);
  });

  const envLabel = createMemo((): string =>
    meta() === null
      ? "loading…"
      : `${meta()?.serviceName}@${meta()?.version} · ${meta()?.environment}`,
  );

  return (
    <div>
      <header class="topbar sticky top-0 z-50 flex h-[54px] items-center gap-[18px] border-b border-line bg-panel/85 px-[18px] backdrop-blur-[14px]">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="logo grid h-[30px] w-[30px] place-items-center rounded-lg text-base text-white">
            ⚡
          </span>
          <div>
            <h1 class="m-0 text-sm font-bold tracking-[0.01em]">IgnEx Debugbar</h1>
            <span class="sub block max-w-full truncate font-mono text-[11px] text-muted">
              {envLabel()}
            </span>
          </div>
        </div>
        <nav class="ml-auto flex items-center gap-0.5">
          <For each={VIEWS}>
            {(view): JSX.Element => (
              <button
                type="button"
                data-view={view.id}
                class={currentRoute().view === view.id ? "active" : ""}
                onClick={(): void => navigate(view.id)}
              >
                {view.label}
              </button>
            )}
          </For>
        </nav>
        <div class="flex items-center gap-2">
          <button
            type="button"
            id="live"
            class={paused() ? "live-dot paused" : "live-dot"}
            title="click to pause/resume live tail"
            aria-label="pause or resume the live tail"
            onClick={(): void => {
              setPaused(!paused());
            }}
          />
          <button
            type="button"
            class="icon-btn"
            id="theme-toggle"
            title="toggle theme (t)"
            onClick={toggleTheme}
          >
            ◐
          </button>
        </div>
      </header>

      <main id="view" class="mx-auto max-w-[1400px] px-[18px] pb-[60px] pt-[18px]">
        <ViewOutlet />
      </main>

      <footer class="statusbar fixed bottom-0 left-0 right-0 z-40 flex items-center gap-[18px] border-t border-line bg-panel/95 px-[18px] py-1.5 font-mono text-[10.5px] text-faint backdrop-blur">
        <span>{nativeText()}</span>
        <span>{bufferText()}</span>
        <span class="grow" />
        <span>
          0–9 views · / search · r refresh · t theme · Prometheus: ./api/metrics/prometheus
        </span>
      </footer>

      <Toast />
    </div>
  );
};

/**
 * Mount the dashboard into `root` (defaults to body). Returns a disposer so
 * tests can run/stop the whole app without leaking timers or listeners.
 */
export const mountApp = (root?: HTMLElement): (() => void) =>
  render(() => <App />, root ?? document.body);
