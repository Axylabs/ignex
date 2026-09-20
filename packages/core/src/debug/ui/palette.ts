/**
 * @fileoverview Command-palette model — the pure half of the Cmd/Ctrl-K
 * palette: a fuzzy scorer, a stable filter/sort and the command list the
 * shell renders. No Solid or DOM dependencies beyond the injected `prompt`
 * for the id-based go-to commands, so the model stays unit-testable.
 */
import { NAV_GROUPS } from "./nav";
import { VIEWS, type ViewDef } from "./views/registry";

/** A runnable command-palette entry. */
export interface Command {
  /** Stable id (used as the list key). */
  id: string;
  /** Display label (also the fuzzy-match target). */
  label: string;
  /** Section the palette groups the entry under. */
  group: string;
  /** Effect run when the entry is chosen. */
  run: () => void;
}

/** Characters that are not word characters — a match after one gets a bonus. */
const NON_WORD = /[^a-z0-9]/;

/**
 * Fuzzy-match `query` against `text`, case-insensitively. Returns `-Infinity`
 * when the query is not a subsequence of the text; otherwise sums per-character
 * weights: a prefix bonus, a word-boundary bonus, a contiguous-run bonus and a
 * small penalty for each character's distance into the text.
 */
export const fuzzyScore = (query: string, text: string): number => {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let i = 0; i < q.length; i += 1) {
    const at = t.indexOf(q[i] as string, from);
    if (at === -1) return Number.NEGATIVE_INFINITY;
    let weight = 1;
    if (at === 0) weight += 8;
    if (at === 0 || NON_WORD.test(t[at - 1] as string)) weight += 6;
    if (at === prev + 1) weight += 4;
    weight -= at * 0.1;
    score += weight;
    prev = at;
    from = at + 1;
  }
  return score;
};

/**
 * Filter commands by query, dropping non-matches and ordering by score
 * (descending) then label. An empty/whitespace query returns all commands in
 * their original order.
 */
export const filterCommands = (cmds: Command[], query: string): Command[] => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [...cmds];
  return cmds
    .map((cmd) => ({ cmd, score: fuzzyScore(trimmed, cmd.label) }))
    .filter((entry) => entry.score !== Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label))
    .map((entry) => entry.cmd);
};

/** Prompt for a free-text value, tolerating a host without `prompt`. */
const promptFor = (message: string): string | null => {
  try {
    return globalThis.prompt?.(message) ?? null;
  } catch {
    return null;
  }
};

/** Views in sidebar order, with any ungrouped registry views appended. */
const orderedViews = (views: ViewDef[]): ViewDef[] => {
  const grouped = NAV_GROUPS.flatMap((group) => group.items);
  const seen = new Set(grouped.map((view) => view.id));
  return [...grouped, ...views.filter((view) => !seen.has(view.id))];
};

/** Build the command list the palette renders, wired to the shell's actions. */
export const buildCommands = (deps: {
  navigate: (view: string, id?: string) => void;
  toggleTheme: () => void;
  refresh: () => void;
  togglePause: () => void;
}): Command[] => {
  const views: Command[] = orderedViews(VIEWS).map((view) => ({
    id: `view:${view.id}`,
    label: view.label,
    group: "Views",
    run: (): void => deps.navigate(view.id),
  }));

  const actions: Command[] = [
    { id: "action:refresh", label: "Refresh", group: "Actions", run: (): void => deps.refresh() },
    {
      id: "action:toggle-live-tail",
      label: "Toggle live tail",
      group: "Actions",
      run: (): void => deps.togglePause(),
    },
    {
      id: "action:toggle-theme",
      label: "Toggle theme",
      group: "Actions",
      run: (): void => deps.toggleTheme(),
    },
  ];

  const goTo: Command[] = [
    {
      id: "go:request",
      label: "Open request by id",
      group: "Go to",
      run: (): void => {
        const id = promptFor("Request id");
        if (id !== null && id !== "") deps.navigate("detail", id);
      },
    },
    {
      id: "go:log",
      label: "Open log by id",
      group: "Go to",
      run: (): void => {
        const id = promptFor("Log id");
        if (id !== null && id !== "") deps.navigate("logDetail", id);
      },
    },
    {
      id: "go:doc",
      label: "Open doc by path",
      group: "Go to",
      run: (): void => {
        const path = promptFor("Doc path");
        if (path !== null && path !== "") deps.navigate("docs", path);
      },
    },
  ];

  return [...views, ...actions, ...goTo];
};
