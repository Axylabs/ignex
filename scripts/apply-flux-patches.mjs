import { readFileSync, writeFileSync, existsSync } from "node:fs";

function replaceInFile(file, search, replacement, options = {}){
  if (!existsSync(file)) {
    console.warn(`Skip missing file: ${file}`);
    return;
  }

  let content = readFileSync(file, "utf8");

  if (options.regex) {
    if (!search.test(content)) {
      console.warn(`Pattern not found in ${file}`);
      return;
    }

    content = content.replace(search, replacement);
  } else {
    if (!content.includes(search)) {
      console.warn(`Text not found in ${file}`);
      return;
    }

    content = content.replace(search, replacement);
  }

  writeFileSync(file, content);
  console.log(`Patched ${file}`);
}

// ---------------------------------------------------------------------------
// Patch AST usage detection
// ---------------------------------------------------------------------------

replaceInFile(
  "src/compiler/utils/ast.ts",
  /(import type \{[\s\S]*?\} from "\.\.\/types";)/,
  `$1
import { EMPTY_USAGE } from "../../shared/context-usage";`,
  { regex: true }
);

replaceInFile(
  "src/compiler/utils/ast.ts",
  /const CONTEXT_PROPS = new Set\(\[[\s\S]*?\]\);/,
  `const CONTEXT_PROPS = new Set([
  "body", "params", "query", "file", "files", "headers", "state", "req", "url",
  "cookie", "server", "set", "sendFile", "proxy", "forward", "cache",
]);`,
  { regex: true }
);

replaceInFile(
  "src/compiler/utils/ast.ts",
  /function detectUsage\(bodyNode: any, mapping: Map<string, string>\): ContextUsage \{[\s\S]*?\n\}\n/,
  `function detectUsage(bodyNode: any, mapping: Map<string, string>): ContextUsage {
  const usage: ContextUsage = { ...EMPTY_USAGE };

  walk(bodyNode, (n) => {
    if (n.type === "MemberExpression" && !n.computed && n.object?.type === "Identifier") {
      const root = mapping.get(n.object.name);

      if (root === "__root__") {
        const prop = n.property.name;

        if (prop === "body" || prop === "files") usage.body = true;
        if (prop === "file") usage.file = true;
        if (prop === "params") usage.params = true;
        if (prop === "query") usage.query = true;
        if (prop === "headers") usage.headers = true;
        if (prop === "state" || prop === "getState" || prop === "setState") usage.state = true;
        if (prop === "req") usage.req = true;
        if (prop === "url" || prop === "path" || prop === "method") usage.url = true;

        if (prop === "cookie") usage.cookie = true;
        if (prop === "server") usage.server = true;
        if (prop === "set") usage.set = true;

        if (prop === "json") usage.json = true;
        if (prop === "text") usage.text = true;
        if (prop === "html") usage.html = true;
        if (prop === "redirect") usage.redirect = true;
        if (prop === "stream") usage.stream = true;
        if (prop === "empty") usage.empty = true;
        if (prop === "status") usage.status = true;

        if (prop === "sendFile") usage.sendFile = true;
        if (prop === "proxy") usage.proxy = true;
        if (prop === "forward") usage.forward = true;
        if (prop === "cache") usage.cache = true;
      }
    }

    if (n.type === "Identifier" && mapping.has(n.name)) {
      const prop = mapping.get(n.name)!;

      if (prop === "body" || prop === "files") usage.body = true;
      if (prop === "file") usage.file = true;
      if (prop === "params") usage.params = true;
      if (prop === "query") usage.query = true;
      if (prop === "headers") usage.headers = true;
      if (prop === "state") usage.state = true;
      if (prop === "req") usage.req = true;
      if (prop === "url") usage.url = true;

      if (prop === "cookie") usage.cookie = true;
      if (prop === "server") usage.server = true;
      if (prop === "set") usage.set = true;

      if (prop === "sendFile") usage.sendFile = true;
      if (prop === "proxy") usage.proxy = true;
      if (prop === "forward") usage.forward = true;
      if (prop === "cache") usage.cache = true;
    }
  });

  return usage;
}
`,
  { regex: true }
);

// ---------------------------------------------------------------------------
// Patch analysis response inference + route config metadata
// ---------------------------------------------------------------------------

replaceInFile(
  "src/compiler/phases/analysis.ts",
  /const responseType = usage\.json[\s\S]*?: inferredResponseType;/,
  `const responseType = usage.json
    ? "json"
    : usage.text
      ? "text"
      : usage.html
        ? "html"
        : usage.stream
          ? "stream"
          : inferredResponseType;`,
  { regex: true }
);

replaceInFile(
  "src/compiler/phases/analysis.ts",
  `...(cache !== undefined ? { cache } : {}),`,
  `...(cache !== undefined ? { cache } : {}),
    ...(astParsed.config !== undefined ? { config: astParsed.config } : {}),`
);

// ---------------------------------------------------------------------------
// Patch body limits
// ---------------------------------------------------------------------------

replaceInFile(
  "src/core/body.ts",
  /body\.arrayBuffer = \(\) =>\s*use<ArrayBuffer>\([\s\S]*?limits\.maxTextBytes\s*\);/,
  `body.arrayBuffer = () =>
    use<ArrayBuffer>(
      "arrayBuffer",
      async () => {
        try {
          return await req.arrayBuffer();
        } catch {
          throw new BodyParseError("Invalid binary body", 400);
        }
      },
      limits.maxFileBytes
    );`,
  { regex: true }
);

replaceInFile(
  "src/core/body.ts",
  /body\.blob = \(\) =>\s*use<Blob>\([\s\S]*?limits\.maxTextBytes\s*\);/,
  `body.blob = () =>
    use<Blob>(
      "blob",
      async () => {
        try {
          return await req.blob();
        } catch {
          throw new BodyParseError("Invalid blob body", 400);
        }
      },
      limits.maxFileBytes
    );`,
  { regex: true }
);

// ---------------------------------------------------------------------------
// Patch async hook detection
// ---------------------------------------------------------------------------

replaceInFile(
  "src/core/hooks.ts",
  /const ASYNC_RE = \/async\|await\|\\\.then\\\(\|Promise\/;[\s\S]*?ASYNC_RE\.test\(fn\.toString\(\)\.slice\(0, 200\)\);/,
  `export const isAsyncFn = (fn: Function): boolean =>
  fn.constructor.name === "AsyncFunction" ||
  fn.constructor.name === "AsyncGeneratorFunction";`,
  { regex: true }
);

console.log("Patch application complete.");
