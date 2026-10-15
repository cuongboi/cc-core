import { Cron } from "croner";
import { Logger } from "../logger.service";

export type ScheduleKind = "cron" | "interval" | "timeout";

export type JobCallback = () => unknown;

export type JobErrorHandler = (error: unknown, job: ScheduledJob) => void;

export interface JobOptions {
  /**
   * Start a run even if the previous one hasn't finished. By default a tick that fires while the
   * job is still running is skipped, so slow jobs never pile up.
   */
  allowOverlap?: boolean;
  /** Run once immediately when the job starts, in addition to its schedule. */
  runOnStart?: boolean;
}

export interface CronJobOptions extends JobOptions {
  /** IANA time zone the expression is evaluated in, e.g. `"Asia/Ho_Chi_Minh"`. Default: local time. */
  timeZone?: string;
}

/** `setTimeout` clamps larger delays to 1ms, which would fire a "monthly" timer immediately. */
const MAX_DELAY_MS = 2 ** 31 - 1;

const logger = new Logger("Schedule");

export const defaultJobErrorHandler: JobErrorHandler = (error, job) => {
  logger.error({ err: error, job: job.name }, `${job.kind} job "${job.name}" failed`);
};

/**
 * A named unit of scheduled work. Runs never overlap unless `allowOverlap` is set, and a run that
 * throws or rejects is reported to {@link onError} instead of crashing the process.
 */
export abstract class ScheduledJob {
  abstract readonly kind: ScheduleKind;

  /** Called when a run throws or rejects. The registry points this at its own handler. */
  onError: JobErrorHandler = defaultJobErrorHandler;
  /** @internal Notified whenever the job may have become inactive. */
  onSettled?: () => void;

  /** When the latest run started. */
  lastRunAt: Date | undefined;
  /** Number of runs started so far. */
  runCount = 0;

  private scheduled = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    readonly name: string,
    protected readonly callback: JobCallback,
    readonly options: JobOptions = {},
  ) {}

  /** The next time the schedule will fire, or `null` if it won't. */
  abstract get nextRunAt(): Date | null;

  protected abstract schedule(): void;
  protected abstract unschedule(): void;

  /** Whether the schedule is armed, i.e. a future run is expected. */
  get isScheduled(): boolean {
    return this.scheduled;
  }

  /** Whether a run is in progress right now. */
  get isRunning(): boolean {
    return this.inFlight.size > 0;
  }

  /** Scheduled or still running: a job that can still do work. */
  get isActive(): boolean {
    return this.scheduled || this.isRunning;
  }

  /** Arm the schedule. Starting a started job does nothing. */
  start(): this {
    if (this.scheduled) return this;
    this.scheduled = true;
    this.schedule();
    if (this.options.runOnStart) this.tick();
    return this;
  }

  /** Disarm the schedule. Resolves once every in-progress run has finished. */
  stop(): Promise<void> {
    if (this.scheduled) {
      this.scheduled = false;
      this.unschedule();
      this.onSettled?.();
    }
    return this.drain();
  }

  /** Resolves once every in-progress run has finished, including runs started meanwhile. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all(this.inFlight);
  }

  /**
   * Run the job now, outside its schedule and regardless of overlap. Never rejects: failures go
   * to {@link onError}. Resolves when the run has finished.
   */
  run(): Promise<void> {
    this.lastRunAt = new Date();
    this.runCount++;

    const run: Promise<void> = (async () => {
      try {
        await this.callback();
      } catch (error) {
        this.reportError(error);
      }
    })().finally(() => {
      this.inFlight.delete(run);
      this.onSettled?.();
    });
    this.inFlight.add(run);
    return run;
  }

  /** A scheduled firing: skipped while a previous run is still in progress, unless overlap is allowed. */
  protected tick(): void {
    if (this.isRunning && !this.options.allowOverlap) return;
    void this.run();
  }

  /** Mark a one-shot schedule as spent, without touching timers. */
  protected finish(): void {
    this.scheduled = false;
    this.onSettled?.();
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error, this);
    } catch (handlerError) {
      // A failing handler must not become an unhandled rejection that takes the process down.
      defaultJobErrorHandler(handlerError, this);
    }
  }
}

/** Runs on a cron expression: 5 fields (minute precision) or 6 fields (leading seconds). */
export class CronJob extends ScheduledJob {
  readonly kind = "cron";
  /** Evaluates the expression; never fires, so it holds no timer. */
  private readonly pattern: Cron;
  private timer: Cron | undefined;

  constructor(
    name: string,
    readonly expression: string,
    callback: JobCallback,
    override readonly options: CronJobOptions = {},
  ) {
    super(name, callback, options);
    try {
      this.pattern = new Cron(expression, { timezone: options.timeZone });
      this.pattern.nextRun(); // an unknown time zone only surfaces when a date is computed
    } catch (error) {
      throw new TypeError(`Invalid cron job "${name}" ("${expression}"): ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  get nextRunAt(): Date | null {
    return this.isScheduled ? this.pattern.nextRun() : null;
  }

  protected schedule(): void {
    this.timer = new Cron(this.expression, { timezone: this.options.timeZone }, () => this.tick());
  }

  protected unschedule(): void {
    this.timer?.stop();
    this.timer = undefined;
  }
}

/** Runs every `ms` milliseconds, first after one full interval. */
export class IntervalJob extends ScheduledJob {
  readonly kind = "interval";
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextAt: number | undefined;

  constructor(
    name: string,
    readonly ms: number,
    callback: JobCallback,
    options?: JobOptions,
  ) {
    super(name, callback, options);
    assertDelay(name, ms, 1); // a 0ms interval would spin the event loop
  }

  get nextRunAt(): Date | null {
    return this.nextAt === undefined ? null : new Date(this.nextAt);
  }

  protected schedule(): void {
    this.nextAt = Date.now() + this.ms;
    this.timer = setInterval(() => {
      this.nextAt = Date.now() + this.ms;
      this.tick();
    }, this.ms);
  }

  protected unschedule(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.nextAt = undefined;
  }
}

/** Runs once, `ms` milliseconds after it starts. Starting it again re-arms it. */
export class TimeoutJob extends ScheduledJob {
  readonly kind = "timeout";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextAt: number | undefined;

  constructor(
    name: string,
    readonly ms: number,
    callback: JobCallback,
    options?: JobOptions,
  ) {
    super(name, callback, options);
    assertDelay(name, ms, 0);
  }

  get nextRunAt(): Date | null {
    return this.nextAt === undefined ? null : new Date(this.nextAt);
  }

  protected schedule(): void {
    this.nextAt = Date.now() + this.ms;
    this.timer = setTimeout(() => {
      this.timer = this.nextAt = undefined;
      this.tick();
      this.finish();
    }, this.ms);
  }

  protected unschedule(): void {
    clearTimeout(this.timer);
    this.timer = this.nextAt = undefined;
  }
}

function assertDelay(name: string, ms: number, min: number): void {
  if (!Number.isFinite(ms) || ms < min || ms > MAX_DELAY_MS) {
    throw new RangeError(`Invalid delay for job "${name}": expected ${min}–${MAX_DELAY_MS} ms, got ${ms}.`);
  }
}
