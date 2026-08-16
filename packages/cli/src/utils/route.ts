export const ROUTE_METHODS = ["get", "post", "put", "patch", "del", "all"] as const;

export type RouteMethod = (typeof ROUTE_METHODS)[number];

export interface ParsedRoute {
  method: RouteMethod;
  file: string;
  routePath: string;
  paramNames: string[];
  isDynamic: boolean;
}

const METHOD_ALIASES: Record<string, RouteMethod> = {
  get: "get",
  post: "post",
  put: "put",
  patch: "patch",
  del: "del",
  delete: "del",
  all: "all",
};

function normalizeMethod(input: string | undefined): RouteMethod | undefined {
  if (!input) return undefined;
  return METHOD_ALIASES[input.toLowerCase()];
}

/**
 * Parse a route path (plus optional `--method`) into method/file/path.
 *
 * Accepts `users`, `users.del`, `api/users.get.ts`, etc. A trailing dot-method
 * suffix wins over the `--method` flag.
 *
 * @param raw - The route path input.
 * @param methodFlag - Optional explicit method from `--method`.
 * @returns The parsed route (method, file name, path, param names).
 * @throws When `raw` is empty or `methodFlag` is not a known method.
 */
export function parseRouteInput(raw: string, methodFlag?: string): ParsedRoute {
  let input = raw.trim().replace(/\.ts$/, "").replace(/^\//, "");

  if (!input) {
    throw new Error("Route path is required.");
  }

  // Reject path traversal / absolute segments so `ignex route ../../x` (or via
  // the MCP route tool) can't write outside the routes dir — mirrors the
  // `create` command guard. `..` is rejected only as a whole segment so
  // legitimate names like `foo..bar` still parse.
  if (
    input.split("/").some((segment) => segment === "..") ||
    input.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(input)
  ) {
    throw new Error(
      `Invalid route path: "${raw}". Route paths must stay inside the routes directory.`,
    );
  }

  let method: RouteMethod;
  if (methodFlag !== undefined) {
    const normalized = normalizeMethod(methodFlag);
    if (!normalized) {
      throw new Error(
        `Invalid method: "${methodFlag}". Expected one of: ${ROUTE_METHODS.join(", ")}.`,
      );
    }
    method = normalized;
  } else {
    method = "get";
  }

  const lastDot = input.lastIndexOf(".");
  if (lastDot > 0) {
    const maybeMethod = input.slice(lastDot + 1);
    const normalized = normalizeMethod(maybeMethod);

    if (normalized) {
      method = normalized;
      input = input.slice(0, lastDot);
    }
  }

  if (!input) {
    input = "index";
  }

  const file = `${input}.${method}.ts`;

  const segments = input === "index" ? [] : input.split("/").filter(Boolean);
  const paramNames: string[] = [];

  const pathSegments = segments.map((segment) => {
    const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
    const catchName = catchAll?.[1];
    if (catchName) {
      paramNames.push(catchName);
      return `*${catchName}`;
    }

    const param = segment.match(/^\[(.+)\]$/);
    const paramName = param?.[1];
    if (paramName) {
      paramNames.push(paramName);
      return `:${paramName}`;
    }

    return segment;
  });

  const routePath = `/${pathSegments.join("/")}`;

  return {
    method,
    file,
    routePath,
    paramNames,
    isDynamic: paramNames.length > 0,
  };
}
