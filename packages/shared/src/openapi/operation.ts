/**
 * @fileoverview OpenAPI operation shaping — request body, per-status
 * responses, and the full operation object for a route.
 */

import { parametersFor } from "./params";
import { isStatusMap, operationIdFor, stripId, tagForPath, toOpenApiPath } from "./schema";
import type { ParameterDoc, RouteDefinition } from "./types";

const requestBodyFor = (
  schema: unknown,
  usesBody: boolean,
): Record<string, unknown> | undefined => {
  if (schema == null && !usesBody) return undefined;
  return {
    required: schema != null,
    content: {
      "application/json": { schema: schema == null ? { type: "object" } : stripId(schema) },
    },
  };
};

const STATUS_DESCRIPTIONS: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "203": "Non-Authoritative Information",
  "204": "No Content",
  "205": "Reset Content",
  "206": "Partial Content",
  "300": "Multiple Choices",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "304": "Not Modified",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "406": "Not Acceptable",
  "407": "Proxy Authentication Required",
  "408": "Request Timeout",
  "409": "Conflict",
  "410": "Gone",
  "411": "Length Required",
  "412": "Precondition Failed",
  "413": "Payload Too Large",
  "414": "URI Too Long",
  "415": "Unsupported Media Type",
  "416": "Range Not Satisfiable",
  "417": "Expectation Failed",
  "418": "I'm a Teapot",
  "421": "Misdirected Request",
  "422": "Unprocessable Entity",
  "423": "Locked",
  "424": "Failed Dependency",
  "425": "Too Early",
  "426": "Upgrade Required",
  "428": "Precondition Required",
  "429": "Too Many Requests",
  "431": "Request Header Fields Too Large",
  "451": "Unavailable For Legal Reasons",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
  "505": "HTTP Version Not Supported",
  "507": "Insufficient Storage",
  "508": "Loop Detected",
  "511": "Network Authentication Required",
};

const statusDescription = (status: string): string => STATUS_DESCRIPTIONS[status] ?? "Response";

const responsesFor = (responseSchema: unknown): Record<string, unknown> => {
  if (responseSchema == null) {
    return { "200": { description: "Successful response" } };
  }
  if (isStatusMap(responseSchema)) {
    return Object.fromEntries(
      Object.entries(responseSchema).map(([status, schema]) => [
        status,
        {
          description: statusDescription(status),
          content: { "application/json": { schema: stripId(schema) } },
        },
      ]),
    );
  }
  return {
    "200": {
      description: "Successful response",
      content: { "application/json": { schema: stripId(responseSchema) } },
    },
  };
};

/** One route's operation: method, converted path, and the operation object. */
export interface OperationModel {
  method: string;
  openApiPath: string;
  operation: Record<string, unknown>;
}

/** Build the operation object for a route (parameters, body, responses, tags). */
export const operationFor = (route: RouteDefinition): OperationModel => {
  const openApiPath = toOpenApiPath(route.path);
  const { schema, detail } = route;

  const parameters: readonly ParameterDoc[] = parametersFor(route);

  const operation: Record<string, unknown> = {
    operationId: operationIdFor(route.method, openApiPath),
    ...detail,
    responses: responsesFor(schema?.response),
  };

  // Management grouping: tag each operation by its first path segment
  // (`/api/orders` → `api`, `/auth/login` → `auth`) so docs UIs group routes
  // by resource. An explicit `detail.tags` (including an empty array, meaning
  // "no tags") always wins; the top-level `tags` array is derived from the
  // operations (see `collectTags`).
  if (!Array.isArray(detail?.tags)) {
    operation.tags = [tagForPath(openApiPath)];
  }

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  const requestBody = requestBodyFor(schema?.body, route.usesBody === true);
  if (requestBody) {
    operation.requestBody = requestBody;
  }

  return { method: route.method.toLowerCase(), openApiPath, operation };
};
