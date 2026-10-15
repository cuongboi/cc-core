import { Injectable } from "../../decorators/injectable.decorator";
import {
  CronJob,
  IntervalJob,
  TimeoutJob,
  defaultJobErrorHandler,
  type CronJobOptions,
  type JobCallback,
  type JobErrorHandler,
  type JobOptions,
  type ScheduleKind,
  type ScheduledJob,
} from "./scheduled-job";

/**
 * Every scheduled job by name, and their shared lifecycle. Jobs added while the registry is
 * started are started right away; jobs added before wait for {@link start}.
 *
 * ```ts
 * registry.addCron("backup", CronExpression.EVERY_DAY_AT_2AM, () => backup());
 * registry.get("backup")?.nextRunAt;
 * await registry.delete("backup");
 * ```
 */
@Injectable()
export class SchedulerRegistry {
  /** Receives every failed run. Default: logs with `Logger` (context `Schedule`). */
  onError: JobErrorHandler = defaultJobErrorHandler;

  private readonly jobs = new Map<string, ScheduledJob>();
  /** Jobs registered as `disabled`: kept, but not started by {@link start}. */
  private readonly disabled = new WeakSet<ScheduledJob>();
  private readonly idleWaiters = new Set<() => void>();
  private started = false;

  get isStarted(): boolean {
    return this.started;
  }

  /** Register a job under its name, which must be unique. */
  add<J extends ScheduledJob>(job: J, { disabled = false }: { disabled?: boolean } = {}): J {
    if (this.jobs.has(job.name)) {
      throw new Error(`A scheduled job named "${job.name}" already exists.`);
    }
    job.onError = (error, failed) => this.onError(error, failed);
    job.onSettled = () => this.checkIdle();
    this.jobs.set(job.name, job);
    if (disabled) this.disabled.add(job);
    else if (this.started) job.start();
    return job;
  }

  addCron(name: string, expression: string, callback: JobCallback, options?: CronJobOptions): CronJob {
    return this.add(new CronJob(name, expression, callback, options));
  }

  addInterval(name: string, ms: number, callback: JobCallback, options?: JobOptions): IntervalJob {
    return this.add(new IntervalJob(name, ms, callback, options));
  }

  addTimeout(name: string, ms: number, callback: JobCallback, options?: JobOptions): TimeoutJob {
    return this.add(new TimeoutJob(name, ms, callback, options));
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }

  get(name: string): ScheduledJob | undefined {
    return this.jobs.get(name);
  }

  /** Every job, or only those of one kind, in registration order. */
  getJobs(kind?: ScheduleKind): ScheduledJob[] {
    const jobs = [...this.jobs.values()];
    return kind ? jobs.filter((job) => job.kind === kind) : jobs;
  }

  /**
   * Stop a job and forget it, so its name can be reused.
   * Resolves `true` once its in-progress runs have finished, or `false` if there was no such job.
   */
  async delete(name: string): Promise<boolean> {
    const job = this.jobs.get(name);
    if (!job) return false;
    this.jobs.delete(name);
    await job.stop();
    job.onSettled = undefined;
    this.checkIdle();
    return true;
  }

  /** Start every job that wasn't registered as disabled. */
  start(): void {
    this.started = true;
    for (const job of this.jobs.values()) {
      if (!this.disabled.has(job)) job.start();
    }
    this.checkIdle();
  }

  /** Stop every job. Resolves once all in-progress runs have finished. */
  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.jobs.values()].map((job) => job.stop()));
  }

  /**
   * Resolves once no job is scheduled or running — e.g. every timeout has fired and finished.
   * A cron or interval job that is started keeps the registry busy until stopped.
   */
  whenIdle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private isBusy(): boolean {
    for (const job of this.jobs.values()) if (job.isActive) return true;
    return false;
  }

  private checkIdle(): void {
    if (!this.idleWaiters.size || this.isBusy()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
