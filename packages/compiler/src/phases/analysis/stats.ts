/**
 * @fileoverview Analysis: route statistics (counters).
 */

import type { RouteDef } from "../../types";

export const countRoutes = (
  routes: readonly RouteDef[],
  predicate: (r: RouteDef) => boolean,
): number => routes.filter(predicate).length;

export const countStatic = (routes: readonly RouteDef[]): number =>
  countRoutes(routes, (r) => r.isStatic);
export const countDynamic = (routes: readonly RouteDef[]): number =>
  countRoutes(routes, (r) => r.isDynamic);
export const countConstant = (routes: readonly RouteDef[]): number =>
  countRoutes(routes, (r) => r.isConstantResponse);
