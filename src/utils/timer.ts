export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Delay calls to `fn` until `ms` have passed without another call; the last arguments win. */
export const debounce = <A extends unknown[]>(fn: (...args: A) => unknown, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A): void => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

/** Call `fn` immediately, then ignore further calls for `ms`. */
export const throttle = <A extends unknown[]>(fn: (...args: A) => unknown, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A): void => {
    if (timer) return;
    fn(...args);
    timer = setTimeout(() => {
      timer = undefined;
    }, ms);
  };
};
