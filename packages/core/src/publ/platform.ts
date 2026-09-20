/**
 * @fileoverview Public sub-barrel: platform (config, env, errors, jobs, mailer,
 * metrics, notifier, process-guards, scheduler) re-exported from the
 * `@ignex/core` entry (split from the barrel `src/index.ts` by section banner —
 * move-only; `export` statements verbatim).
 */

// ── platform ────────────────────────────────────────────────────
export type { Config, ConfigField, ConfigFieldType, ConfigSchema } from "../platform/config";
export { defineConfig } from "../platform/config";
export { env, envBool, envFloat, envInt, envJson, envSecret, loadEnv } from "../platform/env";
export type {
  DefineEnvOptions,
  EnvIssue,
  EnvIssueCode,
  EnvIssueSeverity,
  EnvResult,
  EnvSource,
  ValidateEnvOptions,
} from "../platform/env-config";
export {
  defineEnv,
  EnvError,
  EnvIssueCodes,
  envExampleFromSchema,
  validateEnv,
} from "../platform/env-config";
export {
  BadRequestError,
  ConflictError,
  errorToResponse,
  ForbiddenError,
  HTTPError,
  InternalError,
  InvalidCookieSignature,
  isHttpError,
  MethodNotAllowedError,
  NotFoundError,
  ParseError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "../platform/errors";
export type { Job, JobQueue, JobQueueOptions, ScheduleOptions } from "../platform/jobs";
export { createJobQueue, withRetry, withTimeout } from "../platform/jobs";
export type {
  DurableJobQueue,
  DurableJobQueueOptions,
  DurableJobSpec,
  JobHandler,
} from "../platform/jobs-durable";
export { createDurableJobQueue } from "../platform/jobs-durable";
export type {
  JobCompletionOptions,
  JobRetentionOptions,
  JobStatus,
  JobStore,
  StoredJob,
  StoreJobStoreOptions,
} from "../platform/jobs-store";
export {
  createFileJobStore,
  createSqliteJobStore,
  createStoreJobStore,
  newJobId,
  openStoreJobStore,
} from "../platform/jobs-store";
export {
  createMailer,
  type Mailer,
  type MailerOptions,
  type MailMessage,
  type MailSendResult,
} from "../platform/mailer";
export {
  type Counter,
  createMetrics,
  type Histogram,
  type Metrics,
  type MetricsOptions,
  type MetricsSnapshot,
} from "../platform/metrics";
export {
  createNotifier,
  type Notifier,
  type NotifierOptions,
  type NotifyUser,
} from "../platform/notifier";
export { installProcessGuards } from "../platform/process-guards";
export {
  createScheduler,
  type ScheduledJob,
  type Scheduler,
  type SchedulerOptions,
} from "../platform/scheduler";
