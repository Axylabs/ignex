/**
 * @fileoverview Port of Elysia `test/cookie/*` — cookie parsing, serialization,
 * the `Cookie` jar (read request cookies / write Set-Cookie) and signed
 * cookies on the interpreted `createApp().handler()` path.
 *
 * Key-rotation / multi-key signing (Elysia `signing-key`/`key-cache`) has no
 * IgnEx equivalent — `createCookieSigner` takes a single secret (documented
 * divergence). Everything else: attribute serialization, DoS guards
 * (oversized header / >100 cookies), tamper rejection, and prototype-pollution
 * resistance.
 */

import {
  createApp,
  createCookieJar,
  createCookieSigner,
  parseCookieString,
  serializeCookie,
} from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

describe("parseCookieString", () => {
  it("parses a standard cookie header, decoding values", () => {
    expect(parseCookieString("a=1; b=hello%20world")).toEqual({ a: "1", b: "hello world" });
  });

  it("handles malformed segments without throwing", () => {
    expect(parseCookieString("a=1; ;; b=2; =; c=")).toMatchObject({ a: "1" });
  });

  it("returns {} for null/empty/whitespace input", () => {
    expect(parseCookieString(null)).toEqual({});
    expect(parseCookieString("")).toEqual({});
    expect(parseCookieString("   ")).toEqual({});
  });

  it("returns {} for an oversized header (DoS guard, 8 KB)", () => {
    expect(parseCookieString(`a=${"x".repeat(9000)}`)).toEqual({});
  });

  it("caps parsing at 100 cookies (DoS guard)", () => {
    const many = Array.from({ length: 150 }, (_, i) => `k${i}=${i}`).join("; ");
    const parsed = parseCookieString(many);
    expect(Object.keys(parsed).length).toBe(100);
  });
});

describe("serializeCookie", () => {
  it("serializes a plain cookie with a URL-encoded value", () => {
    expect(serializeCookie({ name: { value: "hello world" } })).toBe("name=hello%20world");
  });

  it("emits attributes: Domain, Path, Max-Age, Expires, HttpOnly, Secure, SameSite", () => {
    const out = serializeCookie({
      sid: {
        value: "abc",
        domain: "example.com",
        path: "/app",
        maxAge: 3600,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      },
    });

    expect(out).toContain("sid=abc");
    expect(out).toContain("Domain=example.com");
    expect(out).toContain("Path=/app");
    expect(out).toContain("Max-Age=3600");
    expect(out).toContain("HttpOnly");
    expect(out).toContain("Secure");
    expect(out).toContain("SameSite=Lax");
  });

  it("renders Expires as a UTC date and honors Priority/Partitioned", () => {
    const out = serializeCookie({
      c: {
        value: "1",
        expires: new Date("2030-01-02T03:04:05Z"),
        priority: "high",
        partitioned: true,
      },
    }) as string;

    expect(out).toContain("Expires=Wed, 02 Jan 2030 03:04:05 GMT");
    expect(out).toContain("Priority=high");
    expect(out).toContain("Partitioned");
  });

  it("serializes multiple cookies into an array", () => {
    const out = serializeCookie({ a: { value: "1" }, b: { value: "2" } });
    expect(out).toEqual(["a=1", "b=2"]);
  });

  it("returns undefined when no cookie has a value", () => {
    expect(serializeCookie({ empty: { value: null } })).toBeUndefined();
    expect(serializeCookie({})).toBeUndefined();
  });
});

describe("cookie jar through the interpreted path", () => {
  it("reads request cookies via ctx.cookie", async () => {
    const res = await inject(
      app((ctx) => ctx.json({ sid: ctx.cookie.sid?.value })),
      { url: "/", headers: { cookie: "sid=abc; theme=dark" } },
    );

    await expect(res.json()).resolves.toEqual({ sid: "abc" });
  });

  it("writes response cookies via ctx.cookie → Set-Cookie header", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.cookie.sid.value = "xyz";
        return ctx.text("ok");
      }),
      { url: "/" },
    );

    expect(res.headers.get("set-cookie")).toBe("sid=xyz");
  });

  it("writes multiple response cookies as multiple Set-Cookie headers", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.cookie.a.value = "1";
        ctx.cookie.b.value = "2";
        return ctx.text("ok");
      }),
      { url: "/" },
    );

    expect(res.headers.getSetCookie?.()).toEqual(["a=1", "b=2"]);
  });

  it("remove() emits an expiring Set-Cookie", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.cookie.sid.remove();
        return ctx.text("ok");
      }),
      { url: "/" },
    );

    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain("sid=");
    expect(sc).toContain("Max-Age=0");
    expect(sc).toContain("Expires=Thu, 01 Jan 1970");
  });

  it("applies cookie options through the jar", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.cookie.token.update({ value: "t", httpOnly: true, secure: true, sameSite: "strict" });
        return ctx.text("ok");
      }),
      { url: "/" },
    );

    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain("token=t");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("Secure");
    expect(sc).toContain("SameSite=Strict");
  });
});

describe("createCookieJar direct", () => {
  it("reads fall back to initial values and writes through to set.cookie", () => {
    const set: { headers: Record<string, string>; cookie?: Record<string, unknown> } = {
      headers: {},
    };
    const jar = createCookieJar(set as never, {}, { httpOnly: true });
    // Reading a key must not eagerly write an entry (the accumulator exists
    // but stays empty).
    expect(jar.unset?.value).toBeUndefined();
    expect(Object.keys(set.cookie ?? {})).toHaveLength(0);

    jar.name.value = "v";
    expect((set.cookie as Record<string, unknown>)?.name).toMatchObject({ value: "v" });
  });

  it("is resistant to a __proto__ cookie name (no prototype pollution)", () => {
    const set: { headers: Record<string, string>; cookie?: Record<string, unknown> } = {
      headers: {},
    };
    const jar = createCookieJar(set as never, {});
    // biome-ignore lint/complexity/useLiteralKeys: deliberate prototype-pollution regression test (must use the literal "__proto__" key).
    // biome-ignore lint/suspicious/noProto: deliberate prototype-pollution regression test (must exercise the __proto__ key).
    jar["__proto__"].value = "polluted";
    const cookieStore = set.cookie as Record<string, unknown>;
    // Writing via the proxy targets the accumulator, not Object.prototype.
    expect(({} as Record<string, unknown>).value).toBeUndefined();
    expect(cookieStore).toBeDefined();
  });
});

describe("signed cookies", () => {
  it("round-trips a signed cookie and rejects tampering", () => {
    const signer = createCookieSigner("s3cret");
    const signed = signer.sign("payload");
    expect(signed).toMatch(/^payload\.[0-9a-f]{64}$/);
    expect(signer.verify(signed)).toBe("payload");
    expect(signer.verify("payload.deadbeef")).toBeNull();
    expect(signer.verify(`tampered.${signed.split(".")[1]}`)).toBeNull();
  });

  it("rejects a signature from a different secret", () => {
    const a = createCookieSigner("secret-a");
    const b = createCookieSigner("secret-b");
    const signed = a.sign("x");
    expect(b.verify(signed)).toBeNull();
  });

  it("throws on an empty secret", () => {
    expect(() => createCookieSigner("")).toThrow(TypeError);
  });
});
