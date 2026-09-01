/**
 * @fileoverview Routes view — route inventory with client-side filtering and
 * copy buttons. Data comes from the AOT manifest / live router (KT index).
 */

import { type Component, createMemo, createSignal, For, type JSX, Show } from "solid-js";

import { getRoutes } from "../api";
import { EmptyState, MethodPill, Panel } from "../components/widgets";
import { copyAttr } from "./copy-attr";

/** The routes panel. */
export const RoutesView: Component = () => {
  const [routes, setRoutes] = createSignal<Array<{ method: string; path: string; file?: string }>>(
    [],
  );
  const [enabled, setEnabled] = createSignal(true);
  const [q, setQ] = createSignal("");

  void getRoutes()
    .then((res): void => {
      setEnabled(res.enabled);
      setRoutes(res.routes ?? []);
    })
    .catch((): void => {
      setEnabled(false);
    });

  const visible = createMemo(() => {
    const needle = q().toLowerCase();
    return routes().filter((r) => {
      if (needle === "") return true;
      return `${r.method} ${r.path} ${r.file ?? ""}`.toLowerCase().includes(needle);
    });
  });

  return (
    <div>
      <Panel>
        <div class="toolbar">
          <input
            class="search"
            id="search"
            type="text"
            placeholder="filter method / path / file…"
            value={q()}
            onInput={(ev): void => {
              setQ((ev.target as HTMLInputElement).value);
            }}
          />
          <span class="grow" />
          <span class="text-muted">{`${String(visible().length)} routes`}</span>
        </div>
      </Panel>
      <Panel>
        <table>
          <thead>
            <tr>
              {["Method", "Path", "File", ""].map((l) => (
                <th>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <For each={visible()}>
              {(r): JSX.Element => (
                <tr>
                  <td>
                    <MethodPill method={r.method} />
                  </td>
                  <td class="font-mono">{r.path}</td>
                  <td class="text-muted">{r.file ?? ""}</td>
                  <td>
                    <button type="button" class="ghost mini" {...copyAttr(`${r.method} ${r.path}`)}>
                      copy
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={!enabled()}>
          <EmptyState
            glyph="🗺"
            message="No route provider."
            hint="The KT page still lists routes from the manifest / router."
          />
        </Show>
      </Panel>
    </div>
  );
};
