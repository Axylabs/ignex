import type { Document, Filter } from "mongodb";

export interface SearchConfig {
  /** Fields to search across. */
  searchFields: string[];
  /** Search term. */
  searchTerm: string;
  /** Loose per-character matching (`$regex` mode only). */
  fuzzy?: boolean;
  /** Case sensitivity (`$text` mode; `$regex` mode uses this too). */
  caseSensitive?: boolean;
  /** true → `$regex` search; false (default) → `$text` search. */
  useRegex?: boolean;
  /** `$text` search language (defaults to the server's default). */
  language?: string;
  /** `$text` diacritic sensitivity (default false → insensitive). */
  diacriticSensitive?: boolean;
  /**
   * When true, `textSearch` sorts by `searchScore` (textScore meta) instead of
   * the caller's sort. `$text`-mode only.
   */
  sortByScore?: boolean;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Build `$regex` search stages with an optional fuzzy (loose) pattern. */
export const buildRegexSearchStages = <T extends Document>(
  baseFilter: Filter<T>,
  searchConfig: SearchConfig,
): Document[] => {
  const { searchFields, searchTerm, fuzzy = false, caseSensitive = false } = searchConfig;
  const escaped = escapeRegex(searchTerm);
  const pattern = fuzzy ? escaped.split("").join(".*") : escaped;
  const $or = searchFields.map((field) => ({
    [field]: { $regex: pattern, $options: caseSensitive ? "" : "i" },
  }));
  return [{ $match: { ...baseFilter, $or } as Filter<T> }];
};

/** Build `$text` search stages with a `searchScore` meta field. */
export const buildTextSearchStages = <T extends Document>(
  baseFilter: Filter<T>,
  searchConfig: SearchConfig,
): Document[] => [
  {
    $match: {
      ...baseFilter,
      $text: {
        $search: searchConfig.searchTerm,
        ...(searchConfig.caseSensitive !== undefined && {
          $caseSensitive: searchConfig.caseSensitive,
        }),
        ...(searchConfig.language !== undefined && { $language: searchConfig.language }),
        ...(searchConfig.diacriticSensitive !== undefined && {
          $diacriticSensitive: searchConfig.diacriticSensitive,
        }),
      },
    } as Filter<T>,
  },
  { $addFields: { searchScore: { $meta: "textScore" } } },
];

/** Pick the search strategy based on `useRegex`. */
export const buildSearchStages = <T extends Document>(
  baseFilter: Filter<T>,
  searchConfig: SearchConfig,
): Document[] =>
  searchConfig.useRegex
    ? buildRegexSearchStages(baseFilter, searchConfig)
    : buildTextSearchStages(baseFilter, searchConfig);
