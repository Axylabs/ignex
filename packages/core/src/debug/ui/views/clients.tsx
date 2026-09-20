/**
 * @fileoverview Clients view — published SDK + frontend-client registry on the
 * page primitives: `PageHeader` (title/description/refresh) → `StatRow` →
 * `CardGrid` of `Card`s (name + kind/status badges, meta grid, tags, copyable
 * file paths) → empty state.
 */

import { type Component, createSignal, For, type JSX, Show } from "solid-js";

import { getClients } from "../api";
import { Badge, Chip, KindBadge } from "../components/badge";
import { Button } from "../components/button";
import { Card, CardGrid } from "../components/card";
import { Icon } from "../components/icon";
import { PageHeader } from "../components/page";
import { EmptyState } from "../components/states";
import { Stat, StatRow } from "../components/stats";
import { fmtNum } from "../format";

/** One published client card. */
const ClientCard = (props: {
  c: Awaited<ReturnType<typeof getClients>>["clients"][number];
}): JSX.Element => {
  const c = props.c;
  return (
    <Card>
      <div class="flex items-center gap-2">
        <Badge tone={c.kind === "sdk" ? "info" : "neutral"} mono>
          {c.kind === "sdk" ? "SDK" : "CLIENT"}
        </Badge>
        <span class="min-w-0 truncate font-mono">
          <b>{c.name}</b>
          {`@${c.version}`}
        </span>
        <KindBadge kind={c.platform ?? c.kind} />
        {c.published === "tagged" ? (
          <Badge tone="ok">tagged</Badge>
        ) : (
          <Badge tone="warn">local only</Badge>
        )}
        <span class="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            icon="copy"
            label="Copy"
            title={`Copy ${c.name}@${c.version}`}
            dataCopy={`${c.name}@${c.version}`}
          />
        </span>
      </div>
      <div class="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
        <span class="text-xs uppercase tracking-wide text-faint">location</span>
        <span class="truncate font-mono text-ink" title={c.location}>
          {c.location}
        </span>
        <span class="text-xs uppercase tracking-wide text-faint">latest tag</span>
        <span class="font-mono text-ink">{c.latestTag ?? "—"}</span>
      </div>
      {c.gitTags.length > 0 ? (
        <div class="mt-3 flex flex-wrap gap-1.5">
          <For each={c.gitTags}>{(t): JSX.Element => <Chip>{t}</Chip>}</For>
        </div>
      ) : null}
      {c.files.length > 0 ? (
        <div class="mt-3 flex flex-wrap gap-1.5">
          <For each={c.files}>
            {(f): JSX.Element => (
              <Chip dataCopy={f} title={`Copy ${f}`}>
                <Icon name="copy" size={12} />
                <span class="font-mono">{f}</span>
              </Chip>
            )}
          </For>
        </div>
      ) : null}
    </Card>
  );
};

/** The clients panel. */
export const ClientsView: Component = () => {
  const [clients, setClients] = createSignal<Awaited<ReturnType<typeof getClients>>["clients"]>([]);
  const [gitError, setGitError] = createSignal<string | null>(null);

  const load = (refresh = false): void => {
    void getClients(refresh)
      .then((res): void => {
        setClients(res.clients ?? []);
        setGitError(res.gitError ?? null);
      })
      .catch((): void => {});
  };

  load();

  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Clients"
        description="What we shipped to frontend teams, and where"
        actions={<Button icon="refresh" label="Refresh" onClick={(): void => load(true)} />}
      />

      <StatRow>
        <Stat
          value={fmtNum(clients().length)}
          label="published clients"
          sub={gitError() !== null ? "git unavailable" : "local + git tags"}
          tone={gitError() !== null ? "warn" : undefined}
        />
      </StatRow>

      <Show
        when={clients().length > 0}
        fallback={
          <Card>
            <EmptyState
              icon="package"
              message="No published clients detected."
              hint="Run ignex sdk (or ignex sdk --platform all) and point debugbar({ sdkPaths, clientPaths }) at the generated packages."
            />
          </Card>
        }
      >
        <CardGrid min={340}>
          <For each={clients()}>{(c): JSX.Element => <ClientCard c={c} />}</For>
        </CardGrid>
      </Show>
    </div>
  );
};
