import pino, {
  type Bindings,
  type DestinationStream,
  type Level,
  type LevelWithSilent,
  type LogFn,
  type Logger as PinoLogger,
  type LoggerOptions as PinoOptions,
} from "pino";
import { prettyFactory } from "pino-pretty";

export type { PinoLogger, PinoOptions };

/** Severities, most severe first. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const satisfies readonly Level[];

export type LogLevel = Level;

/** The least severe level still written, or `"silent"` to write nothing. */
export type LogThreshold = LevelWithSilent;

export type LogFormat = "pretty" | "json";

/** Anything with a `write(string)` method, e.g. `process.stdout` or a test buffer. */
export interface LogWriter extends DestinationStream {
  isTTY?: boolean;
}

export interface LoggerOptions {
  /** Default: `$LOG_LEVEL` if valid, otherwise `"info"`. */
  level?: LogThreshold;
  /** `"pretty"` (via pino-pretty) for people, `"json"` (pino's NDJSON) for log collectors. Default: `"pretty"`. */
  format?: LogFormat;
  /** Prefix pretty lines with the local time. JSON always includes it. Default: `false`. */
  timestamp?: boolean;
  /** Default: on for a TTY, honouring `NO_COLOR` and `FORCE_COLOR`. Pretty format only. */
  colors?: boolean;
  /** Default: stderr, so logs never mix into a command's piped output. */
  stream?: LogWriter;
  /** Passed to `pino()` last, overriding anything above: serializers, redact, mixin, … */
  pino?: PinoOptions;
}

export const isLogThreshold = (value: unknown): value is LogThreshold =>
  typeof value === "string" && (value === "silent" || (LOG_LEVELS as readonly string[]).includes(value));

const assertThreshold = (level: unknown): void => {
  if (level !== undefined && !isLogThreshold(level)) {
    throw new TypeError(`Invalid log level "${String(level)}". Expected one of: silent, ${LOG_LEVELS.join(", ")}.`);
  }
};

const envThreshold = (): LogThreshold | undefined => {
  const value = process.env.LOG_LEVEL?.trim().toLowerCase();
  return isLogThreshold(value) ? value : undefined;
};

const supportsColor = (stream: LogWriter): boolean => {
  if ("NO_COLOR" in process.env && process.env.NO_COLOR !== "") return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  return stream.isTTY === true;
};

/** So `{ level: undefined }` falls back to the next source instead of erasing it. */
const definedOnly = <T extends object>(object: T): Partial<T> =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as Partial<T>;

/**
 * Pretty output is formatted synchronously in-process rather than through a pino transport:
 * transports run in a worker thread, and a CLI that calls `process.exit()` would lose lines.
 */
const createRoot = (options: LoggerOptions): PinoLogger => {
  const stream: LogWriter = options.stream ?? pino.destination({ dest: 2, sync: true });

  if (options.format === "json") {
    return pino(
      {
        level: "trace", // each Logger sets its own level on its child
        base: null,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        ...options.pino,
      },
      stream,
    );
  }

  const prettify = prettyFactory({
    colorize: options.colors ?? supportsColor(options.stream ?? process.stderr),
    translateTime: "SYS:HH:MM:ss.l",
    ignore: options.timestamp ? "pid,hostname,context" : "pid,hostname,time,context",
    messageFormat: "{if context}[{context}] {end}{msg}",
  });
  return pino({ level: "trace", ...options.pino }, { write: (line: string) => stream.write(prettify(line)) });
};

/**
 * A context-aware wrapper around [pino](https://getpino.io), pretty-printed by pino-pretty.
 *
 * ```ts
 * const logger = new Logger("Deploy");
 * logger.info("Uploading %d files", files.length);   // INFO: [Deploy] Uploading 3 files
 * logger.error(error, "Upload failed");              // pino style: error (or object) first
 * logger.info({ bucket }, "Uploaded");               // structured fields
 *
 * Logger.configure({ level: "debug" });              // e.g. from a --verbose flag
 * Logger.configure({ format: "json" });              // pino's NDJSON, for log collectors
 * ```
 *
 * Every logger follows the global options set with {@link Logger.configure}, even loggers created
 * before the call, unless overridden by its own constructor options. The underlying pino logger is
 * built lazily and rebuilt after each `configure()`.
 *
 * Not decorated with `@Injectable()`, so listing it as a plain provider gives a logger without a
 * context. Usually you create one per class instead: `private logger = new Logger(MyService.name)`.
 */
export class Logger {
  private static globalOptions: LoggerOptions = {};
  private static generation = 0;
  private static sharedRoot: PinoLogger | undefined;

  /** Merge into the options shared by every logger. Pass `undefined` for a key to reset it. */
  static configure(options: LoggerOptions): void {
    assertThreshold(options.level);
    Logger.globalOptions = { ...Logger.globalOptions, ...options };
    Logger.invalidate();
  }

  /** Restore every global option to its default. */
  static resetConfig(): void {
    Logger.globalOptions = {};
    Logger.invalidate();
  }

  private static invalidate(): void {
    Logger.sharedRoot?.flush();
    Logger.sharedRoot = undefined;
    Logger.generation++;
  }

  private cache: { generation: number; instance: PinoLogger } | undefined;

  constructor(
    readonly context: string | undefined = undefined,
    private readonly options: LoggerOptions = {},
    private readonly bindings: Bindings = {},
  ) {
    assertThreshold(options.level);
  }

  /** The underlying pino logger, for anything this wrapper doesn't expose. */
  get raw(): PinoLogger {
    if (this.cache?.generation !== Logger.generation) {
      this.cache = { generation: Logger.generation, instance: this.build() };
    }
    return this.cache.instance;
  }

  /** The threshold this logger was last built with. */
  get level(): LogThreshold {
    return this.raw.level as LogThreshold;
  }

  /** A logger with the context `parent:context`, the same options, and extra `bindings` on every line. */
  child(context: string, bindings: Bindings = {}): Logger {
    return new Logger(this.context ? `${this.context}:${context}` : context, this.options, {
      ...this.bindings,
      ...bindings,
    });
  }

  /** Guard expensive message construction: `if (logger.isLevelEnabled("debug")) …`. */
  isLevelEnabled(level: LogLevel): boolean {
    return this.raw.isLevelEnabled(level);
  }

  readonly fatal: LogFn = this.delegate("fatal");
  readonly error: LogFn = this.delegate("error");
  readonly warn: LogFn = this.delegate("warn");
  readonly info: LogFn = this.delegate("info");
  readonly debug: LogFn = this.delegate("debug");
  readonly trace: LogFn = this.delegate("trace");

  private delegate(level: Level): LogFn {
    return ((...args: unknown[]) => (this.raw[level] as (...args: unknown[]) => void)(...args)) as LogFn;
  }

  private build(): PinoLogger {
    const { level, ...own } = definedOnly(this.options);
    // Loggers that only override the level share one root; others need their own destination.
    const root = Object.keys(own).length
      ? createRoot({ ...Logger.globalOptions, ...own })
      : (Logger.sharedRoot ??= createRoot(Logger.globalOptions));

    return root.child(
      { ...(this.context && { context: this.context }), ...this.bindings },
      { level: level ?? Logger.globalOptions.level ?? envThreshold() ?? "info" },
    );
  }
}
