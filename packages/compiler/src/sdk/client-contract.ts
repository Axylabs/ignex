/**
 * @fileoverview Shared typed-client call signatures for build artifacts and packages.
 */

/** TypeScript declarations shared by every generated HTTP client. */
export const CLIENT_TYPE_CONTRACT = `

type IgnexResponse<Route> = Route extends { response: infer R } ? R : unknown;

type IgnexRouteHandler<Route> =
  Route extends { params: infer P; query: infer Q; body: infer B }
    ? (params: P, query: Q, body: B, init?: RequestInit) => Promise<IgnexResponse<Route>>
    : Route extends { params: infer P; query: infer Q }
      ? (params: P, query: Q, init?: RequestInit) => Promise<IgnexResponse<Route>>
      : Route extends { query: infer Q; body: infer B }
        ? (query: Q, body: B, init?: RequestInit) => Promise<IgnexResponse<Route>>
        : Route extends { params: infer P; body: infer B }
          ? (params: P, body: B, init?: RequestInit) => Promise<IgnexResponse<Route>>
          : Route extends { params: infer P }
            ? (params: P, init?: RequestInit) => Promise<IgnexResponse<Route>>
            : Route extends { query: infer Q }
              ? (query: Q, init?: RequestInit) => Promise<IgnexResponse<Route>>
              : Route extends { body: infer B }
                ? (body: B, init?: RequestInit) => Promise<IgnexResponse<Route>>
                : (init?: RequestInit) => Promise<IgnexResponse<Route>>;

export type IgnexClient = {
  [Path in keyof IgnexRoutes]: {
    [Method in keyof IgnexRoutes[Path]]: IgnexRouteHandler<IgnexRoutes[Path][Method]>;
  };
};
`;
