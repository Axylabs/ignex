/**
 * @fileoverview KT (knowledge transfer) view — the generated "how this app
 * works" page: hero, project-map card grid, request-anatomy pipeline, routes,
 * observed DB activity, span kinds, docs inventory, SDK and environment.
 */

import { type Component, createSignal, For, type JSX, Show } from "solid-js";

import type { AppKnowledge } from "../../types";
import { getKt } from "../api";
import {
  CountChip,
  EmptyState,
  MethodPill,
  Panel,
  SqlPill,
  StatCard,
  StatRow,
} from "../components/widgets";
import { envTone, fmtMs, fmtNum, fmtUptime, kindColor } from "../format";
import { copyAttr } from "./copy-attr";

const AREA_GLYPHS: Record<string, string> = {
  routes: "⇄",
  models: "◆",
  middleware: "≡",
  hooks: "↻",
  views: "▤",
  config: "⚙",
  lib: "✳",
  database: "⛁",
};

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

/* ── sections ───────────────────────────────────────────────────────────── */

/** Hero banner: service name + runtime meta chips. */
const Hero = (props: { k: AppKnowledge }): JSX.Element => {
  const k = props.k;
  const rt = k.runtime;
  return (
    <div class="kt-hero">
      <div class="kt-hero-row">
        <div class="grow">
          <div class="kt-eyebrow">Knowledge transfer · generated from live artifacts</div>
          <div class="kt-title">{k.serviceName}</div>
          <div class="kt-sub">
            How this app works — every route, plugin, database statement and document, discovered
            from what this deployment actually runs. Start here before reading any code.
          </div>
          <div class="kt-meta">
            <span class="chip">{`v${k.version}`}</span>
            <span class={`chip env-${envTone(rt.nodeEnv)}`}>{rt.nodeEnv}</span>
            <span class="chip">{`Bun ${rt.bunVersion}`}</span>
            <span class="chip">{`${rt.platform}/${rt.arch}`}</span>
            <span class="chip">{`pid ${String(rt.pid)}`}</span>
            <span class="chip">{`up ${fmtUptime(rt.uptimeSec)}`}</span>
          </div>
        </div>
        <div class="kt-runtime">
          <b>{`${k.serviceName}@${k.version}`}</b>
          <br />
          {rt.nodeEnv}
          <br />
          {`Bun ${rt.bunVersion} · ${rt.platform}`}
          <br />
          {`up ${fmtUptime(rt.uptimeSec)}`}
        </div>
      </div>
    </div>
  );
};

