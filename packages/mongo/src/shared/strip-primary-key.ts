/** Remove the `_id` field from a document (returns the same object when absent). */
export const stripDocumentId = <T extends Record<string, unknown>>(doc: T): Omit<T, "_id"> => {
  if (!("_id" in doc)) return doc;
  const { _id, ...rest } = doc;
  void _id;
  return rest;
};

/** Remove an arbitrary primary key field from an object. */
export const stripPrimaryKey = <T extends Record<string, unknown>, K extends keyof T & string>(
  patch: T,
  key: K,
): Omit<T, K> => {
  if (!(key in patch)) return patch;
  const { [key]: _, ...rest } = patch;
  void _;
  return rest;
};
