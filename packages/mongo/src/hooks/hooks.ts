import type { Document, Filter } from "mongodb";

/**
 * Lifecycle hooks — the ORM's middleware system. Hooks are declared per
 * collection and run around the corresponding CRUD operation.
 */
export type HookName =
  | "beforeCreate"
  | "afterCreate"
  | "beforeUpdate"
  | "afterUpdate"
  | "beforeDelete"
  | "afterDelete"
  | "afterRead";

export interface HookContext<TSchema = Document> {
  collection: string;
  doc?: TSchema;
  docs?: TSchema[];
  filter?: Filter<Document>;
  options?: Record<string, unknown>;
}

export type Hook<TSchema = Document> = (ctx: HookContext<TSchema>) => void | Promise<void>;

export type HookMap<TSchema = Document> = Partial<Record<HookName, Hook<TSchema>>>;

/** Registry keyed by logical collection name. */
export type HooksRegistry = Record<string, HookMap>;

export const HOOK_NAMES: readonly HookName[] = [
  "beforeCreate",
  "afterCreate",
  "beforeUpdate",
  "afterUpdate",
  "beforeDelete",
  "afterDelete",
  "afterRead",
];

/** True when a hook is registered for the given collection + name. */
export const hasHook = (
  registry: HooksRegistry | undefined,
  collection: string,
  name: HookName,
): boolean => registry?.[collection]?.[name] !== undefined;

/** Run a single hook (no-op when the collection has none registered). */
export const runHooks = async <TSchema = Document>(
  registry: HooksRegistry | undefined,
  collection: string,
  name: HookName,
  ctx: HookContext<TSchema>,
): Promise<void> => {
  const hooks = registry?.[collection];
  const hook = hooks?.[name];
  if (!hook) return;
  await hook(ctx as HookContext<Document>);
};
