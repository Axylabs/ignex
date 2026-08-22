/**
 * Logical → physical collection-name resolution.
 *
 * A collection is declared by a logical name; the physical name in MongoDB may
 * differ via a `collectionPrefix` (namespacing) or explicit per-collection
 * `collectionPhysicalNames` overrides. This module owns that mapping so the
 * rest of the ORM can always ask "what physical name does this logical name
 * map to?" via `createResolveCollectionName`.
 */
export const DEFAULT_COLLECTION_PREFIX_SEPARATOR = "-";
/** Hard ceiling on MongoDB collection name length (server-enforced too). */
export const MAX_MONGODB_COLLECTION_NAME_BYTES = 255;

export interface ResolveCollectionConfig {
  /** Prepended to every physical name: `prefix + separator + logical`. */
  collectionPrefix?: string;
  /** Joins `collectionPrefix` and the logical name (default `-`). */
  collectionPrefixSeparator?: string;
  /** Per-logical-name physical overrides; wins over the prefix rule. */
  collectionPhysicalNames?: Partial<Record<string, string>>;
}

/**
 * Resolve a logical collection name → physical collection name.
 *  - explicit `collectionPhysicalNames[logical]` wins
 *  - otherwise `prefix + separator + logical`
 *  - no prefix → identity
 */
export const createResolveCollectionName = (config: ResolveCollectionConfig) => {
  const sep = config.collectionPrefixSeparator ?? DEFAULT_COLLECTION_PREFIX_SEPARATOR;
  return (logical: string): string => {
    const override = config.collectionPhysicalNames?.[logical];
    if (override) return override;
    const prefix = config.collectionPrefix;
    if (!prefix) return logical;
    return `${prefix}${sep}${logical}`;
  };
};
