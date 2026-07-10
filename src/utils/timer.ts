export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const debounce = (fn: Function, ms: number) => {
  let timer: NodeJS.Timeout;
  return (...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

export const throttle = (fn: Function, ms: number) => {
  let timer: NodeJS.Timeout | null = null;
  return (...args: any[]) => {
    if (!timer) {
      fn(...args);
      timer = setTimeout(() => {
        timer = null;
      }, ms);
    }
  };
};
