/**
 * @fileoverview View registry — the single table mapping route ids to view
 * components, nav labels, keyboard shortcuts and live-refresh domains. The
 * topbar nav, the digit shortcuts and the stream dispatcher all derive from
 * this list, so adding a panel is one entry here plus one module.
 */

import type { Component } from "solid-js";

import type { Domain } from "../live";
import { AiView } from "./ai";
import { ClientsView } from "./clients";
import { DiagnosticsView } from "./diagnostics";
import { EventsView } from "./events";
import { HistoryView } from "./history";
import { JobsView } from "./jobs";
import { KtView } from "./kt";
import { LogDetailView } from "./log-detail";
import { LogsView } from "./logs";
import { MetricsView } from "./metrics";
import { RequestDetailView } from "./request-detail";
import { ErrorsView, RequestsView } from "./requests";
import { RoutesView } from "./routes";
import { StateView } from "./state";
import { SystemView } from "./system";

/** Contract every view component implements. */
export interface ViewDef {
  /** Route id (hash segment). */
  readonly id: string;
  /** Nav label. */
  readonly label: string;
  /** Digit shortcut ("" = none). */
  readonly key: string;
  /** Stream domain that triggers refetch (null = fetch-on-mount only). */
  readonly domain: Domain | null;
  /** The view component (mounted per route activation). */
  readonly component: Component;
}

/** All dashboard panels in display order. */
export const VIEWS: ViewDef[] = [
  { id: "requests", label: "Requests", key: "1", domain: "traces", component: RequestsView },
  { id: "errors", label: "Errors", key: "2", domain: "traces", component: ErrorsView },
  { id: "logs", label: "Logs", key: "3", domain: "logs", component: LogsView },
  { id: "history", label: "History", key: "4", domain: null, component: HistoryView },
  { id: "metrics", label: "Metrics", key: "5", domain: "metrics", component: MetricsView },
  { id: "diagnostics", label: "Diagnostics", key: "6", domain: null, component: DiagnosticsView },
  { id: "system", label: "System", key: "7", domain: "system", component: SystemView },
  { id: "state", label: "State", key: "8", domain: null, component: StateView },
  { id: "jobs", label: "Jobs", key: "9", domain: null, component: JobsView },
  { id: "events", label: "Events", key: "0", domain: "events", component: EventsView },
  { id: "routes", label: "Routes", key: "", domain: null, component: RoutesView },
  { id: "clients", label: "Clients", key: "", domain: null, component: ClientsView },
  { id: "ai", label: "AI", key: "", domain: null, component: AiView },
  { id: "kt", label: "KT", key: "", domain: null, component: KtView },
];

/** Views rendered as detail surfaces (no nav button of their own). */
export const DETAIL_VIEWS: Record<string, ViewDef> = {
  detail: {
    id: "detail",
    label: "Request",
    key: "",
    domain: "traces",
    component: RequestDetailView,
  },
  logDetail: { id: "logDetail", label: "Log", key: "", domain: "logs", component: LogDetailView },
};

/** Look up the component for a route view id. */
export const viewFor = (id: string): ViewDef | null => {
  const detail = DETAIL_VIEWS[id];
  if (detail !== undefined) return detail;
  return VIEWS.find((view) => view.id === id) ?? null;
};
