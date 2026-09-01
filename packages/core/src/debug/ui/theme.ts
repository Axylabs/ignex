/**
 * @fileoverview Theme state — a Solid signal-backed dark/light toggle
 * persisted to localStorage and applied to `<html data-theme>` (the Tailwind
 * token system references the CSS variables this attribute switches).
 */

import { createSignal } from "solid-js";

const THEME_KEY = "ignex-debugbar-theme";

const initial = (): "dark" | "light" => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage unavailable — default below */
  }
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
};

const [theme, setTheme] = createSignal<"dark" | "light">(initial());

/** Apply + persist a theme. */
const setThemeMode = (mode: "dark" | "light"): void => {
  setTheme(mode);
  document.documentElement.setAttribute("data-theme", mode);
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* private mode etc. — in-memory only */
  }
};

/** Toggle dark ↔ light (persisted). */
export const toggleTheme = (): void => {
  setThemeMode(theme() === "light" ? "dark" : "light");
};
