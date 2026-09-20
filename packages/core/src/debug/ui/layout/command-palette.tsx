/**
 * @fileoverview Command palette — the `Cmd/Ctrl-K` overlay. A modal dialog
 * (`role="dialog" aria-modal`) with an autofocused search, fuzzy results from
 * the pure {@link filterCommands}/{@link buildCommands} model grouped by
 * section, arrow-key active index, Enter to run, Escape to close, a focus trap
 * and focus restoration to the trigger. The trigger lives in `ContextBar`; the
 * shell also opens it from the global keydown handler.
 */

import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";

import { SearchInput } from "../components/fields";
import { Icon, type IconName } from "../components/icon";
import { paused, pushPulse, setPaused } from "../live";
import { iconForView } from "../nav";
import { buildCommands, type Command, filterCommands } from "../palette";
import { navigate } from "../router";
import { toggleTheme } from "../theme";

interface CommandPaletteProps {
  /** Whether the palette is visible. */
  open: boolean;
  /** Close the palette (Escape, scrim click, after a command runs). */
  onClose: () => void;
}

/** A section of filtered commands, in first-seen order. */
interface CommandGroup {
  /** Section heading. */
  label: string;
  /** Commands in this section, in filtered order. */
  items: Command[];
}

/** Id of the results listbox the search combobox controls. */
const LISTBOX_ID = "palette-listbox";

/** Stable DOM id for one command option (command ids may contain `:`). */
const optionId = (id: string): string => `palette-option-${id.replace(/[^\w-]/g, "-")}`;

/** Pick a leading icon from a command's id (views map through `iconForView`). */
const iconForCommand = (cmd: Command): IconName => {
  if (cmd.id.startsWith("view:")) return iconForView(cmd.id.slice("view:".length));
  if (cmd.id === "action:refresh") return "refresh";
  if (cmd.id === "action:toggle-live-tail") return "pause";
  if (cmd.id === "action:toggle-theme") return "sun";
  return "arrow-right";
};

/** Group the filtered command list by its `group`, preserving order. */
const groupCommands = (cmds: Command[]): CommandGroup[] => {
  const map = new Map<string, Command[]>();
  for (const cmd of cmds) {
    const list = map.get(cmd.group);
    if (list !== undefined) list.push(cmd);
    else map.set(cmd.group, [cmd]);
  }
  return [...map].map(([label, items]) => ({ label, items }));
};

/** Fuzzy command palette with full keyboard control and a focus trap. */
export const CommandPalette = (props: CommandPaletteProps): JSX.Element => {
  const [query, setQuery] = createSignal("");
  const [activeId, setActiveId] = createSignal<string | null>(null);
  let dialog: HTMLDivElement | undefined;
  let restore: HTMLElement | null = null;

  // The command list is static; only the fuzzy filter reacts to the query.
  const commands = buildCommands({
    navigate: (view, id): void => navigate(view, id),
    toggleTheme,
    refresh: (): void => {
      pushPulse();
    },
    togglePause: (): void => {
      setPaused(!paused());
    },
  });
  const filtered = createMemo((): Command[] => filterCommands(commands, query()));
  const groups = createMemo((): CommandGroup[] => groupCommands(filtered()));

  // Keep a valid active row as the query narrows the list.
  createEffect((): void => {
    const list = filtered();
    if (!list.some((cmd) => cmd.id === activeId())) setActiveId(list[0]?.id ?? null);
  });

  // The input's `aria-activedescendant` target (undefined when nothing is active).
  const activeOptionId = createMemo((): string | undefined => {
    const id = activeId();
    return id === null ? undefined : optionId(id);
  });

  // On open: reset, remember the trigger, autofocus the search. On close:
  // restore focus to whatever opened the palette.
  createEffect((): void => {
    if (props.open) {
      if (restore === null) restore = document.activeElement as HTMLElement | null;
      setQuery("");
      setActiveId(null);
      queueMicrotask((): void => document.getElementById("palette-search")?.focus());
      return;
    }
    if (restore !== null) {
      restore.focus();
      restore = null;
    }
  });

  /** Move the active row by `delta`, wrapping at both ends. */
  const move = (delta: number): void => {
    const list = filtered();
    if (list.length === 0) return;
    const current = list.findIndex((cmd) => cmd.id === activeId());
    const next = ((current < 0 ? 0 : current) + delta + list.length) % list.length;
    setActiveId(list[next]?.id ?? null);
  };

  /** Close, then run the active command (or the first match). */
  const runActive = (): void => {
    const list = filtered();
    const cmd = list.find((c) => c.id === activeId()) ?? list[0];
    if (cmd === undefined) return;
    props.onClose();
    cmd.run();
  };

  /** Cycle Tab focus within the dialog (only the search is normally focusable). */
  const trapTab = (ev: KeyboardEvent): void => {
    const root = dialog;
    if (root === undefined) return;
    const focusables = [
      ...root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) return;
    const current = document.activeElement;
    if (ev.shiftKey && (current === first || current === root)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && current === last) {
      ev.preventDefault();
      first.focus();
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      move(1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      move(-1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      runActive();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      props.onClose();
    } else if (ev.key === "Tab") {
      trapTab(ev);
    }
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
        <button
          type="button"
          aria-label="Close command palette"
          class="absolute inset-0 bg-overlay"
          onClick={(): void => props.onClose()}
        />
        <div
          ref={(el): void => {
            dialog = el;
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          class="relative z-10 flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-line bg-surface-1 shadow-overlay"
          onKeyDown={onKeyDown}
        >
          <div class="border-b border-line p-2">
            <SearchInput
              id="palette-search"
              placeholder="Search commands…"
              value={query()}
              role="combobox"
              ariaControls={LISTBOX_ID}
              ariaActivedescendant={activeOptionId()}
              ariaExpanded={true}
              onInput={(value): void => {
                setQuery(value);
              }}
            />
          </div>
          <div class="max-h-[50vh] overflow-y-auto p-2">
            <div id={LISTBOX_ID} role="listbox" aria-label="Commands">
              <For each={groups()}>
                {(group): JSX.Element => (
                  // biome-ignore lint/a11y/useSemanticElements: a labelled option group in the palette listbox, not a form fieldset
                  <div role="group" aria-label={group.label} class="mb-1">
                    <div
                      aria-hidden="true"
                      class="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-faint"
                    >
                      {group.label}
                    </div>
                    <For each={group.items}>
                      {(cmd): JSX.Element => {
                        const active = (): boolean => cmd.id === activeId();
                        return (
                          <button
                            type="button"
                            id={optionId(cmd.id)}
                            role="option"
                            tabindex={-1}
                            aria-selected={active()}
                            class={`flex w-full cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${
                              active()
                                ? "bg-accent-soft text-ink"
                                : "text-muted hover:bg-surface-2 hover:text-ink"
                            }`}
                            onMouseEnter={(): void => {
                              setActiveId(cmd.id);
                            }}
                            onClick={(): void => {
                              props.onClose();
                              cmd.run();
                            }}
                          >
                            <Icon
                              name={iconForCommand(cmd)}
                              size={14}
                              class="shrink-0 text-faint"
                            />
                            <span class="truncate">{cmd.label}</span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <Show when={filtered().length === 0}>
              <div class="px-3 py-6 text-center text-sm text-muted">No matching commands</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};
