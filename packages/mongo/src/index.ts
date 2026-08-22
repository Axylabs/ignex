/**
 * ninox — schema-first MongoDB ORM with DataLoader-batched relations,
 * read-through query caching, in-flight dedup, `$facet` pagination, and a
 * fluent query builder. Architectural.
 */

export type {
  HotCacheMode,
  HotCacheOptions,
  HotCacheStats,
  HotCollectionRef,
  HotQueryAccessor,
  HotQueryConfig,
  HotQueryStats,
} from "./cache/hot-cache/index.ts";
/* --------------------------- perf: hot cache ----------------------------- */
export { createHotCache, HotCache } from "./cache/hot-cache/index.ts";
/* --------------------------- perf: cache --------------------------------- */
export { cacheCollectionKey, InFlight, QueryCache } from "./cache/index.ts";
export type { QueryCacheOptions, QueryCacheStats } from "./cache/query-cache.ts";
export type { MongoCapabilities, MongoCapabilitiesStore } from "./capabilities.ts";
export { createMongoCapabilitiesStore, probeMongoCapabilities } from "./capabilities.ts";
export type { ErrorContext } from "./errors/index.ts";
/* ------------------------------ errors ---------------------------------- */
export {
  AppError,
  BadRequest,
  DomainError,
  ERROR_HTTP_STATUS,
  httpStatusForError,
  InfraError,
  isAppError,
  isDomainError,
  isInfraError,
  isMappedMongoError,
  isMongoDuplicateKeyError,
  isMongoTransientError,
  mapMongoDriverError,
  serializeError,
  TRANSIENT_MONGO_ERROR_CODES,
} from "./errors/index.ts";
export type { GracefulTransactionOptions, MongoTransactionRunner } from "./graceful-transaction.ts";
/* --------------------------- transactions ------------------------------- */
export { withGracefulMongoTransaction } from "./graceful-transaction.ts";
export type { Hook, HookContext, HookMap, HookName, HooksRegistry } from "./hooks/hooks.ts";
/* --------------------------- hooks -------------------------------------- */
export { HOOK_NAMES, runHooks } from "./hooks/hooks.ts";
export type { DataLoaderOptions } from "./loader/dataloader.ts";
/* --------------------------- perf: loader ------------------------------- */
export { canonicalKey, DataLoader } from "./loader/dataloader.ts";
export type {
  MigrationContext,
  MigrationModule,
  MongoMigrationRunner,
  MongoMigrationRunnerOptions,
} from "./migrations/index.ts";
/* --------------------------- migrations --------------------------------- */
export { createMongoMigrationRunner } from "./migrations/index.ts";
export type { RetryOptions } from "./mongo-helpers.ts";
/* --------------------------- mongo helpers ------------------------------ */
export { withRetry, withTransaction } from "./mongo-helpers.ts";
export type { QueryBuilderContext } from "./query-builder/query-builder.ts";
/* --------------------------- query builder ------------------------------ */
export { QueryBuilder } from "./query-builder/query-builder.ts";
export type { PopulateOptions } from "./relation/populate.ts";
export type {
  BelongsToRelation,
  HasManyRelation,
  JoinedFields,
  ManyToManyRelation,
  RelationDef,
  RelationDefBase,
  ValidRelation,
} from "./relation/relation.ts";
/* --------------------------- perf: relations ---------------------------- */
export { belongsTo, hasMany, manyToMany } from "./relation/relation.ts";
export type { Repository, RepositoryOptions } from "./repository/repository.ts";
/* --------------------------- repository -------------------------------- */
export { createRepository } from "./repository/repository.ts";
export type {
  AnyField,
  ArrayField,
  BooleanField,
  Chainable,
  CollectionMap,
  CollectionName,
  CollectionValue,
  DateField,
  DecimalField,
  DoubleField,
  DriftIssue,
  DriftIssueCode,
  DriftMode,
  EnumField,
  FieldFlags,
  FieldMeta,
  GeoPointField,
  InferDoc,
  InferField,
  IntegerField,
  LongField,
  MongoJsonSchema,
  NamedCollection,
  NamedCollectionDefinition,
  NamedObjectField,
  NullField,
  NumberBounds,
  NumberField,
  ObjectField,
  ObjectIdField,
  RawField,
  SchemaType,
  StringField,
} from "./schema/index.ts";
/* ------------------------------ schema DSL ------------------------------ */
export {
  defineCollection,
  defineCollections,
  optional,
  s,
  toMongoSchema,
  toMongoValidator,
  validateDoc,
  withDefault,
} from "./schema/index.ts";
export type {
  DateRangeConfig,
  GroupByConfig,
  LookupConfig,
  PipelineCustomization,
} from "./service/aggregation/index.ts";
export type { SearchConfig } from "./service/aggregation-pipeline.ts";
export type { AggregationStages } from "./service/aggregation-stages.ts";
export { createResolveCollectionName } from "./service/collection-name.ts";
/* --------------------------- connection -------------------------------- */
export { normalizeMongoUrl } from "./service/connection-uri.ts";
export type {
  CrudOps,
  FindQueryOptions,
  InsertInput,
  TimestampsByCollection,
  VersionedUpdateResult,
} from "./service/crud/index.ts";
export type {
  CacheInvalidationRef,
  CollectionManager,
  DbHealthResult,
  HealthReport,
  MongoService,
  MongoServiceConfig,
} from "./service/index.ts";
/* ------------------------------ service --------------------------------- */
export { CacheInvalidator, createMongoService } from "./service/index.ts";
export type {
  CursorPage,
  CursorPaginationConfig,
  PaginationConfig,
} from "./service/pagination/index.ts";
export type { PipelineBuilder } from "./service/pipeline-builder.ts";
export type {
  AccumulatorResult,
  AccumulatorSpec,
  Added,
  ExprResult,
  FacetOutput,
  FacetPipelineStage,
  FacetSpec,
  FieldName,
  FieldRef,
  ForeignDocOf,
  GeoNearOutput,
  GeoNearSpec,
  Grouped,
  GroupSpec,
  LookupJoinedFor,
  LookupParams,
  LookupSpecFor,
  PipelineStage,
  Projected,
  Projection,
  SortKeys,
  Unsetted,
  UnwindSpec,
  Unwound,
} from "./service/pipeline-types.ts";
export type {
  QueryOptions,
  ResolvedQueryOptions,
} from "./service/query-options.ts";
export type { SyncIndexesResult } from "./service/schema-ops.ts";
export type { UpdateInput, UpdateOperators } from "./service/update-types.ts";
export type { FilterInput } from "./shared/filter-types.ts";
export type {
  AggregationMeta,
  CrudListQuery,
  GeoPoint,
  KeysetCursor,
  NormalizedPagination,
  PaginationResult,
  RemoveIndexSignature,
} from "./shared/index.ts";
/* ------------------------------ shared ---------------------------------- */
export {
  buildKeysetFilter,
  buildMongoActiveFilter,
  buildPaginationResult,
  DEFAULT_FIND_LIMIT,
  DEFAULT_MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  MAX_BATCH_OPS,
  mergeMongoActiveFilter,
  mergeMongoFilters,
  normalizePageLimit,
  stripDocumentId,
  stripPrimaryKey,
} from "./shared/index.ts";
export type { MongoToolkit, MongoToolkitOptions } from "./toolkit.ts";
/* --------------------------- toolkit ------------------------------------ */
export { createMongoToolkit } from "./toolkit.ts";
/* ------------------------------ types ----------------------------------- */
export type {
  CollectionDefinition,
  CollectionDoc,
  CollectionLike,
  CollectionTimestamps,
  DBClientDefinition,
  DbClientsDefinition,
  ExtractCollectionNames,
  ExtractCollectionType,
  ExtractDbNames,
  IndexSpec,
} from "./types.ts";
export type { CacheOptions, LogFn, LoggerLike, LogLevel, LRUOptions } from "./utils/index.ts";
/* ------------------------------ utils ----------------------------------- */
export {
  createCachedAsyncFactory,
  createCachedFactory,
  createConsoleLogger,
  createNoopLogger,
  hashString,
  LRU,
  sleep,
  sleepJittered,
  stableHash,
  stableStringify,
  withTimeout,
} from "./utils/index.ts";
