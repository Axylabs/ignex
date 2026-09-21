/**
 * @fileoverview KT (knowledge transfer) view — the generated "how this app
 * works" page. `PageHeader` (service name + env badges + runtime meta) →
 * `StatRow` → one `Card` per section: project map (`CardGrid`), request-anatomy
 * pipeline, plugins, routes, observed DB activity, span kinds, docs inventory,
 * SDK and environment. Every data source and computed value is unchanged; this
 * is a restyle onto the shared primitives.
 */

import { type Component, createSignal, For, type JSX, Show } from "solid-js";

import type { AppKnowledge } from "../../types";
import { getKt } from "../api";
import {
  Badge,
  type BadgeTone,
  Chip,
  CountChip,
  KindBadge,
  MethodBadge,
  SqlBadge,
} from "../components/badge";
import { Button } from "../components/button";
import { Callout, Card, CardGrid } from "../components/card";
import { Icon, type IconName } from "../components/icon";
import { Kvs } from "../components/kvs";
import { PageHeader } from "../components/page";
import { EmptyState } from "../components/states";
import { Stat, StatRow } from "../components/stats";
import { DataTable } from "../components/table";
import { BarRow, BarTrack } from "../components/widgets";
import { envTone, fmtMs, fmtNum, fmtUptime } from "../format";
import { navigate } from "../router";
import { copyAttr } from "./copy-attr";

/** Project-area → icon; unlisted areas fall back to `file-text`. */
const AREA_ICONS: Record<string, IconName> = {
  routes: "route",
  models: "database",
  middleware: "layers",
  hooks: "refresh",
  views: "file-text",
  config: "package",
  lib: "briefcase",
  database: "database",
};

/** Span kind → onboarding description. */
const KIND_DESC: Record<string, string> = {
  request: "the request itself",
  lifecycle: "framework stages",
  db: "database queries",
  cache: "cache operations",
  http: "outbound HTTP",
  render: "templates & files",
  auth: "auth / security",
  custom: "application code",
  error: "failed operations",
};

/** Lifecycle stages that run application code (rendered as "hot" badges). */
const HOT_STAGES = new Set(["handler", "beforeHandle"]);

/** Environment name → badge tone (keeps `envTone`'s prod/dev/other semantics). */
const envBadgeTone = (value: string): BadgeTone => envTone(value) as BadgeTone;

/* ── sections ───────────────────────────────────────────────────────────── */

/** Header: service name + env badges, with runtime facts right-aligned. */
const Header = (props: { k: AppKnowledge }): JSX.Element => {
  const k = props.k;
  const rt = k.runtime;
  return (
    <PageHeader
      title={k.serviceName}
      description="How this app works — every route, plugin, database statement and document, discovered from what this deployment actually runs. Start here before reading any code."
      badge={
        <>
          <Badge tone="neutral" mono>{`v${k.version}`}</Badge>
          <Badge tone={envBadgeTone(rt.nodeEnv)} mono>
            {rt.nodeEnv}
          </Badge>
        </>
      }
      actions={
        <div class="text-right font-mono text-xs leading-relaxed text-faint">
          <div class="text-ink">{`${k.serviceName}@${k.version}`}</div>
          <div>{`Bun ${rt.bunVersion} · ${rt.platform}/${rt.arch}`}</div>
          <div>{`pid ${String(rt.pid)} · up ${fmtUptime(rt.uptimeSec)}`}</div>
        </div>
      }
    />
  );
};

