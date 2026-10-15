import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BaseCommand,
  Cron,
  CronExpression,
  CronJob,
  DependencyContainer,
  Inject,
  Injectable,
  Interval,
  IntervalJob,
  Logger,
  Module,
  ScheduleModule,
  ScheduleOrchestrator,
  SchedulerRegistry,
  Timeout,
  TimeoutJob,
  createProgram,
  getScheduledMethods,
  loadCommand,
} from "../src/index";

// ---------------------------------------------------------------------------
// Fixtures (top level: decorators inside function bodies are unreliable with oxc)
// ---------------------------------------------------------------------------

const log: string[] = [];

@Injectable()
class Clock {
  now() {
    return "tick";
  }
}

@Injectable()
class ReportTasks {
  constructor(@Inject(Clock) private clock: Clock) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  every5s() {
    log.push(`cron:${this.clock.now()}`);
  }

  @Interval("poll", 1000)
  poll() {
    log.push("interval");
  }

  @Timeout(2500, { name: "warmup" })
  warmup() {
    log.push("timeout");
  }

  @Cron(CronExpression.EVERY_SECOND, { name: "off", disabled: true })
  off() {
    log.push("disabled-ran");
  }
}

@Module({ providers: [Clock, ReportTasks] })
class ReportsModule {}

@Module({ imports: [ScheduleModule, ReportsModule] })
class AppModule {}

class BaseTasks {
  @Interval(1000)
  base() {
    log.push("base");
  }

  @Interval(1000)
  overridden() {
    log.push("parent-overridden");
  }
}

@Injectable()
class ChildTasks extends BaseTasks {
  @Timeout(500)
  override overridden() {
    log.push("child-overridden");
  }
}

class ValueTasks {
  @Timeout(10)
  fire() {
    log.push("value");
  }
}

class FactoryTasks {
  @Timeout(10)
  fire() {
    log.push("factory");
  }
}

const sharedValue = new ValueTasks();

@Module({
  imports: [ScheduleModule],
  providers: [
    ChildTasks,
    { provide: "value", useValue: sharedValue },
    { provide: "value-again", useValue: sharedValue },
    { provide: "factory", useFactory: () => new FactoryTasks() },
  ],
})
class MixedModule {}

@Injectable()
class OnlyTimeouts {
  @Timeout(100)
  first() {
    log.push("first");
  }

  @Timeout(300)
  async second() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    log.push("second");
  }
}

class WorkerCommand extends BaseCommand {
  name = "worker";
  constructor(@Inject(ScheduleOrchestrator) private scheduler: ScheduleOrchestrator) {
    super();
  }
  exec() {
    return this.scheduler.run({ signals: [] });
  }
}

@Module({ imports: [ScheduleModule], providers: [OnlyTimeouts], commands: [WorkerCommand] })
class WorkerModule {}

const orchestratorFor = (root: Function) =>
  new DependencyContainer().getOrCreateModuleNode(root as any).resolve(ScheduleOrchestrator);

