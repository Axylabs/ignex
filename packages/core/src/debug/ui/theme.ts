/**
 * @fileoverview Theme state — a Solid signal-backed dark/light toggle
 * persisted to localStorage and applied to `<html data-theme>` (the Tailwind
 * token system references the CSS variables this attribute switches). On a
 * first visit with nothing stored the OS `prefers-color-scheme` decides.
 */

import { createSignal } from "solid-js";

const THEME_KEY = "ignex-debugbar-theme";

/**
 * Resolve the boot theme. A persisted `"light"`/`"dark"` wins; anything else
 * (missing, empty or junk) follows the OS preference.
 */
export const resolveInitialTheme = (
  stored: string | null,
  prefersLight: boolean,
): "dark" | "light" => {
  if (stored === "light" || stored === "dark") return stored;
  return prefersLight ? "light" : "dark";
};

/** Read the persisted choice, tolerating unavailable storage. */
const storedTheme = (): string | null => {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
};

/**
 * Whether the OS asks for a light theme. Falls back to any `<html data-theme>`
 * the server pre-set when `matchMedia` is unavailable, then to dark.
 */
const prefersLight = (): boolean => {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: light)").matches;
    }
  } catch {
    /* matchMedia unavailable — fall through to the markup default */
  }
  try {
    return document.documentElement.getAttribute("data-theme") === "light";
  } catch {
    return false;
  }
};

const [theme, setTheme] = createSignal<"dark" | "light">(
  resolveInitialTheme(storedTheme(), prefersLight()),
);

/** Apply + persist a theme. */
const setThemeMode = (mode: "dark" | "light"): void => {
  setTheme(mode);
  try {
    document.documentElement.setAttribute("data-theme", mode);
  } catch {
    /* no DOM (SSR/test) — the signal still holds the mode */
  }
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* private mode etc. — in-memory only */
  }
};

/** Current theme (reactive). */
export const getTheme = (): "dark" | "light" => theme();

/** Apply the resolved initial theme to `<html data-theme>` once at boot. */
export const initTheme = (): void => {
  try {
    document.documentElement.dataset.theme = theme();
  } catch {
    /* no DOM (SSR/test) — the signal still holds the resolved mode */
  }
};

/** Toggle dark ↔ light (persisted). */
export const toggleTheme = (): void => {
  setThemeMode(theme() === "light" ? "dark" : "light");
};
