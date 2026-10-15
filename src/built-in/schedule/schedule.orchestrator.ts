import { Inject } from "../../decorators/inject.decorator";
import { Injectable } from "../../decorators/injectable.decorator";
import { DependencyContainer } from "../../di/container";
import type { ProviderDefinition } from "../../di/types";
import { getScheduledMethods, type ScheduledMethodMetadata } from "./schedule.decorators";
import { CronJob, IntervalJob, TimeoutJob, type JobErrorHandler, type ScheduledJob } from "./scheduled-job";
import { SchedulerRegistry } from "./scheduler.registry";

export interface ScheduleRunOptions {
  /** Signals that trigger a graceful stop. Default: `["SIGINT", "SIGTERM"]`; `[]` to listen to none. */
  signals?: NodeJS.Signals[];
  /** Stop gracefully when this aborts. */
  signal?: AbortSignal;
  /** Receives every failed run. Default: logs with `Logger` (context `Schedule`). */
  onError?: JobErrorHandler;
}

/**
 * Finds every `@Cron()`, `@Interval()` and `@Timeout()` method on the providers of the whole
 * module graph, registers them in the {@link SchedulerRegistry} and drives their lifecycle.
 *
 * Nothing is scheduled until {@link start} or {@link run} is called, so commands that don't
 * need the scheduler never pay for it — and never keep the process alive.
 *
 * ```ts
 * class WorkerCommand extends BaseCommand {
 *   name = "worker";
 *   constructor(@Inject(ScheduleOrchestrator) private scheduler: ScheduleOrchestrator) { super(); }
 *   exec() { return this.scheduler.run(); } // until Ctrl+C, then waits for running jobs
 * }
 * ```
 */
@Injectable()
export class ScheduleOrchestrator {
  private discovered = false;

  constructor(
    @Inject(DependencyContainer) private readonly container: DependencyContainer,
    @Inject(SchedulerRegistry) readonly registry: SchedulerRegistry,
  ) {}

  /**
   * Instantiate every provider with scheduled methods and register its jobs (not started).
   * Runs once; later calls return the same jobs. Providers built by `useFactory` are skipped,
   * since their class is unknown until they are created — register those via the registry.
   */
  discover(): ScheduledJob[] {
    if (this.discovered) return this.registry.getJobs();
    this.discovered = true;

    const seen = new Set<object>();
    for (const node of this.container.modules) {
      for (const { token, definition, multiIndex } of node.providerDefinitions()) {
        const cls = providerClass(definition);
        const methods = cls ? getScheduledMethods(cls) : [];
        if (!methods.length) continue;

        const resolved = node.resolve(token);
        const instance = multiIndex === undefined ? resolved : resolved[multiIndex];
        // A useValue instance listed in several modules is still one instance: schedule it once.
        if (seen.has(instance)) continue;
        seen.add(instance);

        for (const metadata of methods) this.register(instance, cls!, metadata);
      }
    }
    return this.registry.getJobs();
  }

  /** Discover and start every job that isn't disabled. */
  start({ onError }: Pick<ScheduleRunOptions, "onError"> = {}): void {
    if (onError) this.registry.onError = onError;
    this.discover();
    this.registry.start();
  }

  /** Stop every job. Resolves once all in-progress runs have finished. */
  stop(): Promise<void> {
    return this.registry.stop();
  }

  /**
   * Start, then keep going until a signal arrives, `signal` aborts, or no job is left to run;
   * then stop gracefully. Meant to be returned from a long-running command's `exec()`.
   *
   * While stopping, the signal listeners are already removed, so a second Ctrl+C falls back to
   * Node's default and terminates the process without waiting for running jobs.
   */
  async run({ signals = ["SIGINT", "SIGTERM"], signal, onError }: ScheduleRunOptions = {}): Promise<void> {
    signal?.throwIfAborted();

    let release!: () => void;
    const stopRequested = new Promise<void>((resolve) => (release = resolve));
    const listeners = () => {
      for (const name of signals) process.off(name, release);
      signal?.removeEventListener("abort", release);
    };
    for (const name of signals) process.once(name, release);
    signal?.addEventListener("abort", release, { once: true });

    try {
      this.start({ onError });
      await Promise.race([stopRequested, this.registry.whenIdle()]);
    } finally {
      listeners();
      await this.stop();
    }
  }

  private register(instance: any, cls: Function, metadata: ScheduledMethodMetadata): void {
    const { method, options } = metadata;
    const callback = () => instance[method]();
    const name = options.name ?? this.uniqueName(`${cls.name}.${String(method)}`);

    const job =
      metadata.kind === "cron"
        ? new CronJob(name, metadata.expression, callback, metadata.options)
        : metadata.kind === "interval"
          ? new IntervalJob(name, metadata.ms, callback, metadata.options)
          : new TimeoutJob(name, metadata.ms, callback, metadata.options);

    this.registry.add(job, { disabled: options.disabled });
  }

  /** Default names may repeat when one class is provided by several modules: suffix them. */
  private uniqueName(base: string): string {
    let name = base;
    for (let i = 2; this.registry.has(name); i++) name = `${base}#${i}`;
    return name;
  }
}

/** The class a provider is (or will be) an instance of, when known without creating it. */
function providerClass(definition: ProviderDefinition): Function | undefined {
  if ("useClass" in definition) return definition.useClass;
  if ("useValue" in definition) {
    const value: unknown = definition.useValue;
    if (value !== null && typeof value === "object") return value.constructor;
  }
  return undefined;
}
