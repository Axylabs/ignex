/**
 * @fileoverview Application shell — the SPA's composition root. Owns the
 * sidebar + context bar + status bar chrome, boots metadata and the theme,
 * runs the global keyboard shortcuts (`/`, `r`, `t`, `0–9`, `Cmd/Ctrl-K`), the
 * delegated `[data-copy]` listener, and the live SSE stream with its
 * silent-stream polling watchdog. Views render through the `children` outlet so
 * this module never imports the view registry beyond labels/shortcuts.
 */

import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";

import { getMeta, type MetaInfo, openStream } from "../api";
import { copyText } from "../clipboard";
import { ingestRevision, pushPulse, setLastRevision, setStreamUp } from "../live";
import { currentRoute, navigate } from "../router";
import { initTheme, toggleTheme } from "../theme";
import { Toast } from "../toast";
import { VIEWS, viewFor } from "../views/registry";
import { CommandPalette } from "./command-palette";
import { ContextBar } from "./context-bar";
import { createNavState, Sidebar } from "./sidebar";

/** How long the stream may stay silent before the watchdog bumps a refresh. */
const POLL_FALLBACK_MS = 5000;

interface AppShellProps {
  /** The active route outlet. */
  children: JSX.Element;
}

/**
 * The dashboard frame: skip link, sidebar, context bar, view outlet, status bar,
 * command palette and toast. Mount once at the app root.
 */
export const AppShell = (props: AppShellProps): JSX.Element => {
  const nav = createNavState();
  const [meta, setMeta] = createSignal<MetaInfo | null>(null);
  const [nativeText, setNativeText] = createSignal("native —");
  const [bufferText, setBufferText] = createSignal("");
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  // ── boot: apply the theme, then fetch metadata (title + status labels) ────
  onMount((): void => {
    initTheme();
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
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      setPaletteOpen((open) => !open);
      return;
    }
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

  const envLabel = createMemo((): string => {
    const m = meta();
    return m === null ? "loading…" : `${m.serviceName}@${m.version}`;
  });
  const service = createMemo((): string => meta()?.serviceName ?? "debugbar");
  const environment = createMemo((): string => meta()?.environment ?? "");
  const viewLabel = createMemo((): string => {
    const id = currentRoute().view;
    return viewFor(id)?.label ?? id;
  });

  return (
    <div class="min-h-dvh bg-bg text-ink">
      <button
        type="button"
        onClick={(): void => {
          document.getElementById("view")?.focus();
        }}
        class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:border focus:border-line focus:bg-surface-2 focus:px-3 focus:py-1.5 focus:text-sm focus:text-ink"
      >
        Skip to content
      </button>

      <div
        class="grid min-h-dvh"
        style={{
          "grid-template-columns":
            nav.mode() === "drawer"
              ? "1fr"
              : nav.mode() === "rail"
                ? "var(--sidebar-w-rail) 1fr"
                : "var(--sidebar-w) 1fr",
        }}
      >
        <Sidebar
          mode={nav.mode()}
          drawerOpen={nav.drawerOpen()}
          envLabel={envLabel()}
          env={environment()}
          onNavigate={nav.close}
        />
        <Show when={nav.mode() === "drawer" && nav.drawerOpen()}>
          <button
            type="button"
            aria-label="Close navigation"
            class="fixed inset-0 z-40 bg-black/40"
            onClick={nav.close}
          />
        </Show>

        <div class="flex min-w-0 flex-col">
          <ContextBar
            service={service()}
            viewLabel={viewLabel()}
            onToggleNav={nav.toggle}
            onOpenPalette={(): void => {
              setPaletteOpen(true);
            }}
          />
          <main id="view" tabindex="-1" class="min-w-0 px-4 py-4 pb-16 text-md focus:outline-none">
            <div class="mx-auto flex max-w-[1500px] flex-col gap-4">{props.children}</div>
          </main>
        </div>
      </div>

      <footer class="fixed inset-x-0 bottom-0 z-30 flex items-center gap-4 border-t border-line bg-surface-1/95 px-4 py-1.5 pb-[env(safe-area-inset-bottom)] font-mono text-xs text-faint backdrop-blur">
        <span>{nativeText()}</span>
        <span>{bufferText()}</span>
        <span class="grow" />
        <span class="truncate">
          0–9 views · / search · r refresh · t theme · ⌘K palette · Prometheus:
          ./api/metrics/prometheus
        </span>
      </footer>

      <CommandPalette
        open={paletteOpen()}
        onClose={(): void => {
          setPaletteOpen(false);
        }}
      />
      <Toast />
    </div>
  );
};
