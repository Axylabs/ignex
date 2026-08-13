// Server-only app config: no plugins, no lifecycle/hooks. The compiler must
// prove there are no per-request hooks so routes can still specialize/hoist
// (a bare `hasAppConfig` must NOT force the full-context path).
export const server = {
  port: 3000,
};
