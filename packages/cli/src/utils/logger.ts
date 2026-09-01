const colorEnabled = !process.env.NO_COLOR;

function paint(code: number) {
  return (input: string) => (colorEnabled ? `\x1b[${code}m${input}\x1b[0m` : input);
}

export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const blue = paint(34);
export const cyan = paint(36);
export const dim = paint(2);
export const bold = paint(1);

export function info(message: string): void {
  console.log(`${blue("ℹ")} ${message}`);
}

export function success(message: string): void {
  console.log(`${green("✔")} ${message}`);
}

export function warn(message: string): void {
  console.warn(`${yellow("⚠")} ${message}`);
}

export function error(message: string): void {
  console.error(`${red("✖")} ${message}`);
}

export function step(message: string): void {
  console.log(`${cyan("→")} ${message}`);
}

/** Format an unknown thrown value into a printable error string. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
