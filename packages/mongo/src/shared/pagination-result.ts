export interface AggregationMeta {
  executionTimeMs?: number;
  indexesUsed?: string[];
}

/** Uniform pagination result shape (shared by all list/paginate/search ops). */
export interface PaginationResult<T> {
  data: T[];
  totalCount: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  currentPage: number;
  totalPages: number;
  aggregationMeta?: AggregationMeta;
}

export const buildPaginationResult = <T>(
  data: T[],
  totalCount: number,
  page: number,
  limit: number,
): PaginationResult<T> => {
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / limit);
  return {
    data,
    totalCount,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    currentPage: page,
    totalPages,
  };
};
