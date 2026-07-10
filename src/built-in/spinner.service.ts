import ora, { type Ora, type Options as OraOptions } from "ora";
import { Injectable } from "../decorators/injectable.decorator";

export type { OraOptions };

/**
 * A thin, injectable wrapper around the `ora` spinner library.
 *
 * @example
 * ```ts
 * const spinner = new SpinnerService();
 *
 * spinner.start("Fetching data…");
 * await fetchData();
 * spinner.succeed("Done!");
 * ```
 */
@Injectable()
export class SpinnerService {
  private instance: Ora | null = null;

  /**
   * Start a new spinner. If one is already running it is stopped first.
   * @param text  Initial spinner text.
   * @param opts  Additional ora options.
   */
  start(text: string, opts: OraOptions = {}): this {
    if (this.instance?.isSpinning) {
      this.instance.stop();
    }
    this.instance = ora({ text, ...opts }).start();
    return this;
  }

  /** Mark the current spinner as succeeded and stop it. */
  succeed(text?: string): this {
    this.instance?.succeed(text);
    return this;
  }

  /** Mark the current spinner as failed and stop it. */
  fail(text?: string): this {
    this.instance?.fail(text);
    return this;
  }

  /** Mark the current spinner with a warning and stop it. */
  warn(text?: string): this {
    this.instance?.warn(text);
    return this;
  }

  /** Mark the current spinner with an info symbol and stop it. */
  info(text?: string): this {
    this.instance?.info(text);
    return this;
  }

  /** Stop the spinner without a result symbol. */
  stop(): this {
    this.instance?.stop();
    return this;
  }

  /** Update the spinner text while it is still running. */
  setText(text: string): this {
    if (this.instance) {
      this.instance.text = text;
    }
    return this;
  }

  /** Whether the spinner is currently spinning. */
  get isSpinning(): boolean {
    return this.instance?.isSpinning ?? false;
  }

  /** Direct access to the underlying `ora` instance (if any). */
  get raw(): Ora | null {
    return this.instance;
  }
}
