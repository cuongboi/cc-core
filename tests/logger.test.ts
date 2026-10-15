import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DependencyContainer, LOG_LEVELS, Logger, Module, type LogWriter } from "../src/index";

@Module({ providers: [Logger], exports: [Logger] })
class LoggingModule {}

const capture = () => {
  const lines: string[] = [];
  const stream: LogWriter = { write: (chunk: string) => lines.push(chunk) };
  return { lines, stream };
};

describe("Logger", () => {
  let out: ReturnType<typeof capture>;

  beforeEach(() => {
    out = capture();
    Logger.configure({ stream: out.stream, colors: false });
  });

  afterEach(() => {
    Logger.resetConfig();
    vi.unstubAllEnvs();
  });

  describe("pretty format", () => {
    it("writes the level, context and interpolated message", () => {
      const logger = new Logger("Deploy");
      logger.info("Uploading %d files", 3);
      logger.warn("slow");
      new Logger().info("no context");
      expect(out.lines).toEqual(["INFO: [Deploy] Uploading 3 files\n", "WARN: [Deploy] slow\n", "INFO: no context\n"]);
    });

    it("prints structured fields and error stacks, including causes", () => {
      const logger = new Logger("Db");
      logger.info({ table: "users" }, "migrated");
      logger.error(new Error("timeout", { cause: new Error("ECONNRESET") }), "query failed");
      expect(out.lines[0]).toBe("INFO: [Db] migrated\n    table: \"users\"\n");
      expect(out.lines[1]).toMatch(/^ERROR: \[Db\] query failed\n\s+err: \{[\s\S]*Error: timeout\n\s+at [\s\S]*caused by: Error: ECONNRESET/);
    });

    it("adds a local timestamp on request", () => {
      Logger.configure({ timestamp: true });
      new Logger().info("hi");
      expect(out.lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] INFO: hi\n$/);
    });

    it("colors on a TTY, honouring NO_COLOR and FORCE_COLOR", () => {
      vi.stubEnv("NO_COLOR", undefined);
      vi.stubEnv("FORCE_COLOR", undefined);
      const terminal = capture();
      const tty: LogWriter = { ...terminal.stream, isTTY: true };

      Logger.configure({ colors: undefined });
      new Logger("C", { stream: tty }).error("x");
      new Logger("C").error("x");
      expect(terminal.lines[0]).toContain("\x1b[");
      expect(out.lines[0]).toBe("ERROR: [C] x\n");

      vi.stubEnv("NO_COLOR", "1");
      new Logger("C", { stream: tty }).error("x");
      expect(terminal.lines[1]).toBe("ERROR: [C] x\n");

      vi.stubEnv("NO_COLOR", undefined);
      vi.stubEnv("FORCE_COLOR", "1");
      Logger.configure({}); // the environment is read when pino is (re)built
      new Logger("C").error("x");
      expect(out.lines[1]).toContain("\x1b[");
    });
  });

  describe("json format", () => {
    beforeEach(() => Logger.configure({ format: "json" }));

    const parse = () => out.lines.map((line) => JSON.parse(line));

    it("writes pino NDJSON with label levels, ISO time and context", () => {
      new Logger("Api").warn({ attempt: 1 }, "retry %d/%d", 1, 3);
      const [record] = parse();
      expect(record).toEqual({ level: "warn", time: expect.any(String), context: "Api", attempt: 1, msg: "retry 1/3" });
      expect(new Date(record.time).toISOString()).toBe(record.time);
    });

    it("serializes errors with pino's err serializer", () => {
      const error = Object.assign(new Error("request failed", { cause: new Error("ECONNRESET") }), { status: 503 });
      new Logger().error(error, "call failed");
      new Logger().error(error);
      const [withMessage, alone] = parse();
      expect(withMessage).toMatchObject({ msg: "call failed", err: { type: "Error", status: 503, message: "request failed: ECONNRESET" } });
      expect(withMessage.err.stack).toContain("caused by: Error: ECONNRESET");
      expect(alone.msg).toBe("request failed");
    });

    it("accepts raw pino options", () => {
      Logger.configure({ pino: { redact: ["password"] } });
      new Logger().info({ user: "a", password: "secret" }, "login");
      expect(parse()[0]).toMatchObject({ user: "a", password: "[Redacted]" });
    });
  });

  describe("levels", () => {
    it("default to 'info'", () => {
      const logger = new Logger();
      for (const level of LOG_LEVELS) logger[level](level);
      expect(out.lines.map((line) => line.split(":")[0])).toEqual(["FATAL", "ERROR", "WARN", "INFO"]);
      expect(logger.level).toBe("info");
      expect(logger.isLevelEnabled("debug")).toBe(false);
    });

    it("follow global configuration, even for existing loggers", () => {
      const logger = new Logger();
      Logger.configure({ level: "trace" });
      logger.trace("now visible");
      Logger.configure({ level: "silent" });
      logger.fatal("hidden");
      expect(out.lines).toEqual(["TRACE: now visible\n"]);
    });

    it("can be overridden per logger, ignoring undefined values", () => {
      const own = capture();
      const logger = new Logger("Own", { level: "error", stream: own.stream, format: undefined });
      Logger.configure({ level: "trace" });
      logger.warn("hidden");
      logger.error("shown");
      expect(own.lines).toEqual(["ERROR: [Own] shown\n"]);
      expect(out.lines).toEqual([]);
    });

    it("read LOG_LEVEL when none is configured, case-insensitively", () => {
      vi.stubEnv("LOG_LEVEL", "DEBUG");
      new Logger().debug("from env");
      vi.stubEnv("LOG_LEVEL", "nonsense");
      new Logger().debug("ignored");
      expect(out.lines).toEqual(["DEBUG: from env\n"]);
    });

    it("reject invalid values", () => {
      expect(() => Logger.configure({ level: "log" as never })).toThrow(/Invalid log level "log"/);
      expect(() => new Logger("x", { level: "loud" as never })).toThrow(TypeError);
    });
  });

  it("builds child contexts with extra bindings and the parent's options", () => {
    const own = capture();
    const child = new Logger("Deploy", { stream: own.stream, format: "json" }).child("S3", { bucket: "b" });
    child.info("put");
    expect(child.context).toBe("Deploy:S3");
    expect(JSON.parse(own.lines[0]!)).toMatchObject({ context: "Deploy:S3", bucket: "b", msg: "put" });
  });

  it("exposes the underlying pino logger", () => {
    const logger = new Logger("Raw");
    expect(logger.raw.bindings()).toEqual({ context: "Raw" });
    Logger.configure({ level: "warn" });
    expect(logger.raw.level).toBe("warn"); // rebuilt after configure()
  });

  it("can be resolved from the container as a plain provider", () => {
    const logger = new DependencyContainer().getOrCreateModuleNode(LoggingModule).resolve(Logger);
    expect(logger).toBeInstanceOf(Logger);
    expect(logger.context).toBeUndefined();
    logger.info("injected");
    expect(out.lines).toEqual(["INFO: injected\n"]);
  });
});
