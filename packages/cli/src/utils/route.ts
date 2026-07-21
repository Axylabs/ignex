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

export function parseRouteInput(raw: string, methodFlag?: string): ParsedRoute {
  let input = raw
    .trim()
    .replace(/\.ts$/, "")
    .replace(/^\//, "");

  if (!input) {
    throw new Error("Route path is required.");
  }

  let method: RouteMethod = normalizeMethod(methodFlag) ?? "get";

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
    if (catchAll) {
      const name = catchAll[1]!;
      paramNames.push(name);
      return `*${name}`;
    }

    const param = segment.match(/^\[(.+)\]$/);
    if (param) {
      const name = param[1]!;
      paramNames.push(name);
      return `:${name}`;
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