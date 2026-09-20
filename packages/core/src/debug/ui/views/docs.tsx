/**
 * @fileoverview Docs view — the framework/repo documentation rendered inside
 * the debugbar. `PageHeader` → responsive two-pane: the docs inventory sidebar
 * (filterable) and the selected doc's content card (sanitized server HTML, or a
 * plain-markdown fallback when the server renderer is unavailable). The two
 * panes stack below `lg`. Deep links: `#/docs`, `#/docs/<path>`.
 */

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js";

import type { KnowledgeDoc } from "../../types";
import { getDoc, getDocs } from "../api";
import { CountChip } from "../components/badge";
import { Card } from "../components/card";
import { SearchInput } from "../components/fields";
import { Icon } from "../components/icon";
import { PageHeader } from "../components/page";
import { EmptyState } from "../components/states";
import { currentRoute, navigate } from "../router";

/** The docs panel. */
export const DocsView: Component = () => {
  const [docs, setDocs] = createSignal<KnowledgeDoc[]>([]);
  const [enabled, setEnabled] = createSignal(true);
  const [html, setHtml] = createSignal<string | null>(null);
  const [markdown, setMarkdown] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");

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

  /** Client-side filter over the existing inventory (title or path). */
  const filteredDocs = createMemo((): KnowledgeDoc[] => {
    const q = query().trim().toLowerCase();
    if (q === "") return docs();
    return docs().filter(
      (doc) => doc.title.toLowerCase().includes(q) || doc.path.toLowerCase().includes(q),
    );
  });

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Docs"
        description="The repository's markdown documentation, rendered in the dashboard."
      />
      <div class="grid gap-4 lg:grid-cols-[280px_1fr] lg:items-start">
        <Card title="Documentation" headExtra={<CountChip n={docs().length} />}>
          <div class="mb-2">
            <SearchInput
              id="search"
              placeholder="filter docs…"
              value={query()}
              spellcheck={false}
              onInput={setQuery}
            />
          </div>
          <Show
            when={docs().length > 0}
            fallback={
              <EmptyState
                icon="file-text"
                message="No docs found."
                hint="Set debugbar({ docsPaths }) to scan your repository's docs."
              />
            }
          >
            <Show
              when={filteredDocs().length > 0}
              fallback={<EmptyState icon="search" message="No docs match this filter." />}
            >
              <div class="flex flex-col gap-1">
                <For each={filteredDocs()}>
                  {(doc): JSX.Element => (
                    <button
                      type="button"
                      class={`flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
                        doc.path === selectedPath()
                          ? "border-accent bg-accent-soft"
                          : "border-transparent hover:bg-surface-2"
                      }`}
                      aria-current={doc.path === selectedPath() ? "page" : undefined}
                      onClick={(): void => navigate("docs", doc.path)}
                    >
                      <span class="flex items-center gap-1.5 text-sm text-ink">
                        <Icon name="file-text" size={14} class="shrink-0 text-faint" />
                        <span class="min-w-0 truncate">{doc.title}</span>
                      </span>
                      <span class="min-w-0 truncate pl-[22px] font-mono text-xs text-faint">
                        {doc.path}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Card>
        <div>
          <Show
            when={selectedPath() !== null}
            fallback={
              <Card title="Docs">
                <EmptyState
                  icon="book"
                  message="Pick a document from the sidebar."
                  hint="Docs are rendered from the same scan as the KT page (debugbar docsPaths)."
                />
              </Card>
            }
          >
            <Card title={title() || "Document"}>
              <Show
                when={error() === null}
                fallback={<EmptyState icon="alert" message={error() ?? ""} />}
              >
                <article class="markdown" innerHTML={html() ?? ""} />
                <Show when={html() === null}>
                  <pre class="overflow-auto whitespace-pre-wrap p-[14px]">{markdown()}</pre>
                </Show>
              </Show>
            </Card>
          </Show>
        </div>
      </div>
      <Show when={!enabled()}>
        <EmptyState
          icon="file-text"
          message="Docs unavailable."
          hint="The docs endpoint did not respond."
        />
      </Show>
    </div>
  );
};
