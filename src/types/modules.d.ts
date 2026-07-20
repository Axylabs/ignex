declare module "just-debounce" {
  type AnyFn = (...args: any[]) => any;

  interface DebouncedFn<T extends AnyFn> {
    (...args: Parameters<T>): ReturnType<T>;
    cancel(): void;
  }

  export default function debounce<T extends AnyFn>(
    fn: T,
    delay?: number,
    immediate?: boolean
  ): DebouncedFn<T>;
}

declare module "just-throttle" {
  type AnyFn = (...args: any[]) => any;

  interface ThrottledFn<T extends AnyFn> {
    (...args: Parameters<T>): ReturnType<T>;
    cancel(): void;
  }

  export default function throttle<T extends AnyFn>(
    fn: T,
    interval?: number,
    options?: { leading?: boolean; trailing?: boolean }
  ): ThrottledFn<T>;
}