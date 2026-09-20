/**
 * @fileoverview Docs view — the framework/repo documentation rendered inside
 * the debugbar. Sidebar = the docs inventory (same scan as KT); content = the
 * selected doc (sanitized server HTML, or a plain-markdown fallback when the
 * server renderer is unavailable). Deep links: `#/docs`, `#/docs/<path>`.
 */

import { type Component, createEffect, createSignal, For, type JSX, Show } from "solid-js";

import type { KnowledgeDoc } from "../../types";
import { getDoc, getDocs } from "../api";
import { EmptyState, Panel } from "../components/widgets";
import { currentRoute, navigate } from "../router";

/** The docs panel. */
export const DocsView: Component = () => {
  const [docs, setDocs] = createSignal<KnowledgeDoc[]>([]);
  const [enabled, setEnabled] = createSignal(true);
  const [html, setHtml] = createSignal<string | null>(null);
  const [markdown, setMarkdown] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  void getDocs()
    .then((res) => setDocs(res.docs ?? []))
    .catch(() => setEnabled(false));

  // Load the selected doc whenever the route's doc id changes.
  createEffect(() => {
    const path = currentRoute().id;
    if (path === null) {
      setTitle("");
      setHtml(null);
      setMarkdown("");
      setError(null);
      return;
    }
    void getDoc(path)
      .then((d) => {
        setTitle(d.title);
        setHtml(d.html);
        setMarkdown(d.markdown);
        setError(null);
      })
      .catch(() => setError("Could not load this document."));
  });

  const selectedPath = (): string | null => currentRoute().id;

  return (
    <div class="grid grid-cols-[280px_1fr] items-start gap-[18px]">
      <Panel title="Documentation">
        <Show when={docs().length === 0} fallback={<></>}>
          <EmptyState
            glyph="📄"
            message="No docs found."
            hint="Set debugbar({ docsPaths }) to scan your repository's docs."
          />
        </Show>
        <div class="kt-rows">
          <For each={docs()}>
            {(doc): JSX.Element => (
              <button
                type="button"
                class={`kt-row w-full text-left ${doc.path === selectedPath() ? "active" : ""}`}
                onClick={(): void => navigate("docs", doc.path)}
              >
                <div class="t">📄 {doc.title}</div>
                <div class="p font-mono">{doc.path}</div>
              </button>
            )}
          </For>
        </div>
      </Panel>
      <div>
        <Show when={selectedPath() !== null}>
          <Panel title={title() || "Document"}>
            <Show
              when={error() === null}
              fallback={<EmptyState glyph="⚠️" message={error() ?? ""} />}
            >
              <article class="markdown" innerHTML={html() ?? ""} />
              <Show when={html() === null}>
                <pre class="overflow-auto whitespace-pre-wrap p-[14px]">{markdown()}</pre>
              </Show>
            </Show>
          </Panel>
        </Show>
        <Show when={selectedPath() === null} fallback={<></>}>
          <Panel title="Docs">
            <EmptyState
              glyph="📚"
              message="Pick a document from the sidebar."
              hint="Docs are rendered from the same scan as the KT page (debugbar docsPaths)."
            />
          </Panel>
        </Show>
      </div>
      <Show when={!enabled()}>
        <EmptyState
          glyph="📄"
          message="Docs unavailable."
          hint="The docs endpoint did not respond."
        />
      </Show>
    </div>
  );
};