/** Project-map card: glyph + name + dir + description + files. */
const AreaCard = (props: { a: AppKnowledge["areas"][number] }): JSX.Element => {
  const a = props.a;
  const isFileArea = /\.(c|m)?[jt]sx?$/.test(a.dir);
  return (
    <div class="kt-area">
      <div class="kt-area-head">
        <span class="kt-glyph">{AREA_GLYPHS[a.name] ?? "▪"}</span>
        <div>
          <div class="kt-area-name">{a.name}</div>
          <div class="kt-area-dir">{isFileArea ? a.dir : `${a.dir}/`}</div>
        </div>
      </div>
      <div class="kt-area-desc">{a.description}</div>
      {a.files.length > 0 ? (
        <>
          <div class="kt-files">
            {a.files.map((f) => (
              <span
                class="kt-file"
                title="click to copy path"
                {...copyAttr(`${a.dir.replace(/\/+$/, "")}/${f}`)}
              >
                {f}
              </span>
            ))}
          </div>
          {a.fileCount > a.files.length ? (
            <div class="kt-more">{`+ ${String(a.fileCount - a.files.length)} more file${a.fileCount - a.files.length === 1 ? "" : "s"}`}</div>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

/** Full knowledge render: every panel for a knowledge payload. */
const Knowledge = (props: { k: AppKnowledge }): JSX.Element => {
  const k = props.k;
  const rt = k.runtime;

  // request anatomy — pipeline
  const pipeline = (): JSX.Element | null => {
    if (k.lifecycle.length === 0) return null;
    const stages = [...k.lifecycle].sort((x, y) => x.order - y.order);
    return (
      <Panel title="Request anatomy">
        <div>
          <div class="kt-pipeline">
            {stages.map(
              (st, i): JSX.Element => (
                <>
                  {i > 0 ? <span class="kt-arrow">→</span> : null}
                  <span
                    class={`kt-stage${st.name === "handler" || st.name === "beforeHandle" ? " hot" : ""}`}
                  >
                    {st.name}
                    {st.hookCount > 0 ? <i>{String(st.hookCount)}</i> : null}
                  </span>
                </>
              ),
            )}
            <span class="kt-arrow">⤷ on error →</span>
            <span class="kt-stage err-stage">error</span>
          </div>
          <div class="kt-anatomy-note">
            Every request flows through these stages in order. A pre-handler stage may halt the
            chain with a response (auth, rate limits, CORS); failures jump to the <b>error</b>{" "}
            stage. Numbers in a pill are registered hooks. Each stage shows up as a waterfall row
            when you open a request trace.
          </div>
        </div>
      </Panel>
    );
  };

  return (
    <>
      <Hero k={k} />
      <StatRow>
        <StatCard value={fmtNum(k.routes.length)} label="routes" sub="discovered" />
        <StatCard value={fmtNum(k.plugins.length)} label="plugins" sub="registered" />
        <StatCard value={fmtNum(k.lifecycle.length)} label="lifecycle" sub="stages" />
        <StatCard value={fmtNum(k.docs.length)} label="docs" sub="in repo" />
        <StatCard value={fmtNum(k.dbActions.length)} label="db patterns" sub="observed" />
      </StatRow>
      <Show when={(k.areas ?? []).length > 0}>
        <Panel title="Where things live" hint={<CountChip n={k.areas.length} />}>
          <div>
            <div class="kt-grid">
              <For each={k.areas}>{(a): JSX.Element => <AreaCard a={a} />}</For>
            </div>
            <div class="kt-callout">
              <span>⌘</span>
              <span>
                <b>Convention</b> — route files map 1:1 to URLs: health.get.ts → GET /health,
                users/[id].get.ts → GET /users/:id. Cross-cutting behavior lives in plugins
                (app.config.ts) and middleware; per-request work is composed inside handlers. Click
                any file to copy its path.
              </span>
            </div>
          </div>
        </Panel>
      </Show>
      {pipeline()}
      <Show when={k.plugins.length > 0}>
        <Panel title="Plugins" hint={<CountChip n={k.plugins.length} />}>
          <div class="kt-rows">
            {k.plugins.map(
              (p): JSX.Element => (
                <div class="kt-row">
                  <div class="t">
                    <span class="pill kind" style={{ "--kc": "var(--k-lifecycle)" }}>
                      {p.name}
                    </span>
                  </div>
                  <div class="d">{p.description}</div>
                </div>
              ),
            )}
          </div>
        </Panel>
      </Show>
      <Show when={k.routes.length > 0}>
        <Panel
          title="Routes"
          hint={<span class="hint">from the compiled manifest or the live router</span>}
          headExtra={<CountChip n={k.routes.length} />}
        >
          <table class="cursor-default">
            <thead>
              <tr>
                {["Method", "Path", "Source", "Behavior"].map((l) => (
                  <th>{l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {k.routes.map(
                (r): JSX.Element => (
                  <tr>
                    <td>
                      <MethodPill method={r.method} />
                    </td>
                    <td class="font-mono">
                      {r.path}
                      {r.isConstant ? (
                        <span class="pill kind" style={{ "--kc": "var(--k-cache)" }}>
                          constant
                        </span>
                      ) : null}
                    </td>
                    <td class="font-mono text-muted">
                      {r.file !== null && r.file !== "" ? r.file : r.description}
                    </td>
                    <td class="text-muted whitespace-normal">
                      {(r.usage ?? []).join(", ") || "—"}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </Panel>
      </Show>
      <Show
        when={k.dbActions.length > 0}
        fallback={
          <Panel title="Database activity">
            <EmptyState
              glyph="⛁"
              message="No DB queries observed in the retained window."
              hint="Wrap calls in ctx.debug.query(sql, params, fn) or debugQuery() — then every statement shows up here with timing and routes."
            />
          </Panel>
        }
      >
        <Panel
          title="Database activity"
          hint={
            <span class="hint">
              what each route actually does to the database · per-request detail lives in a trace's
              Queries tab
            </span>
          }
          headExtra={<CountChip n={k.dbActions.length} />}
        >
          <DbActivity actions={k.dbActions} />
        </Panel>
      </Show>
      <Show when={(k.spanKinds ?? []).length > 0}>
        <Panel title="Span kinds you can trace">
          <div class="kinds-row">
            {k.spanKinds.map(
              (kd): JSX.Element => (
                <span class="chip">
                  <i class="dot" style={{ background: kindColor(kd) }} />
                  {kd}
                  <span class="faint">{KIND_DESC[kd] ?? ""}</span>
                </span>
              ),
            )}
          </div>
        </Panel>
      </Show>
      <Show
        when={k.docs.length > 0}
        fallback={
          <Panel title="Documentation">
            <EmptyState
              glyph="📄"
              message="No markdown docs found."
              hint="Scanned docs/ and the project root. Point debugbar({ docsPaths }) at your docs to list them here."
            />
          </Panel>
        }
      >
        <Panel title="Documentation" hint={<CountChip n={k.docs.length} />}>
          <div class="kt-rows">
            {k.docs.map(
              (doc): JSX.Element => (
                <div class="kt-row">
                  <div class="t">
                    📄 <span class="font-mono">{doc.title}</span>
                  </div>
                  <div class="p" title="click to copy path" {...copyAttr(doc.path)}>
                    {doc.path}
                  </div>
                </div>
              ),
            )}
          </div>
        </Panel>
      </Show>
      <Show when={k.sdk !== null}>
        <Panel title="Published SDK">
          <SdkCard k={k} />
        </Panel>
      </Show>
      <Panel
        title="Environment"
        hint={<span class="hint">values shown for the standard debug keys only</span>}
      >
        <div class="kvs">
          <div>
            <span class="k">runtime</span>
            <span class="v">{`Bun ${rt.bunVersion} on ${rt.platform}/${rt.arch} (pid ${String(rt.pid)})`}</span>
          </div>
          {Object.keys(k.environment ?? {})
            .sort()
            .map(
              (key): JSX.Element => (
                <div>
                  <span class="k">{key}</span>
                  <span class="v font-mono">
                    {String((k.environment as Record<string, string>)[key])}
                  </span>
                </div>
              ),
            )}
        </div>
      </Panel>
    </>
  );
};

/** Database activity table with call bars and route chips. */
const DbActivity = (props: { actions: AppKnowledge["dbActions"] }): JSX.Element => {
  let maxCalls = 1;
  for (const q of props.actions) maxCalls = Math.max(maxCalls, q.calls);
  return (
    <table class="cursor-default">
      <thead>
        <tr>
          {["Action", "Table", "Calls", "Total ms", "Statement", "Seen in routes"].map((l) => (
            <th>{l}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.actions.map(
          (q): JSX.Element => (
            <tr>
              <td>
                <SqlPill action={q.action} />
              </td>
              <td class="font-mono">{q.table ?? "—"}</td>
              <td>
                <div class="bar-row">
                  <span class="mono num min-w-[26px]">{String(q.calls)}</span>
                  <span class="bar-track max-w-[90px]">
                    <span
                      class="bar-fill"
                      style={{ width: `${Math.max((q.calls / maxCalls) * 100, 4).toFixed(0)}%` }}
                    />
                  </span>
                </div>
              </td>
              <td class="font-mono text-muted">{fmtMs(q.totalMs)}</td>
              <td class="stmt">{q.statement}</td>
              <td>
                <div class="routes-cell">
                  {(q.routes ?? []).map((rr) => (
                    <span class="chip">{rr}</span>
                  ))}
                </div>
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
};

/** Published SDK card. */
const SdkCard = (props: { k: AppKnowledge }): JSX.Element => {
  const sdk = props.k.sdk;
  if (sdk === null) return null;
  return (
    <div>
      <div class="client-head">
        <span class="pill method get">SDK</span>
        <span class="font-mono">
          <b>{sdk.name}</b>
          {`@${sdk.version}`}
        </span>
        <span class="grow" />
        <button type="button" class="ghost mini" {...copyAttr(`${sdk.name}@${sdk.version}`)}>
          copy
        </button>
      </div>
      <div class="client-meta">
        <div>
          <span class="k">location</span>
          <span class="v font-mono">{sdk.location}</span>
        </div>
      </div>
      {sdk.files.length > 0 ? (
        <div class="client-files">
          {sdk.files.map((f) => (
            <code>{f}</code>
          ))}
        </div>
      ) : null}
      <div class="kt-anatomy-note">
        Generated with <b>ignex sdk</b> — frontend teams install it and get typed endpoints for
        every route above.
      </div>
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
    <Show when={payload()} keyed>
      {(res): JSX.Element => {
        const k = res.knowledge;
        if (k === null || k.runtime === undefined || k.runtime === null) {
          // Fallback: server-rendered markdown HTML (sanitized server-side).
          return (
            <div class="panel">
              <MarkdownFallback html={res.html} markdown={res.markdown} />
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