/** Project-map card: icon + name + dir + description + copyable sample files. */
const AreaCard = (props: { a: AppKnowledge["areas"][number] }): JSX.Element => {
  const a = props.a;
  const isFileArea = /\.(c|m)?[jt]sx?$/.test(a.dir);
  return (
    <Card>
      <div class="flex items-center gap-2">
        <Icon name={AREA_ICONS[a.name] ?? "file-text"} class="shrink-0 text-faint" />
        <span class="text-sm font-medium text-ink">{a.name}</span>
        <span class="ml-auto min-w-0 truncate font-mono text-xs text-faint">
          {isFileArea ? a.dir : `${a.dir}/`}
        </span>
      </div>
      <p class="mt-1 text-sm text-muted">{a.description}</p>
      {a.files.length > 0 ? (
        <>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <For each={a.files}>
              {(f): JSX.Element => (
                <Chip
                  class="font-mono"
                  title="click to copy path"
                  dataCopy={`${a.dir.replace(/\/+$/, "")}/${f}`}
                >
                  {f}
                </Chip>
              )}
            </For>
          </div>
          {a.fileCount > a.files.length ? (
            <div class="mt-1 text-xs text-faint">
              {`+ ${String(a.fileCount - a.files.length)} more file${a.fileCount - a.files.length === 1 ? "" : "s"}`}
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
};

/** Full knowledge render: every card for a knowledge payload. */
const Knowledge = (props: { k: AppKnowledge }): JSX.Element => {
  const k = props.k;
  const rt = k.runtime;

  // request anatomy — pipeline
  const pipeline = (): JSX.Element | null => {
    if (k.lifecycle.length === 0) return null;
    const stages = [...k.lifecycle].sort((x, y) => x.order - y.order);
    return (
      <Card title="Request anatomy">
        <div class="flex flex-wrap items-center gap-1.5">
          {stages.map(
            (st, i): JSX.Element => (
              <>
                {i > 0 ? <Icon name="arrow-right" class="text-faint" /> : null}
                <Badge
                  tone={HOT_STAGES.has(st.name) ? "info" : "neutral"}
                  variant={HOT_STAGES.has(st.name) ? "solid" : "soft"}
                >
                  {st.name}
                  {st.hookCount > 0 ? (
                    <span class="font-mono tabular-nums">{String(st.hookCount)}</span>
                  ) : null}
                </Badge>
              </>
            ),
          )}
          <Icon name="arrow-right" class="text-faint" />
          <span class="text-xs text-faint">on error</span>
          <Badge tone="err" variant="solid">
            error
          </Badge>
        </div>
        <p class="mt-3 text-sm text-muted">
          Every request flows through these stages in order. A pre-handler stage may halt the chain
          with a response (auth, rate limits, CORS); failures jump to the <b>error</b> stage.
          Numbers in a badge are registered hooks. Each stage shows up as a waterfall row when you
          open a request trace.
        </p>
      </Card>
    );
  };

  return (
    <div class="flex flex-col gap-4">
      <Header k={k} />
      <StatRow>
        <Stat value={fmtNum(k.routes.length)} label="routes" sub="discovered" />
        <Stat value={fmtNum(k.plugins.length)} label="plugins" sub="registered" />
        <Stat value={fmtNum(k.lifecycle.length)} label="lifecycle" sub="stages" />
        <Stat value={fmtNum(k.docs.length)} label="docs" sub="in repo" />
        <Stat value={fmtNum(k.dbActions.length)} label="db patterns" sub="observed" />
      </StatRow>
      <Show when={(k.areas ?? []).length > 0}>
        <Card title="Where things live" headExtra={<CountChip n={k.areas.length} />}>
          <CardGrid min={330}>
            <For each={k.areas}>{(a): JSX.Element => <AreaCard a={a} />}</For>
          </CardGrid>
          <div class="mt-3">
            <Callout tone="info" title="Convention">
              route files map 1:1 to URLs: health.get.ts → GET /health, users/[id].get.ts → GET
              /users/:id. Cross-cutting behavior lives in plugins (app.config.ts) and middleware;
              per-request work is composed inside handlers. Click any file to copy its path.
            </Callout>
          </div>
        </Card>
      </Show>
      {pipeline()}
      <Show when={k.plugins.length > 0}>
        <Card title="Plugins" headExtra={<CountChip n={k.plugins.length} />}>
          <div class="flex flex-col gap-2">
            <For each={k.plugins}>
              {(p): JSX.Element => (
                <div class="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                  <span class="font-mono text-sm text-ink">{p.name}</span>
                  <span class="text-sm text-muted">{p.description}</span>
                </div>
              )}
            </For>
          </div>
        </Card>
      </Show>
      <Show when={k.routes.length > 0}>
        <Card
          title="Routes"
          hint={
            <span class="text-xs text-faint">from the compiled manifest or the live router</span>
          }
          headExtra={<CountChip n={k.routes.length} />}
          pad={false}
        >
          <DataTable
            label="Routes"
            columns={["Method", "Path", "Source", "Behavior"]}
            rows={k.routes}
            rowKey={(r): string => `${r.method} ${r.path}`}
            render={(r): JSX.Element[] => [
              <MethodBadge method={r.method} />,
              <span class="flex items-center gap-1.5 font-mono">
                {r.path}
                {r.isConstant ? <Badge tone="info">constant</Badge> : null}
              </span>,
              <span class="font-mono text-muted">
                {r.file !== null && r.file !== "" ? r.file : r.description}
              </span>,
              <span class="text-muted">{(r.usage ?? []).join(", ") || "—"}</span>,
            ]}
          />
        </Card>
      </Show>
      <Show
        when={k.dbActions.length > 0}
        fallback={
          <Card title="Database activity">
            <EmptyState
              icon="database"
              message="No DB queries observed in the retained window."
              hint="Wrap calls in ctx.debug.query(sql, params, fn) or debugQuery() — then every statement shows up here with timing and routes."
            />
          </Card>
        }
      >
        <Card
          title="Database activity"
          hint={
            <span class="text-xs text-faint">
              what each route actually does to the database · per-request detail lives in a trace's
              Queries tab
            </span>
          }
          headExtra={<CountChip n={k.dbActions.length} />}
          pad={false}
        >
          <DbActivity actions={k.dbActions} />
        </Card>
      </Show>
      <Show when={(k.spanKinds ?? []).length > 0}>
        <Card title="Span kinds you can trace">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <For each={k.spanKinds}>
              {(kd): JSX.Element => (
                <span class="inline-flex items-center gap-1.5">
                  <KindBadge kind={kd} />
                  <span class="text-xs text-faint">{KIND_DESC[kd] ?? ""}</span>
                </span>
              )}
            </For>
          </div>
        </Card>
      </Show>
      <Show
        when={k.docs.length > 0}
        fallback={
          <Card title="Documentation">
            <EmptyState
              icon="file-text"
              message="No markdown docs found."
              hint="Scanned docs/ and the project root. Point debugbar({ docsPaths }) at your docs to list them here."
            />
          </Card>
        }
      >
        <Card title="Documentation" headExtra={<CountChip n={k.docs.length} />}>
          <div class="flex flex-col gap-2">
            <For each={k.docs}>
              {(doc): JSX.Element => (
                <div class="flex items-center gap-2">
                  <Icon name="file-text" size={14} class="shrink-0 text-faint" />
                  <span class="min-w-0 truncate font-mono text-sm text-ink">{doc.title}</span>
                  <span
                    class="ml-auto min-w-0 truncate font-mono text-xs text-faint"
                    title="click to copy path"
                    {...copyAttr(doc.path)}
                  >
                    {doc.path}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="external-link"
                    label="open"
                    title="open in Docs"
                    onClick={(): void => navigate("docs", doc.path)}
                  />
                </div>
              )}
            </For>
          </div>
        </Card>
      </Show>
      <Show when={k.sdk !== null}>
        <Card title="Published SDK">
          <SdkCard k={k} />
        </Card>
      </Show>
      <Card
        title="Environment"
        hint={<span class="text-xs text-faint">values shown for the standard debug keys only</span>}
      >
        <Kvs
          rows={[
            {
              k: "runtime",
              v: `Bun ${rt.bunVersion} on ${rt.platform}/${rt.arch} (pid ${String(rt.pid)})`,
            },
            ...Object.keys(k.environment ?? {})
              .sort()
              .map((key) => ({
                k: key,
                v: String((k.environment as Record<string, string>)[key]),
                mono: true,
              })),
          ]}
        />
      </Card>
    </div>
  );
};

/** Database activity table with call bars and route chips. */
const DbActivity = (props: { actions: AppKnowledge["dbActions"] }): JSX.Element => {
  let maxCalls = 1;
  for (const q of props.actions) maxCalls = Math.max(maxCalls, q.calls);
  return (
    <DataTable
      label="Database activity"
      columns={["Action", "Table", "Calls", "Total ms", "Statement", "Seen in routes"]}
      rows={props.actions}
      rowKey={(q): string => `${q.action} ${q.table ?? ""} ${q.statement}`}
      align={[2, 3]}
      render={(q): JSX.Element[] => [
        <SqlBadge action={q.action} />,
        <span class="font-mono">{q.table ?? "—"}</span>,
        <BarRow>
          <span class="min-w-[26px] font-mono tabular-nums">{String(q.calls)}</span>
          <BarTrack
            pct={Math.max((q.calls / maxCalls) * 100, 4)}
            maxWidth="90px"
            title={`${String(q.calls)} calls`}
          />
        </BarRow>,
        <span class="font-mono text-muted">{fmtMs(q.totalMs)}</span>,
        <span class="block max-w-[420px] truncate font-mono text-muted" title={q.statement}>
          {q.statement}
        </span>,
        <div class="flex flex-wrap gap-1">
          <For each={q.routes ?? []}>{(rr): JSX.Element => <Chip>{rr}</Chip>}</For>
        </div>,
      ]}
    />
  );
};

/** Published SDK card. */
const SdkCard = (props: { k: AppKnowledge }): JSX.Element => {
  const sdk = props.k.sdk;
  if (sdk === null) return null;
  return (
    <div>
      <div class="flex items-center gap-2">
        <Badge tone="info" mono>
          SDK
        </Badge>
        <span class="min-w-0 truncate font-mono">
          <b>{sdk.name}</b>
          {`@${sdk.version}`}
        </span>
        <span class="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            icon="copy"
            label="copy"
            dataCopy={`${sdk.name}@${sdk.version}`}
          />
        </span>
      </div>
      <div class="mt-3">
        <Kvs rows={[{ k: "location", v: sdk.location, mono: true }]} />
      </div>
      {sdk.files.length > 0 ? (
        <div class="mt-3 flex flex-wrap gap-1.5">
          <For each={sdk.files}>{(f): JSX.Element => <Chip class="font-mono">{f}</Chip>}</For>
        </div>
      ) : null}
      <p class="mt-3 text-sm text-muted">
        Generated with <b>ignex sdk</b> — frontend teams install it and get typed endpoints for
        every route above.
      </p>
    </div>
  );
};

/* ── the view ───────────────────────────────────────────────────────────── */

/** The KT panel. */
export const KtView: Component = () => {
  const [payload, setPayload] = createSignal<Awaited<ReturnType<typeof getKt>> | null>(null);
  void getKt()
    .then(setPayload)
    .catch((): void => {});

  return (
    <Show
      when={payload()}
      keyed
      fallback={
        <PageHeader
          title="Knowledge transfer"
          description="Loading the generated map of this deployment…"
        />
      }
    >
      {(res): JSX.Element => {
        const k = res.knowledge;
        if (k === undefined || k === null || k.runtime === undefined || k.runtime === null) {
          // Fallback: server-rendered markdown HTML (sanitized server-side).
          return (
            <div class="flex flex-col gap-4">
              <PageHeader
                title="Knowledge transfer"
                description="Generated from live artifacts, rendered as markdown."
              />
              <Card>
                <MarkdownFallback html={res.html ?? null} markdown={res.markdown ?? ""} />
              </Card>
            </div>
          );
        }
        return <Knowledge k={k} />;
      }}
    </Show>
  );
};

/** Prefer sanitized server HTML; otherwise show raw markdown in a pre. */
const MarkdownFallback = (props: { html: string | null; markdown: string }): JSX.Element =>
  props.html !== null && props.html !== "" ? (
    <div class="markdown" innerHTML={props.html} />
  ) : (
    <pre>{props.markdown}</pre>
  );
