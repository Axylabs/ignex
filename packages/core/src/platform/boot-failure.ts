/**
 * @fileoverview Boot-failure reporting — the startup-phase composition of the
 * fault engine.
 *
 * Everything shared (classification, rendering, print-once) lives in
 * `fault.ts` / `fault-report.ts`; this module adds what only a boot failure
 * has: the plugin that failed, and the dotenv state to check first.
 *
 * The generated server bootstrap and the interpreted plugin registry both call
 * {@link reportPluginBootFailure}, so a plugin that throws at boot fails the
 * same way in both execution paths.
 */

import { type EnvFileReport, readEnvFileReport } from "./env-report";
import { toFault } from "./fault";
import { isFaultReported, renderFault, reportFault } from "./fault-report";
import type { Fault } from "./fault-vocabulary";

/** A boot failure: the plugin, its fault, and the configuration state. */
export interface BootFailureReport {
  /** The plugin (or startup step) that failed. */
  readonly plugin: string;
  /** The classified failure. */
  readonly fault: Fault;
  /** The dotenv state the report lists. */
  readonly env: EnvFileReport;
}

/** Options for {@link explainBootFailure}. */
export interface ExplainBootFailureOptions {
  /** Directory the dotenv files are resolved against. Default `process.cwd()`. */
  readonly cwd?: string;
}

/** The first line of a boot report. */
export const bootFailureTitle = (plugin: string): string =>
  `ignex boot failed — plugin "${plugin}" could not start`;

/**
 * Prepend the "there is no `.env`" advice to a fault's hints.
 *
 * Only the boot path knows the dotenv state (a request-time report reads no
 * files), so this is the one hint that cannot live in the shared classifier.
 */
const withEnvHint = (fault: Fault, env: EnvFileReport): Fault => {
  if (env.present.length > 0) return fault;
  const example = env.examples[0];
  const hint =
    example === undefined
      ? `No ${env.candidates[0]} file in ${env.cwd} — the app is using the ambient environment only.`
      : `No ${env.candidates[0]} file in ${env.cwd} — start from the example: cp ${example} ${env.candidates[0]}`;
  return { ...fault, hints: [hint, ...fault.hints].slice(0, 4) };
};

/**
 * Classify a plugin/startup throw and attach the dotenv state.
 *
 * Pure apart from reading the dotenv files next to `cwd` — no printing, no
 * throwing, so it is directly testable.
 *
 * @param plugin - Name of the plugin (or startup step) that failed.
 * @param error - The value the plugin threw.
 * @param options - Working directory for the dotenv lookup.
 * @returns The boot report.
 */
export const explainBootFailure = (
  plugin: string,
  error: unknown,
  options: ExplainBootFailureOptions = {},
): BootFailureReport => {
  const env = readEnvFileReport(options.cwd ?? process.cwd());
  return { plugin, fault: withEnvHint(toFault(error), env), env };
};

/**
 * Render a boot report as the block printed to stderr.
 *
 * @param report - The boot report.
 * @returns The printable block.
 */
export const renderBootFailure = (report: BootFailureReport): string =>
  renderFault(report.fault, { title: bootFailureTitle(report.plugin), env: report.env });

/**
 * Report a plugin boot failure and return the error the caller should throw.
 *
 * Prints the configuration-first report once, then returns a compact,
 * cause-free error — the raw driver object is deliberately NOT attached as
 * `cause`, because Bun's uncaught-error printer expands a driver's enumerable
 * object graph into hundreds of lines that say nothing about the fix.
 * `IGNEX_DEBUG=1` prints that object here instead.
 *
 * Idempotent: an error whose report was already printed (or an
 * `AggregateError` whose children all were) returns without printing twice, so
 * the plugin registry and the app factory can both call it for one failure.
 *
 * @param plugin - Name of the plugin (or startup step) that failed.
 * @param error - The value the plugin threw.
 * @returns The compact error the caller should throw.
 */
export const reportPluginBootFailure = (plugin: string, error: unknown): Error => {
  const children = error instanceof AggregateError ? [...error.errors] : [];
  if (children.length > 0 && children.every((child) => isFaultReported(child))) {
    return new Error(
      `[ignex] ${children.length} plugin(s) failed to initialize — see the reports above`,
    );
  }

  const env = readEnvFileReport(process.cwd());
  return reportFault(error, {
    fault: withEnvHint(toFault(error), env),
    title: bootFailureTitle(plugin),
    env,
    label: `[ignex] plugin boot failed for ${plugin}`,
  });
};
