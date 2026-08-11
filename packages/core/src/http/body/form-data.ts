/**
 * @fileoverview Pure FormData accessors + shape converters.
 *
 * Bun exposes `FormData.forEach/get/getAll` only in newer runtimes; these
 * helpers feature-detect them so body parsing works on any Bun 1.4 build and
 * keep the string↔File semantics identical regardless of runtime.
 */

const forEachFormDataEntry = (fd: FormData, cb: (value: unknown, key: string) => void): void => {
  const forEach = (fd as unknown as { forEach?: unknown }).forEach;

  if (typeof forEach === "function") {
    (forEach as (cb: (value: unknown, key: string) => void) => void).call(fd, cb);
  }
};

const getFormDataEntry = (fd: FormData, name: string): unknown => {
  const get = (fd as unknown as { get?: unknown }).get;

  if (typeof get !== "function") {
    return null;
  }

  return (get as (name: string) => unknown).call(fd, name);
};

const getAllFormDataEntries = (fd: FormData, name: string): unknown[] => {
  const getAll = (fd as unknown as { getAll?: unknown }).getAll;

  if (typeof getAll !== "function") {
    return [];
  }

  const values = (getAll as (name: string) => unknown).call(fd, name);

  return Array.isArray(values) ? values : [];
};

const isFile = (value: unknown): value is File =>
  typeof File !== "undefined" && value instanceof File;

/** FormData → flat `Record<string, string>` (files collapse to their name). */
export function formDataToRecord(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};

  forEachFormDataEntry(fd, (value, key) => {
    if (typeof value === "string") {
      out[key] = value;
    } else if (isFile(value)) {
      out[key] = value.name;
    }
  });

  return out;
}

/** FormData → object, accumulating duplicate keys into arrays. */
export function formDataToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  forEachFormDataEntry(fd, (value, key) => {
    const existing = out[key];

    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  });

  return out;
}

export { forEachFormDataEntry, getAllFormDataEntries, getFormDataEntry, isFile };
