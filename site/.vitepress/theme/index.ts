import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import ApiExplorer from "./components/ApiExplorer.vue";
import ClientPlayground from "./components/ClientPlayground.vue";
import HomeTerminal from "./components/HomeTerminal.vue";
import RoutePlayground from "./components/RoutePlayground.vue";
import "./custom.css";

// The animated quick-start terminal replaces the hero image slot on the
// landing page (VPHome exposes `home-hero-image` through the Layout).
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-hero-image": () => h(HomeTerminal),
    }),
  enhanceApp({ app }) {
    app.component("ApiExplorer", ApiExplorer);
    app.component("ClientPlayground", ClientPlayground);
    app.component("HomeTerminal", HomeTerminal);
    app.component("RoutePlayground", RoutePlayground);
  },
} satisfies Theme;
