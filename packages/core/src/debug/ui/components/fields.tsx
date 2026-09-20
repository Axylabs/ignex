/**
 * @fileoverview Form field primitives — a labelled field wrapper, a token-styled
 * native `Select`, and the dashboard `SearchInput` (which preserves the `#search`
 * id contract and reports its value through a plain callback).
 */

import { type JSX, splitProps } from "solid-js";

const INPUT_BOX =
  "h-8 min-w-0 rounded-md border border-line bg-surface-3 px-2.5 text-md text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25";

interface FieldProps {
  /** Field label. */
  label: string;
  /** The control (input/select) the label wraps. */
  children: JSX.Element;
}

/** Labelled form-field wrapper. */
export const Field = (props: FieldProps): JSX.Element => (
  // biome-ignore lint/a11y/noLabelWithoutControl: the label wraps props.children, which is the control
  <label class="flex flex-col gap-1 text-xs text-muted">
    <span>{props.label}</span>
    {props.children}
  </label>
);

type SelectProps = JSX.SelectHTMLAttributes<HTMLSelectElement> & { children: JSX.Element };

/** Token-styled native select (forwards every native select attribute). */
export const Select = (props: SelectProps): JSX.Element => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <select class={`${INPUT_BOX}${local.class !== undefined ? ` ${local.class}` : ""}`} {...rest}>
      {local.children}
    </select>
  );
};

interface SearchInputProps {
  /** Element id (the shell's `/` shortcut focuses `#search`). */
  id?: string | undefined;
  /** Placeholder text. */
  placeholder?: string | undefined;
  /** Initial/controlled value. */
  value?: string | undefined;
  /** Render the value in the mono face. */
  mono?: boolean | undefined;
  /** Native spellcheck hint (e.g. `false` for identifiers/paths). */
  spellcheck?: boolean | undefined;
  /** Called with the current value on every input event. */
  onInput?: ((value: string) => void) | undefined;
}

/** Search text input — token-styled box, value reported as a plain string. */
export const SearchInput = (props: SearchInputProps): JSX.Element => (
  <input
    type="text"
    id={props.id}
    placeholder={props.placeholder}
    value={props.value}
    spellcheck={props.spellcheck}
    class={`${INPUT_BOX}${props.mono === true ? " font-mono" : ""}`}
    onInput={(ev) => props.onInput?.(ev.currentTarget.value)}
  />
);