beforeEach(() => {
  log.length = 0;
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("CronExpression", () => {
  it.each(Object.entries(CronExpression))("%s is a valid expression", (_, expression) => {
    expect(() => new CronJob("probe", expression, () => {})).not.toThrow();
  });
});

describe("schedule decorators", () => {
  it("record each scheduled method with its options", () => {
    expect(getScheduledMethods(ReportTasks)).toEqual([
      { kind: "cron", method: "every5s", expression: "*/5 * * * * *", options: {} },
      { kind: "interval", method: "poll", ms: 1000, options: { name: "poll" } },
      { kind: "timeout", method: "warmup", ms: 2500, options: { name: "warmup" } },
      { kind: "cron", method: "off", expression: "* * * * * *", options: { name: "off", disabled: true } },
    ]);
  });

  it("inherit parent schedules, letting a subclass redeclare a method's schedule", () => {
    expect(getScheduledMethods(ChildTasks).map(({ kind, method }) => `${kind}:${String(method)}`)).toEqual([
      "interval:base",
      "timeout:overridden",
    ]);
  });

  it("reject invalid schedules when the class is defined", () => {
    const proto = {};
    const descriptor = { value: () => {} };
    expect(() => Cron("61 * * * *")(proto, "m", descriptor)).toThrow(/Invalid cron job "Object.m"/);
    expect(() => Cron("* * * * *", { timeZone: "Mars/Olympus" })(proto, "m", descriptor)).toThrow(TypeError);
    expect(() => Interval(0)(proto, "m", descriptor)).toThrow(RangeError);
    expect(() => Timeout(-1)(proto, "m", descriptor)).toThrow(RangeError);
    expect(() => Timeout(2 ** 31)(proto, "m", descriptor)).toThrow(RangeError);
  });

  it("reject static methods", () => {
    class Static {}
    expect(() => Interval(10)(Static, "m", { value: () => {} })).toThrow(/static method Static.m/);
  });
});

describe("ScheduleOrchestrator", () => {
  it("discovers scheduled providers across the module graph, with DI intact", async () => {
    const orchestrator = orchestratorFor(AppModule);
    const names = orchestrator.discover().map((job) => `${job.kind}:${job.name}`);
    expect(names).toEqual(["cron:ReportTasks.every5s", "interval:poll", "timeout:warmup", "cron:off"]);

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(5000);
    await orchestrator.stop();

    expect(log.filter((entry) => entry === "interval")).toHaveLength(5);
    expect(log.filter((entry) => entry === "cron:tick")).toHaveLength(1);
    expect(log.filter((entry) => entry === "timeout")).toHaveLength(1);
    expect(log).not.toContain("disabled-ran");
  });

  it("schedules nothing until started, and nothing after stopping", async () => {
    const orchestrator = orchestratorFor(AppModule);
    orchestrator.discover();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual([]);

    orchestrator.start();
    await orchestrator.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual([]);
    expect(orchestrator.registry.getJobs().every((job) => !job.isActive && job.nextRunAt === null)).toBe(true);
  });

  it("schedules useValue instances once, uses the subclass's methods, and skips factories", async () => {
    const orchestrator = orchestratorFor(MixedModule);
    expect(orchestrator.discover().map((job) => job.name)).toEqual([
      "ChildTasks.base",
      "ChildTasks.overridden",
      "ValueTasks.fire",
    ]);

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(1000);
    await orchestrator.stop();
    expect(log.sort()).toEqual(["base", "child-overridden", "value"]);
  });

  it("suffixes default names when one class is provided by several modules", () => {
    @Module({ providers: [ChildTasks] })
    class Other {}
    @Module({ imports: [ScheduleModule, MixedModule, Other] })
    class Root {}

    const names = orchestratorFor(Root).discover().map((job) => job.name);
    expect(names).toEqual(expect.arrayContaining(["ChildTasks.base", "ChildTasks.base#2"]));
  });

  it("is not started by building the program", async () => {
    createProgram(WorkerModule, { name: "cli" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toEqual([]);
  });

  it("run() resolves once every timeout has fired and finished", async () => {
    const done = vi.fn();
    void orchestratorFor(WorkerModule).run({ signals: [] }).then(done);

    await vi.advanceTimersByTimeAsync(300);
    expect(log).toEqual(["first"]);
    expect(done).not.toHaveBeenCalled(); // `second` is still running

    await vi.advanceTimersByTimeAsync(50);
    expect(log).toEqual(["first", "second"]);
    expect(done).toHaveBeenCalledOnce();
  });

  it("run() stops gracefully when aborted, waiting for running jobs", async () => {
    const controller = new AbortController();
    const orchestrator = orchestratorFor(AppModule);
    const done = vi.fn();
    void orchestrator.run({ signals: [], signal: controller.signal }).then(done);

    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalledOnce();
    expect(orchestrator.registry.isStarted).toBe(false);
  });

  it("run() stops on a process signal and removes its listeners", async () => {
    const before = process.listenerCount("SIGUSR2");
    const orchestrator = orchestratorFor(AppModule);
    const running = orchestrator.run({ signals: ["SIGUSR2"] });
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);

    process.emit("SIGUSR2", "SIGUSR2");
    await running;
    expect(process.listenerCount("SIGUSR2")).toBe(before);
  });

  it("run() rejects right away for an already aborted signal", async () => {
    await expect(orchestratorFor(AppModule).run({ signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it("works end to end through a command", async () => {
    const running = loadCommand(WorkerModule, { name: "cli" }, ["node", "cli", "worker"]);
    await vi.advanceTimersByTimeAsync(400);
    await running;
    expect(log).toEqual(["first", "second"]);
  });
});

describe("ScheduledJob", () => {
  it("skips ticks while the previous run is still going, unless overlap is allowed", async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 2500));
    const serial = vi.fn(slow);
    const parallel = vi.fn(slow);
    const jobs = [
      new IntervalJob("serial", 1000, serial).start(),
      new IntervalJob("parallel", 1000, parallel, { allowOverlap: true }).start(),
    ];

    await vi.advanceTimersByTimeAsync(5000);
    const stopped = Promise.all(jobs.map((job) => job.stop()));
    await vi.advanceTimersByTimeAsync(2500); // let in-progress runs finish
    await stopped;
    expect(serial).toHaveBeenCalledTimes(2); // t=1s, t=4s
    expect(parallel).toHaveBeenCalledTimes(5);
  });

  it("reports failures without stopping the schedule", async () => {
    const onError = vi.fn();
    const job = new IntervalJob("flaky", 100, () => {
      throw new Error("boom");
    });
    job.onError = onError;
    job.start();

    await vi.advanceTimersByTimeAsync(300);
    await job.stop();
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }), job);
  });

  it("falls back to logging when the error handler itself throws", async () => {
    const lines: string[] = [];
    Logger.configure({ stream: { write: (chunk: string) => lines.push(chunk) }, format: "json" });
    const job = new TimeoutJob("t", 0, () => Promise.reject(new Error("inner")));
    job.onError = () => {
      throw new Error("handler");
    };
    await job.run();
    Logger.resetConfig();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error",
      context: "Schedule",
      job: "t",
      msg: 'timeout job "t" failed',
      err: { type: "Error", message: "handler" },
    });
  });

  it("stop() waits for in-progress runs", async () => {
    let finished = false;
    const job = new TimeoutJob("slow", 0, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      finished = true;
    }).start();

    await vi.advanceTimersByTimeAsync(0);
    expect(job.isRunning).toBe(true);
    const stopping = job.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(finished).toBe(true);
  });

  it("runOnStart runs immediately as well as on schedule", async () => {
    const fn = vi.fn();
    const job = new IntervalJob("eager", 1000, fn, { runOnStart: true }).start();
    expect(fn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await job.stop();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("evaluates cron expressions in the given time zone", () => {
    const job = new CronJob("midnight", CronExpression.EVERY_DAY_AT_MIDNIGHT, () => {}, {
      timeZone: "Asia/Ho_Chi_Minh",
    });
    expect(job.nextRunAt).toBeNull(); // not started
    job.start();
    expect(job.nextRunAt?.toISOString()).toBe("2026-01-01T17:00:00.000Z"); // 00:00 at UTC+7
    void job.stop();
  });

  it("reports the next run of intervals and timeouts", () => {
    const interval = new IntervalJob("i", 1000, () => {}).start();
    const timeout = new TimeoutJob("t", 5000, () => {}).start();
    expect(interval.nextRunAt?.getTime()).toBe(Date.now() + 1000);
    expect(timeout.nextRunAt?.getTime()).toBe(Date.now() + 5000);
    void interval.stop();
    void timeout.stop();
  });
});

describe("SchedulerRegistry", () => {
  it("starts jobs added after start(), and only then", async () => {
    const registry = new SchedulerRegistry();
    const early = vi.fn();
    const late = vi.fn();
    registry.addInterval("early", 100, early);
    await vi.advanceTimersByTimeAsync(100);
    expect(early).not.toHaveBeenCalled();

    registry.start();
    registry.addInterval("late", 100, late);
    await vi.advanceTimersByTimeAsync(100);
    await registry.stop();
    expect(early).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledOnce();
  });

  it("rejects duplicate names and frees a name on delete", async () => {
    const registry = new SchedulerRegistry();
    registry.addTimeout("job", 10, () => {});
    expect(() => registry.addCron("job", "* * * * *", () => {})).toThrow(/already exists/);

    expect(await registry.delete("job")).toBe(true);
    expect(await registry.delete("job")).toBe(false);
    expect(registry.addCron("job", "* * * * *", () => {})).toBeInstanceOf(CronJob);
  });

  it("filters jobs by kind and routes errors to its handler", async () => {
    const registry = new SchedulerRegistry();
    registry.onError = vi.fn();
    registry.addCron("c", "* * * * *", () => {});
    const failing = registry.addTimeout("t", 0, () => {
      throw new Error("x");
    });

    expect(registry.getJobs("timeout")).toEqual([failing]);
    await failing.run();
    expect(registry.onError).toHaveBeenCalledWith(expect.any(Error), failing);
  });

  it("whenIdle() waits for started jobs and resolves once they're deleted", async () => {
    const registry = new SchedulerRegistry();
    registry.addInterval("i", 100, () => {});
    await registry.whenIdle(); // nothing started yet

    registry.start();
    const idle = vi.fn();
    void registry.whenIdle().then(idle);
    await vi.advanceTimersByTimeAsync(500);
    expect(idle).not.toHaveBeenCalled();

    await registry.delete("i");
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toHaveBeenCalledOnce();
  });
});
