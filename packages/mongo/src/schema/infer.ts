import type { Decimal128, ObjectId } from "mongodb";
import type { GeoPoint } from "../shared/types.ts";
import type { ObjectField, SchemaType } from "./types.ts";

/**
 * Type-level inference from the schema DSL → the document's TypeScript type.
 *
 *   type User = InferDoc<typeof userSchema>;
 *
 * `optional`/`default` fields become `T | undefined`; everything else is required.
 */
export type InferField<T extends SchemaType> = T extends { kind: "string" }
  ? string
  : T extends { kind: "number" }
    ? number
    : T extends { kind: "boolean" }
      ? boolean
      : T extends { kind: "date" }
        ? Date
        : T extends { kind: "objectId" }
          ? ObjectId
          : T extends { kind: "double" }
            ? number
            : T extends { kind: "long" }
              ? number
              : T extends { kind: "decimal" }
                ? Decimal128
                : T extends { kind: "geoPoint" }
                  ? GeoPoint
                  : T extends { kind: "array" }
                    ? InferField<T["items"]>[]
                    : T extends { kind: "object" }
                      ? InferObject<Extract<T, ObjectField>>
                      : T extends { kind: "enum" }
                        ? T["values"][number]
                        : T extends { kind: "null" }
                          ? null
                          : T extends { kind: "any" }
                            ? unknown
                            : T extends { kind: "raw" }
                              ? unknown
                              : never;

/** True when a field is optional (`.optional()`) or defaulted (`.default(v)`). */
type IsOptionalProp<T extends SchemaType> = T["flags"]["optional"] extends true
  ? true
  : T["flags"]["hasDefault"] extends true
    ? true
    : false;

/**
 * Optional/default fields become *optional keys* (`qty?: number`) rather than
 * required-but-`| undefined`, so documents can be built without them.
 */
type InferObject<T extends ObjectField> = {
  [K in keyof T["properties"] as IsOptionalProp<T["properties"][K]> extends true
    ? never
    : K]: InferField<T["properties"][K]>;
} & {
  [K in keyof T["properties"] as IsOptionalProp<T["properties"][K]> extends true
    ? K
    : never]?: InferField<T["properties"][K]>;
};

export type InferDoc<T extends ObjectField> = InferObject<T>;
