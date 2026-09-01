/**
 * @fileoverview Toast — transient bottom-right notification, one instance.
 * A signal holds the current message; the {@link Toast} component (mounted by
 * the app shell) renders it while non-null.
 */

import { createSignal, type JSX, Show } from "solid-js";

const [message, setMessage] = createSignal<string | null>(null);

let hideTimer: ReturnType<typeof setTimeout> | null = null;

/** Show a toast for ~2.6s (later calls replace the message and restart). */
export const toast = (msg: string): void => {
  setMessage(msg);
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout((): void => {
    setMessage(null);
  }, 2600);
};

/** Fixed bottom-right toast surface — mount once inside the app shell. */
export function Toast(): JSX.Element {
  return (
    <Show when={message()}>
      {(text): JSX.Element => (
        <div id="toast" class="toast show fixed bottom-5 right-5 z-[200] max-w-[420px]">
          {text()}
        </div>
      )}
    </Show>
  );
}
