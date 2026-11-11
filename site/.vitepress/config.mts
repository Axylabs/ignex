import { defineConfig } from "vitepress";

// Deployed to GitHub Pages at https://axylabs.github.io/ignex/
const BASE = "/ignex/";
const REPO = "https://github.com/Axylabs/ignex";

export default defineConfig({
  lang: "en-US",
  title: "ignex",
  description:
    "The AOT-first TypeScript framework for Bun. Routes are files — one command compiles them into an optimized server, an OpenAPI document, and a typed client.",
  base: BASE,
  srcDir: ".",
  srcExclude: ["**/README.md", "package.json"],
  ignoreDeadLinks: false,
  lastUpdated: true,

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: `${BASE}favicon.svg` }],
    ["meta", { name: "theme-color", content: "#ff6b2c" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "ignex" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Routes are files. One command compiles them into an optimized Bun.serve server, an OpenAPI document, and a typed client.",
      },
    ],
    ["meta", { property: "og:image", content: `${BASE}og.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],

  themeConfig: {
    // VPImage applies withBase() to the src itself — the path must stay
    // UN-prefixed or the deployed site requests /ignex/ignex/logo.svg (404).
    logo: { src: "/logo.svg", width: 28, height: 28 },
    siteTitle: "ignex",

    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Examples", link: "/examples/", activeMatch: "/examples/" },
      { text: "Cookbook", link: "/guide/cookbook", activeMatch: "/guide/cookbook" },
      {
        text: "Resources",
        items: [
          { text: "Why ignex?", link: "/guide/introduction#the-three-ideas" },
          {
            text: "Comparing to Express, Elysia & Nest",
            link: "/guide/introduction#coming-from-somewhere-else",
          },
          { text: "Performance methodology", link: "/guide/performance" },
          { text: "Repo docs (contributors)", link: `${REPO}/tree/main/docs` },
        ],
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "What is ignex?", link: "/guide/introduction" },
            { text: "The tour: CLI + debugbar", link: "/guide/tour" },
            { text: "Getting started", link: "/guide/getting-started" },
          ],
        },
        {
          text: "Essentials",
          items: [
            { text: "Routing", link: "/guide/routing" },
            { text: "Validation & OpenAPI", link: "/guide/validation" },
            { text: "Errors", link: "/guide/errors" },
            { text: "Plugins & config", link: "/guide/plugins-and-config" },
          ],
        },
        {
          text: "Features",
          items: [
            { text: "Auth & sessions", link: "/guide/auth-and-sessions" },
            { text: "Realtime: SSE, WebSockets, nova", link: "/guide/realtime" },
            { text: "Data: stores, cache, jobs", link: "/guide/data" },
            { text: "Debugbar", link: "/guide/debugbar" },
          ],
        },
        {
          text: "Tooling",
          items: [
            { text: "CLI reference", link: "/guide/cli" },
            { text: "Typed SDK generation", link: "/guide/sdk" },
          ],
        },
        {
          text: "Ship it",
          items: [
            { text: "Deployment", link: "/guide/deployment" },
            { text: "Performance", link: "/guide/performance" },
          ],
        },
        {
          text: "Recipes",
          items: [{ text: "Cookbook", link: "/guide/cookbook" }],
        },
      ],
      "/examples/": [
        {
          text: "Examples",
          items: [
            { text: "Overview", link: "/examples/" },
            { text: "Hello, world", link: "/examples/hello-world" },
            { text: "CRUD API", link: "/examples/crud-api" },
            { text: "Auth API", link: "/examples/auth-api" },
            { text: "Realtime chat", link: "/examples/realtime-chat" },
            { text: "File upload", link: "/examples/file-upload" },
            { text: "Typed client", link: "/examples/typed-client" },
          ],
        },
        {
          text: "Play with it",
          items: [
            { text: "Route playground", link: "/guide/routing#the-route-playground" },
            { text: "API explorer", link: "/examples/#api-explorer" },
            { text: "Generated client", link: "/examples/typed-client#client-playground" },
          ],
        },
      ],
    },

    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "Search docs", buttonAriaLabel: "Search docs" },
        },
      },
    },

    socialLinks: [{ icon: "github", link: REPO }],

    outline: { level: [2, 3], label: "On this page" },

    editLink: {
      pattern: `${REPO}/edit/main/site/:path`,
      text: "Edit this page on GitHub",
    },

    lastUpdated: { text: "Updated" },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Axylabs",
    },

    docFooter: { prev: "Previous", next: "Next" },

    returnToTop: true,
  },

  markdown: {
    theme: { light: "github-light", dark: "github-dark" },
  },
});
