import "reflect-metadata";
import { CronJob, IntervalJob, TimeoutJob, type CronJobOptions, type JobOptions } from "./scheduled-job";

/** Metadata key for scheduled methods (stored on the class prototype). */
export const SCHEDULE_METADATA = Symbol("SCHEDULE_METADATA");

export interface ScheduleDecoratorOptions {
  /** Unique job name in the {@link SchedulerRegistry}. Default: `ClassName.method`. */
  name?: string;
  /** Register the job without starting it; start it later via the registry. */
  disabled?: boolean;
}

export interface CronOptions extends CronJobOptions, ScheduleDecoratorOptions {}
export interface IntervalOptions extends JobOptions, ScheduleDecoratorOptions {}
export interface TimeoutOptions extends JobOptions, ScheduleDecoratorOptions {}

export type ScheduledMethodMetadata = { method: string | symbol } & (
  | { kind: "cron"; expression: string; options: CronOptions }
  | { kind: "interval"; ms: number; options: IntervalOptions }
  | { kind: "timeout"; ms: number; options: TimeoutOptions }
);

type Entry = ScheduledMethodMetadata extends infer M ? (M extends unknown ? Omit<M, "method"> : never) : never;

/**
 * Run the method on a cron expression once the {@link ScheduleOrchestrator} starts.
 *
 * ```ts
 * @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { timeZone: "Asia/Ho_Chi_Minh" })
 * async cleanup() { … }
 * ```
 */
export function Cron(expression: string, options: CronOptions = {}): MethodDecorator {
  return scheduled({ kind: "cron", expression, options }, (name) => new CronJob(name, expression, noop, options));
}

/** Run the method every `ms` milliseconds once the {@link ScheduleOrchestrator} starts. */
export function Interval(ms: number, options?: IntervalOptions): MethodDecorator;
export function Interval(name: string, ms: number): MethodDecorator;
export function Interval(msOrName: number | string, msOrOptions?: number | IntervalOptions): MethodDecorator {
  const [ms, options] = normalize(msOrName, msOrOptions);
  return scheduled({ kind: "interval", ms, options }, (name) => new IntervalJob(name, ms, noop));
}

/** Run the method once, `ms` milliseconds after the {@link ScheduleOrchestrator} starts. */
export function Timeout(ms: number, options?: TimeoutOptions): MethodDecorator;
export function Timeout(name: string, ms: number): MethodDecorator;
export function Timeout(msOrName: number | string, msOrOptions?: number | TimeoutOptions): MethodDecorator {
  const [ms, options] = normalize(msOrName, msOrOptions);
  return scheduled({ kind: "timeout", ms, options }, (name) => new TimeoutJob(name, ms, noop));
}

/**
 * Scheduled methods of `cls`, including inherited ones. A subclass that redeclares the schedule
 * of a method replaces its parent's.
 */
export function getScheduledMethods(cls: Function): ScheduledMethodMetadata[] {
  const chain: object[] = [];
  for (let proto = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    chain.unshift(proto);
  }
  const byMethod = new Map<string | symbol, ScheduledMethodMetadata[]>();
  for (const proto of chain) {
    const own: ScheduledMethodMetadata[] = Reflect.getOwnMetadata(SCHEDULE_METADATA, proto) ?? [];
    const methods = new Set(own.map(({ method }) => method));
    for (const method of methods) byMethod.set(method, own.filter((entry) => entry.method === method));
  }
  return [...byMethod.values()].flat();
}

const noop = () => {};

/** `(ms, options?)` or Nest-style `(name, ms)`. */
function normalize<O extends ScheduleDecoratorOptions>(
  msOrName: number | string,
  msOrOptions: number | O | undefined,
): [number, O] {
  return typeof msOrName === "string"
    ? [msOrOptions as number, { name: msOrName } as O]
    : [msOrName, { ...(msOrOptions as O) }];
}

/** Validates eagerly — building a throwaway job — so a bad schedule fails at import, not at start. */
function scheduled(entry: Entry, validate: (name: string) => unknown): MethodDecorator {
  return (target, method) => {
    const label = `${typeof target === "function" ? target.name : target.constructor.name}.${String(method)}`;
    if (typeof target === "function") {
      throw new TypeError(`@${capitalize(entry.kind)}() cannot decorate static method ${label}.`);
    }
    validate(entry.options.name ?? label);

    const existing: ScheduledMethodMetadata[] = Reflect.getOwnMetadata(SCHEDULE_METADATA, target) ?? [];
    Reflect.defineMetadata(SCHEDULE_METADATA, [...existing, { ...entry, method }], target);
  };
}

const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);
