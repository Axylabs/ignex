/**
 * Normalize a Mongo connection string so performance/reliability defaults are
 * explicit (mirrors sdk-db `normalizeMongoUrl`):
 *  - retryWrites=false unless already set (keeps semantics predictable)
 *  - w=1 unless another write concern is present
 *  - directConnection=true for single-host non-replicaSet URIs
 */
export const normalizeMongoUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has("retryWrites")) url.searchParams.set("retryWrites", "false");
    const hasWriteConcern =
      url.searchParams.has("w") ||
      url.searchParams.has("wtimeoutMS") ||
      url.searchParams.has("writeConcern");
    if (!hasWriteConcern) url.searchParams.set("w", "1");
    const hostCount = url.hostname.split(",").length;
    if (
      hostCount === 1 &&
      !url.searchParams.has("replicaSet") &&
      !url.searchParams.has("directConnection")
    ) {
      url.searchParams.set("directConnection", "true");
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
};
