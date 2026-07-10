import {
  SingleBar,
  MultiBar,
  Presets,
  type Options as CliProgressOptions,
  type GenericBar,
} from "cli-progress";
import { Injectable } from "../decorators/injectable.decorator";

export type { CliProgressOptions, GenericBar };
export { Presets };

/**
 * A thin, injectable wrapper around the `cli-progress` library.
 *
 * Supports both single-bar and multi-bar scenarios.
 *
 * @example Single bar
 * ```ts
 * const progress = new ProgressService();
 * progress.start(100, 0, { title: "Downloading" });
 * for (let i = 0; i <= 100; i++) {
 *   progress.update(i);
 *   await wait(10);
 * }
 * progress.stop();
 * ```
 *
 * @example Multi-bar
 * ```ts
 * const progress = new ProgressService();
 * progress.startMulti();
 * const bar1 = progress.addBar(100, 0, { label: "File 1" });
 * const bar2 = progress.addBar(50, 0,  { label: "File 2" });
 * bar1.increment(10);
 * bar2.increment(5);
 * progress.stop();
 * ```
 */
@Injectable()
export class ProgressService {
  private single: SingleBar | null = null;
  private multi: MultiBar | null = null;

  // ── Single-bar ──────────────────────────────────────────────────────────

  /**
   * Start a single progress bar.
   * @param total    The total value (100 % mark).
   * @param startValue  Initial value (default 0).
   * @param payload  Extra tokens passed to the bar format string.
   * @param opts     cli-progress options (theme, format, …).
   */
  start(total: number, startValue = 0, payload: object = {}, opts: CliProgressOptions = {}): this {
    this.single = new SingleBar(
      {
        format: "{bar} {percentage}% | {value}/{total}",
        barCompleteChar: "█",
        barIncompleteChar: "░",
        hideCursor: true,
        ...opts,
      },
      Presets.shades_classic,
    );
    this.single.start(total, startValue, payload);
    return this;
  }

  /**
   * Update the current value of the single bar.
   * @param value    New value, or an increment amount when `increment` is true.
   * @param payload  Optional payload tokens.
   */
  update(value: number, payload: object = {}): this {
    this.single?.update(value, payload);
    return this;
  }

  /** Increment the single bar by `amount` (default 1). */
  increment(amount = 1, payload: object = {}): this {
    this.single?.increment(amount, payload);
    return this;
  }

  // ── Multi-bar ───────────────────────────────────────────────────────────

  /**
   * Initialize a multi-bar container.
   * @param opts  cli-progress options shared by all child bars.
   */
  startMulti(opts: CliProgressOptions = {}): this {
    this.multi = new MultiBar(
      {
        format: "{label} {bar} {percentage}% | {value}/{total}",
        barCompleteChar: "█",
        barIncompleteChar: "░",
        hideCursor: true,
        clearOnComplete: false,
        ...opts,
      },
      Presets.shades_classic,
    );
    return this;
  }

  /**
   * Add a child bar to the multi-bar container.
   * Must call `startMulti()` first.
   *
   * @returns The created `SingleBar` instance for individual control.
   */
  addBar(total: number, startValue = 0, payload: object = {}): GenericBar {
    if (!this.multi) {
      throw new Error("Call startMulti() before addBar().");
    }
    return this.multi.create(total, startValue, payload);
  }

  // ── Shared ──────────────────────────────────────────────────────────────

  /** Stop the active single bar or multi-bar container. */
  stop(): this {
    this.single?.stop();
    this.single = null;
    this.multi?.stop();
    this.multi = null;
    return this;
  }

  /** Direct access to the underlying `SingleBar` (if any). */
  get rawSingle(): SingleBar | null {
    return this.single;
  }

  /** Direct access to the underlying `MultiBar` (if any). */
  get rawMulti(): MultiBar | null {
    return this.multi;
  }
}
