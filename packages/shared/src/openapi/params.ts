/**
 * @fileoverview OpenAPI parameter shaping — map schema parts (params, query,
 * headers, cookie) onto `ParameterDoc`s, de-duplicated by `in:name`.
 */

import { isRecord, propertiesOf, requiredOf, stripId } from "./schema";
import type { ParameterDoc, ParameterLocation, RouteDefinition } from "./types";

const toParameter = (
  name: string,
  location: ParameterLocation,
  propSchema: unknown,
  required: boolean,
): ParameterDoc => {
  const prop = isRecord(propSchema) ? propSchema : {};
  const param: ParameterDoc = {
    name,
    in: location,
    required,
    schema: stripId(propSchema),
  };
  if (typeof prop.description === "string") param.description = prop.description;
  if (prop.deprecated === true) param.deprecated = true;
  if ("example" in prop) param.example = prop.example;
  return param;
};

const parametersFrom = (
  schema: unknown,
  location: ParameterLocation,
  requiredOverride?: readonly string[],
): readonly ParameterDoc[] => {
  const properties = propertiesOf(schema);
  if (properties === undefined) return [];
  const required = new Set(requiredOf(schema).concat(requiredOverride ?? []));
  return Object.entries(properties).map(([name, propSchema]) =>
    toParameter(name, location, propSchema, location === "path" || required.has(name)),
  );
};

/** Path params fallback when no `schema.params` is attached. */
const pathParamFallback = (route: RouteDefinition): readonly ParameterDoc[] => {
  if (route.paramNames == null || route.paramNames.length === 0) return [];
  return route.paramNames.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
};

/** De-duplicate parameters by `in:name` (first occurrence wins). */
const mergeParameters = (lists: readonly (readonly ParameterDoc[])[]): readonly ParameterDoc[] => {
  const seen = new Set<string>();
  const merged: ParameterDoc[] = [];
  for (const list of lists) {
    for (const param of list) {
      const key = `${param.in}:${param.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(param);
    }
  }
  return merged;
};

/** All parameters for a route: path + query + headers + cookie, de-duplicated. */
export const parametersFor = (route: RouteDefinition): readonly ParameterDoc[] => {
  const { schema } = route;
  const pathParams = hasPropertiesFor(schema?.params)
    ? parametersFrom(schema?.params, "path", route.paramNames)
    : pathParamFallback(route);

  return mergeParameters([
    pathParams,
    parametersFrom(schema?.query, "query"),
    parametersFrom(schema?.headers, "header"),
    parametersFrom(schema?.cookie, "cookie"),
  ]);
};

/** `schema.params` carries a `properties` record. */
const hasPropertiesFor = (params: unknown): boolean => propertiesOf(params) !== undefined;
