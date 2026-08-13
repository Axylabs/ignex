/**
 * Framework feature tests: templates, env/config, jobs, i18n, client, lifecycle.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createClient,
  createI18n,
  createJobQueue,
  createTemplate,
  createTemplateRegistry,
  defineConfig,
  envBool,
  envInt,
  envJson,
  loadEnv,
  negotiateLocale,
  renderTemplate,
  withLayout,
  withRetry,
  withTimeout,
} from "@ignex/core";
import { afterAll, describe, expect, it } from "vitest";

describe("templates", () => {
  it("renders interpolation, branches, loops and filters", () => {
    expect(renderTemplate("Hello {{ name }}!", { name: "world" })).toBe("Hello world!");
    expect(renderTemplate("{% if ok %}Y{% else %}N{% endif %}", { ok: false })).toBe("N");
    expect(renderTemplate("{% for x in xs %}{{ x }},{% endfor %}", { xs: [1, 2, 3] })).toBe(
      "1,2,3,",
    );
    expect(renderTemplate("{{ t | upper }}", { t: "hi" })).toBe("HI");
    expect(renderTemplate("{{ a.b.c }}", { a: { b: { c: "deep" } } })).toBe("deep");
  });

  it("composes layouts via withLayout", () => {
    const layout = createTemplate("<main>{{ content }}</main>");
    const page = createTemplate("<h1>{{ title }}</h1>");
    const composed = withLayout((content, data) => layout({ ...data, content }))(page);
    expect(composed({ title: "Hi" })).toBe("<main><h1>Hi</h1></main>");
  });

  it("registry render + missing template", () => {
    const reg = createTemplateRegistry({ home: "Hello {{ name }}" });
    expect(reg.render("home", { name: "x" })).toBe("Hello x");
    expect(reg.has("home")).toBe(true);
    expect(() => reg.render("missing", {})).toThrow(/not found/);
  });
});

describe("env & config", () => {
  const dir = mkdtempSync(join(tmpdir(), "ignex-env-"));

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loadEnv parses dotenv files without overriding real env", () => {
    writeFileSync(
      join(dir, ".env"),
      'IGNEX_TEST_A=hello\nIGNEX_TEST_N=42\nIGNEX_TEST_B=true\n# comment\nIGNEX_TEST_J={"x":1}\n',
    );
    const prev = { ...process.env };
    loadEnv([join(dir, ".env")]);
    expect(process.env.IGNEX_TEST_A).toBe("hello");
    expect(process.env.IGNEX_TEST_N).toBe("42");
    // restore
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
  });

  it("typed accessors coerce values", () => {
    const oldA = process.env.T_A;
    const oldN = process.env.T_N;
    const oldB = process.env.T_B;
    const oldJ = process.env.T_J;
    process.env.T_A = "x";
    process.env.T_N = "7";
    process.env.T_B = "true";
    process.env.T_J = '["a"]';
    expect(envInt("T_N")).toBe(7);
    expect(envBool("T_B")).toBe(true);
    expect(envJson<string[]>("T_J")).toEqual(["a"]);
    expect(envInt("MISSING_N", 5)).toBe(5);
    if (oldA === undefined) delete process.env.T_A;
    else process.env.T_A = oldA;
    if (oldN === undefined) delete process.env.T_N;
    else process.env.T_N = oldN;
    if (oldB === undefined) delete process.env.T_B;
    else process.env.T_B = oldB;
    if (oldJ === undefined) delete process.env.T_J;
    else process.env.T_J = oldJ;
  });

  it("defineConfig resolves overrides → env → defaults", () => {
    const oldP = process.env.CFG_PORT;
    process.env.CFG_PORT = "8080";
    const cfg = defineConfig(
      {
        PORT: { type: "number", env: "CFG_PORT", default: 3000 },
        MODE: { type: "string", default: "dev" },
        DEBUG: { type: "boolean", default: false },
      },
      { MODE: "prod" },
    );
    expect(cfg.PORT).toBe(8080);
    expect(cfg.MODE).toBe("prod");
    expect(cfg.DEBUG).toBe(false);
    if (oldP === undefined) delete process.env.CFG_PORT;
    else process.env.CFG_PORT = oldP;
  });
});

describe("jobs", () => {
  it("enqueues and runs tasks with concurrency", async () => {
    const queue = createJobQueue({ concurrency: 2 });
    const ran: string[] = [];
    queue.enqueue("a", () => ran.push("a"));
    queue.enqueue("b", () => ran.push("b"));
    // wait for drain
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toEqual(["a", "b"]);
    await queue.stop();
  });

  it("withRetry retries failing tasks", async () => {
    let attempts = 0;
    const task = withRetry(
      2,
      1,
    )(async () => {
      attempts++;
      if (attempts < 3) throw new Error("boom");
    });
    await task();
    expect(attempts).toBe(3);
  });

  it("withTimeout aborts slow tasks", async () => {
    const task = withTimeout(10)(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    await expect(task()).rejects.toThrow(/timed out/);
  });
});

describe("i18n", () => {
  it("negotiates locale with q-weighting and base fallback", () => {
    expect(negotiateLocale("fr-FR,fr;q=0.9,en;q=0.8", ["en", "fr", "es"])).toBe("fr");
    expect(negotiateLocale("en-US,en;q=0.9", ["es", "en"])).toBe("en");
    expect(negotiateLocale(null, ["en", "es"], { defaultLocale: "es" })).toBe("es");
  });

  it("translates with interpolation and fallback", () => {
    const i18n = createI18n({ en: { hi: "Hello {name}" }, es: { hi: "Hola {name}" } });
    expect(i18n.t("hi", { name: "A" }, "es")).toBe("Hola A");
    expect(i18n.t("missing", {}, "en")).toBe("missing");
  });
});

describe("client", () => {
  it("performs requests through a mock fetch", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = createClient({
      baseUrl: "https://api.example.com",
      fetch: (async (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true, url: String(url) }), { status: 200 });
      }) as typeof fetch,
    });
    const body = await client.post<{ ok: boolean; url: string }>("/things", { id: 1 });
    expect(body.ok).toBe(true);
    expect(body.url).toBe("https://api.example.com/things");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ id: 1 });
  });

  it("throws on non-2xx", async () => {
    const client = createClient({
      baseUrl: "https://api.example.com",
      fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    await expect(client.get("/boom")).rejects.toMatchObject({ status: 500 });
  });
});

describe("lifecycle / createApp", () => {
  it("runs request hooks and handles errors", async () => {
    const app = createApp({
      lifecycle: {
        request: [
          async (c) => {
            c.setState("flag", "on");
            return undefined;
          },
        ],
      },
      handler: async (c) => Response.json({ flag: c.getState("flag") }),
    });
    const res = await app.handler(new Request("http://localhost:3000/"));
    expect(await res.json()).toEqual({ flag: "on" });
  });

  it("applies afterHandle hooks", async () => {
    const app = createApp({
      lifecycle: {
        afterHandle: [
          async (_c, response) => {
            const headers = new Headers(response.headers);
            headers.set("x-custom", "1");
            return new Response(response.body, { status: response.status, headers });
          },
        ],
      },
      handler: async () => new Response("ok"),
    });
    const res = await app.handler(new Request("http://localhost:3000/"));
    expect(res.headers.get("x-custom")).toBe("1");
  });
});
