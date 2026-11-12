/**
 * @fileoverview `GET /api/overview` — one consistent application-health snapshot
 * for the dashboard landing page. All analysis is delegated to the pure insight
 * engine so the same findings can feed the AI summary without another ruleset.
 */

import { buildOverview } from "../../insights";
import { analyzeSamples } from "../../leaks";
import { json } from "../../respond";
import type { HandlerDeps } from "../types";

/** Build the application-overview endpoint for one debugbar instance. */
export const createOverviewHandler = (deps: HandlerDeps) => (): Response => {
  const diagnostics = analyzeSamples(deps.state.profiler.stats().samples);
  const persistence = deps.state.sink?.status();
  return json(
    buildOverview({
      traces: deps.state.store.list(),
      metrics: deps.state.metrics.snapshot(),
      diagnostics,
      logs: deps.state.logs.stats(),
      activeRequests: deps.state.active.size,
      systemSamples: diagnostics.samplesAnalyzed,
      persistence: {
        enabled: persistence?.available ?? false,
        error: persistence?.error ?? null,
      },
    }),
  );
};
