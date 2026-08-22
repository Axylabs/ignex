/**
 * Shared type-level utilities (no runtime code).
 */

/**
 * Strip index-signature keys (e.g. `Document`'s `[key: string]`) from a type,
 * leaving only its explicitly declared fields.
 */
export type RemoveIndexSignature<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** GeoJSON Point as stored in MongoDB (used by `s.geoPoint()` and `$geoNear`). */
export type GeoPoint = {
  type: "Point";
  coordinates: [number, number];
};
