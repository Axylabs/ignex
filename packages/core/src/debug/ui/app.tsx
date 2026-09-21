/**
 * @fileoverview Application composition root — mounts the {@link AppShell}
 * around the route outlet. The shell owns global shortcuts, the SSE stream,
 * metadata and the status/context bars; this module keeps only the keyed
 * route→view swap, so each view remounts (and Solid disposes its reactive
 * graph) whenever any route segment moves.
 */

import { createMemo, type JSX, Show } from "solid-js";
import { render } from "solid-js/web";

import { AppShell } from "./layout/shell";
import { currentRoute } from "./router";
import { viewFor } from "./views/registry";

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

/** The dashboard: the app shell wrapped around the keyed route outlet. */
export const App = (): JSX.Element => (
  <AppShell>
    <ViewOutlet />
  </AppShell>
);

/**
 * Mount the dashboard into `root` (defaults to body). Returns a disposer so
 * tests can run/stop the whole app without leaking timers or listeners.
 */
export const mountApp = (root?: HTMLElement): (() => void) =>
  render(() => <App />, root ?? document.body);
