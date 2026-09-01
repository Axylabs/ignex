/**
 * @fileoverview Clients view — published SDK + frontend-client registry cards
 * (local version, git tags, published state).
 */

import { type Component, createSignal, For, type JSX, Show } from "solid-js";

import { getClients } from "../api";
import { StatCard, StatRow } from "../components/widgets";
import { fmtNum } from "../format";
import { copyAttr } from "./copy-attr";

/** One published client card. */
const ClientCard = (props: {
  c: Awaited<ReturnType<typeof getClients>>["clients"][number];
}): JSX.Element => {
  const c = props.c;
  const badge =
    c.kind === "sdk" ? (
      <span class="pill method get">SDK</span>
    ) : (
      <span class="pill method post">CLIENT</span>
    );
  return (
    <div class="panel client-card">
      <div class="client-head">
        {badge}
        <span class="font-mono">
          <b>{c.name}</b>
          {`@${c.version}`}
        </span>
        <span class="pill kind" style={{ "--kc": "var(--k-lifecycle)" }}>
          {c.platform ?? c.kind}
        </span>
        {c.published === "tagged" ? (
          <span class="pill status ok">tagged ✓</span>
        ) : (
          <span class="pill status warn">local only</span>
        )}
        <span class="grow" />
        <button type="button" class="ghost mini" {...copyAttr(`${c.name}@${c.version}`)}>
          copy
        </button>
      </div>
      <div class="client-meta">
        <div>
          <span class="k">location</span>
          <span class="v font-mono">{c.location}</span>
        </div>
        <div>
          <span class="k">latest tag</span>
          <span class="v font-mono">{c.latestTag ?? "—"}</span>
        </div>
      </div>
      {c.gitTags.length > 0 ? (
        <div class="client-tags">
          {c.gitTags.map((t) => (
            <span class="chip">{t}</span>
          ))}
        </div>
      ) : null}
      {c.files.length > 0 ? (
        <div class="client-files">
          {c.files.map((f) => (
            <code>{f}</code>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** The clients panel. */
export const ClientsView: Component = () => {
  const [clients, setClients] = createSignal<Awaited<ReturnType<typeof getClients>>["clients"]>([]);
  const [gitError, setGitError] = createSignal<string | null>(null);

  void getClients()
    .then((res): void => {
      setClients(res.clients ?? []);
      setGitError(res.gitError ?? null);
    })
    .catch((): void => {});

  return (
    <div>
      <StatRow>
        <StatCard
          value={fmtNum(clients().length)}
          label="published clients"
          sub={gitError() !== null ? "git unavailable" : "local + git tags"}
          tone={gitError() !== null ? "warn" : undefined}
        />
      </StatRow>
      <Show
        when={clients().length === 0}
        fallback={<For each={clients()}>{(c): JSX.Element => <ClientCard c={c} />}</For>}
      >
        <div class="panel">
          <div class="empty">
            <div class="big">📦</div>
            No published clients detected.
            <div class="hint">
              {`Run ignex sdk (or ignex sdk --platform all) and point debugbar({ sdkPaths, clientPaths }) at the generated packages.`}
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};
