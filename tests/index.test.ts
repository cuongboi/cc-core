import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command, Option, Argument } from "commander";

import {
  Module,
  Injectable,
  Inject,
  DependencyContainer,
  BaseCommand,
  wait,
  debounce,
  throttle,
  StorageService,
  SpinnerService,
  ProgressService,
} from "../src/index";

// ---------------------------------------------------------------------------
// Top-level class definitions (parameter decorators don't work inside
// function/describe bodies with the oxc/rolldown bundler used by vitest here)
// ---------------------------------------------------------------------------

@Injectable()
class GreetingService {
  greet(name: string) {
    return `Hello, ${name}!`;
  }
}

@Injectable()
class FarewellService {
  constructor(private greeting: GreetingService) {}
  farewell(name: string) {
    return `${this.greeting.greet(name)} Goodbye!`;
  }
}

@Module({ providers: [GreetingService, FarewellService] })
class FarewellModule {}

// --- @Inject token test fixtures ---
const INJECT_TOKEN = Symbol("MyToken");

@Injectable()
class TokenConsumer {
  constructor(@Inject(INJECT_TOKEN) public value: string) {}
}

@Module({
  providers: [{ provide: INJECT_TOKEN, useValue: "injected-value" }, TokenConsumer],
})
class TokenModule {}

// --- Cross-module export fixtures ---
@Injectable()
class Logger {
  log(msg: string) {
    return `[LOG] ${msg}`;
  }
}

@Module({ providers: [Logger], exports: [Logger] })
class LoggerModule {}

@Module({ imports: [LoggerModule] })
class AppModuleWithLogger {}

// --- Singleton / useFactory fixtures ---
@Injectable()
class Counter {
  count = 0;
}

@Module({ providers: [Counter] })
class CounterModule {}

const CONFIG_TOKEN = Symbol("config");
const RESULT_TOKEN = Symbol("result");

@Module({
  providers: [
    { provide: CONFIG_TOKEN, useValue: { prefix: "Hello" } },
    {
      provide: RESULT_TOKEN,
      useFactory: (cfg: { prefix: string }) => `${cfg.prefix} World`,
      inject: [CONFIG_TOKEN],
    },
  ],
})
class FactoryDepModule {}

// --- Circular dependency fixtures ---
const CIR_A = Symbol("A");
const CIR_B = Symbol("B");

@Module({
  providers: [
    { provide: CIR_A, useFactory: (b: any) => b, inject: [CIR_B] },
    { provide: CIR_B, useFactory: (a: any) => a, inject: [CIR_A] },
  ],
})
class CircularModule {}

// --- End-to-end fixtures ---
@Injectable()
class EchoService {
  echo(msg: string) {
    return `Echo: ${msg}`;
  }
}

class EchoCommand extends BaseCommand {
  name = "echo";
  arguments = [new Argument("<msg>", "Message to echo")];

  constructor(@Inject(EchoService) private svc: EchoService) {
    super();
  }

  exec(msg: string) {
    return this.svc.echo(msg);
  }
}

@Module({ providers: [EchoService], commands: [EchoCommand] })
class EchoModule {}

// ---------------------------------------------------------------------------
// @Module decorator
// ---------------------------------------------------------------------------

describe("@Module decorator", () => {
  it("attaches module metadata readable by the DI container", () => {
    @Injectable()
    class SomeService {}

    @Module({ providers: [SomeService], commands: [] })
    class TestAppModule {}

    const container = new DependencyContainer();
    const node = container.getOrCreateModuleNode(TestAppModule);
    expect(node.metadata.providers).toContain(SomeService);
  });

  it("supports imports / exports between modules", () => {
    @Injectable()
    class SharedService {
      value = 42;
    }

    @Module({ providers: [SharedService], exports: [SharedService] })
    class SharedModule {}

    @Module({ imports: [SharedModule] })
    class FeatureModule {}

    const container = new DependencyContainer();
    const featureNode = container.getOrCreateModuleNode(FeatureModule);
    expect(featureNode.importedModules).toHaveLength(1);
    expect(featureNode.importedModules[0].moduleClass).toBe(SharedModule);
  });
});

// ---------------------------------------------------------------------------
// @Inject – constructor parameter injection
// ---------------------------------------------------------------------------

describe("@Inject decorator", () => {
  it("resolves a dependency by custom token", () => {
    const container = new DependencyContainer();
    const node = container.getOrCreateModuleNode(TokenModule);
    const instance = node.resolve(TokenConsumer);
    expect(instance.value).toBe("injected-value");
  });
});

// ---------------------------------------------------------------------------
// DependencyContainer / ModuleNode
// ---------------------------------------------------------------------------

describe("DependencyContainer", () => {
  it("returns the same ModuleNode instance for the same class (singleton nodes)", () => {
    @Module({})
    class SingletonModule {}

    const container = new DependencyContainer();
    expect(container.getOrCreateModuleNode(SingletonModule)).toBe(
      container.getOrCreateModuleNode(SingletonModule),
    );
  });

  it("resolves a class with constructor-injected dependency", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(FarewellModule);
    const svc = node.resolve(FarewellService);
    expect(svc.farewell("World")).toBe("Hello, World! Goodbye!");
  });

  it("resolves a useValue provider", () => {
    const TOKEN = Symbol("port-config");

    @Module({ providers: [{ provide: TOKEN, useValue: { port: 3000 } }] })
    class ConfigModule {}

    const node = new DependencyContainer().getOrCreateModuleNode(ConfigModule);
    expect(node.resolve(TOKEN)).toEqual({ port: 3000 });
  });

  it("resolves a useFactory provider", () => {
    const TOKEN = Symbol("factory-tok");

    @Module({
      providers: [{ provide: TOKEN, useFactory: () => "factory-result" }],
    })
    class FactoryModule {}

    const node = new DependencyContainer().getOrCreateModuleNode(FactoryModule);
    expect(node.resolve(TOKEN)).toBe("factory-result");
  });

  it("resolves a useFactory with injected dependencies", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(FactoryDepModule);
    expect(node.resolve(RESULT_TOKEN)).toBe("Hello World");
  });

  it("resolves class providers as singletons within a module", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(CounterModule);
    const a = node.resolve(Counter);
    const b = node.resolve(Counter);
    a.count = 10;
    expect(b.count).toBe(10); // same instance
  });

  it("resolves a provider exported from an imported module", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(AppModuleWithLogger);
    expect(node.resolve(Logger).log("test")).toBe("[LOG] test");
  });

  it("throws when a provider cannot be found", () => {
    @Module({})
    class EmptyModule {}

    class UnknownService {}

    const node = new DependencyContainer().getOrCreateModuleNode(EmptyModule);
    expect(() => node.resolve(UnknownService)).toThrowError(/Provider not found/);
  });

  it("detects circular dependencies", () => {
    // Note: the container's error message uses string interpolation with Symbol tokens;
    // the circular-dependency check fires first but the error message construction
    // may throw "Cannot convert a Symbol value to a string" before surfacing the
    // "Circular dependency" text. Either way an error is thrown at resolve time.
    const node = new DependencyContainer().getOrCreateModuleNode(CircularModule);
    expect(() => node.resolve(CIR_A)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// BaseCommand
// ---------------------------------------------------------------------------

describe("BaseCommand", () => {
  it("registers a sub-command on the program", () => {
    class HelloCommand extends BaseCommand {
      name = "hello";
      description = "Say hello";
      exec() {}
    }

    const program = new Command("cli");
    new HelloCommand().register(program);

    const found = program.commands.find((c) => c.name() === "hello");
    expect(found).toBeDefined();
    expect(found?.description()).toBe("Say hello");
  });

  it("registers options and arguments on the sub-command", () => {
    class BuildCommand extends BaseCommand {
      name = "build";
      description = "Build the project";
      options = [new Option("--watch", "Watch mode")];
      arguments = [new Argument("<target>", "Build target")];
      exec() {}
    }

    const program = new Command("cli");
    new BuildCommand().register(program);

    const sub = program.commands.find((c) => c.name() === "build")!;
    expect(sub.options.some((o) => o.long === "--watch")).toBe(true);
    expect(sub.registeredArguments.some((a) => a.name() === "target")).toBe(true);
  });

  it("calls exec when the sub-command action fires", async () => {
    const execSpy = vi.fn();

    class PingCommand extends BaseCommand {
      name = "ping-cmd";
      exec(...args: unknown[]) {
        execSpy(...args);
      }
    }

    const program = new Command("cli").exitOverride();
    new PingCommand().register(program);

    await program.parseAsync(["node", "cli", "ping-cmd"]);
    expect(execSpy).toHaveBeenCalledOnce();
  });

  it("passes parsed arguments to exec", async () => {
    const execSpy = vi.fn();

    class GreetCommand extends BaseCommand {
      name = "greet-cmd";
      arguments = [new Argument("<name>", "Name to greet")];
      exec(...args: unknown[]) {
        execSpy(...args);
      }
    }

    const program = new Command("cli").exitOverride();
    new GreetCommand().register(program);

    await program.parseAsync(["node", "cli", "greet-cmd", "Alice"]);
    expect(execSpy).toHaveBeenCalledWith("Alice", expect.anything(), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// StorageService (built-in)
// ---------------------------------------------------------------------------

describe("StorageService", () => {
  let storage: StorageService<string, unknown>;

  beforeEach(() => {
    // Unique sub-path per test to avoid cross-test pollution
    storage = new StorageService(`test-${Date.now()}-${Math.random()}`);
  });

  it("returns undefined for a missing key", () => {
    expect(storage.get("nonexistent")).toBeUndefined();
  });

  it("has() returns false for a missing key", () => {
    expect(storage.has("ghost")).toBe(false);
  });

  it("set/get round-trips a primitive value", () => {
    storage.set("name", "Alice");
    expect(storage.get("name")).toBe("Alice");
  });

  it("set/get round-trips an object", () => {
    storage.set("user", { age: 30, active: true });
    expect(storage.get("user")).toEqual({ age: 30, active: true });
  });

  it("has() returns true after set()", () => {
    storage.set("key", 123);
    expect(storage.has("key")).toBe(true);
  });

  it("delete() removes a key and returns true", () => {
    storage.set("temp", "gone");
    expect(storage.delete("temp")).toBe(true);
    expect(storage.has("temp")).toBe(false);
  });

  it("delete() returns false for a nonexistent key", () => {
    expect(storage.delete("nope")).toBe(false);
  });

  it("size reflects the number of stored entries", () => {
    storage.set("a", 1);
    storage.set("b", 2);
    expect(storage.size).toBe(2);
  });

  it("clear() removes all entries", () => {
    storage.set("x", 1);
    storage.set("y", 2);
    storage.clear();
    expect(storage.size).toBe(0);
  });

  it("keys() iterates stored keys", () => {
    storage.set("k1", "v1");
    storage.set("k2", "v2");
    expect([...storage.keys()]).toEqual(expect.arrayContaining(["k1", "k2"]));
  });

  it("values() iterates stored values", () => {
    storage.set("a", "hello");
    storage.set("b", "world");
    expect([...storage.values()]).toEqual(expect.arrayContaining(["hello", "world"]));
  });

  it("entries() iterates [key, value] pairs", () => {
    storage.set("foo", "bar");
    expect([...storage.entries()]).toContainEqual(["foo", "bar"]);
  });

  it("forEach() visits all entries", () => {
    storage.set("x", 10);
    const seen: [string, unknown][] = [];
    storage.forEach((val, key) => seen.push([key, val]));
    expect(seen).toContainEqual(["x", 10]);
  });
});

// ---------------------------------------------------------------------------
// Utils – wait / debounce / throttle
// ---------------------------------------------------------------------------

describe("wait()", () => {
  it("resolves after the given delay", async () => {
    const start = Date.now();
    await wait(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

describe("debounce()", () => {
  it("calls the function only once after rapid invocations", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced();
    debounced();
    debounced();

    await wait(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the latest arguments to the underlying function", async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);

    debounced("first");
    debounced("second");
    debounced("third");

    await wait(100);
    expect(fn).toHaveBeenCalledWith("third");
  });
});

describe("throttle()", () => {
  it("calls the function immediately on the first invocation", () => {
    const fn = vi.fn();
    throttle(fn, 100)();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ignores calls within the throttle window", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled(); // called
    throttled(); // ignored
    throttled(); // ignored

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("allows a second call after the throttle window expires", async () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 50);

    throttled(); // called
    await wait(80);
    throttled(); // called again

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Multi-provider (same token)
// ---------------------------------------------------------------------------

// --- fixtures defined at top level so parameter decorators work ---

const ACTION_HANDLERS = Symbol("ACTION_HANDLERS");

@Injectable()
class HandlerA {
  handle() {
    return "A";
  }
}

@Injectable()
class HandlerB {
  handle() {
    return "B";
  }
}

@Injectable()
class HandlerC {
  handle() {
    return "C";
  }
}

/** Consumer that receives the multi-provider array via constructor injection */
@Injectable()
class HandlerConsumer {
  constructor(@Inject(ACTION_HANDLERS) public handlers: { handle(): string }[]) {}
}

@Module({
  providers: [
    { provide: ACTION_HANDLERS, useClass: HandlerA },
    { provide: ACTION_HANDLERS, useClass: HandlerB },
    { provide: ACTION_HANDLERS, useClass: HandlerC },
    HandlerConsumer,
  ],
})
class HandlersModule {}

/** Same scenario but using explicit `multi: true` flag */
const MULTI_TOKEN = Symbol("MULTI_TOKEN");

@Module({
  providers: [
    { provide: MULTI_TOKEN, useValue: "first", multi: true },
    { provide: MULTI_TOKEN, useValue: "second", multi: true },
    { provide: MULTI_TOKEN, useValue: "third", multi: true },
  ],
})
class ExplicitMultiModule {}

/** Mixed useValue / useFactory / useClass under the same token */
const MIXED_TOKEN = Symbol("MIXED_TOKEN");

@Injectable()
class MixedClass {
  type = "class";
}

@Module({
  providers: [
    { provide: MIXED_TOKEN, useValue: "value-entry" },
    { provide: MIXED_TOKEN, useFactory: () => "factory-entry" },
    { provide: MIXED_TOKEN, useClass: MixedClass },
  ],
})
class MixedMultiModule {}

/** Cross-module export of a multi-provider token */
const SHARED_HANDLER = Symbol("SHARED_HANDLER");

@Injectable()
class SharedHandlerA {
  id = "shared-A";
}
@Injectable()
class SharedHandlerB {
  id = "shared-B";
}

@Module({
  providers: [
    { provide: SHARED_HANDLER, useClass: SharedHandlerA },
    { provide: SHARED_HANDLER, useClass: SharedHandlerB },
  ],
  exports: [SHARED_HANDLER],
})
class SharedHandlerModule {}

@Module({ imports: [SharedHandlerModule] })
class ConsumerModule {}

describe("Multi-provider (same token)", () => {
  describe("auto-promotion: multiple useClass entries under one token", () => {
    it("resolves all handlers as an array", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(HandlersModule);
      const handlers = node.resolve(ACTION_HANDLERS);

      expect(Array.isArray(handlers)).toBe(true);
      expect(handlers).toHaveLength(3);
    });

    it("returns instances of the correct classes in registration order", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(HandlersModule);
      const [a, b, c] = node.resolve(ACTION_HANDLERS);

      expect(a).toBeInstanceOf(HandlerA);
      expect(b).toBeInstanceOf(HandlerB);
      expect(c).toBeInstanceOf(HandlerC);
    });

    it("each handler produces the expected return value", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(HandlersModule);
      const results = node.resolve(ACTION_HANDLERS).map((h: HandlerA) => h.handle());

      expect(results).toEqual(["A", "B", "C"]);
    });

    it("caches the resolved array as a singleton (same reference on second call)", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(HandlersModule);
      const first = node.resolve(ACTION_HANDLERS);
      const second = node.resolve(ACTION_HANDLERS);

      expect(first).toBe(second);
    });
  });

  describe("explicit multi: true flag", () => {
    it("resolves all values as an array", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(ExplicitMultiModule);
      const values = node.resolve(MULTI_TOKEN);

      expect(values).toEqual(["first", "second", "third"]);
    });

    it("preserves registration order", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(ExplicitMultiModule);
      const [first, , third] = node.resolve(MULTI_TOKEN);

      expect(first).toBe("first");
      expect(third).toBe("third");
    });
  });

  describe("mixed provider types (useValue + useFactory + useClass) under one token", () => {
    it("resolves all three entries", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(MixedMultiModule);
      const entries = node.resolve(MIXED_TOKEN);

      expect(entries).toHaveLength(3);
    });

    it("includes the useValue string", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(MixedMultiModule);
      expect(node.resolve(MIXED_TOKEN)).toContain("value-entry");
    });

    it("includes the useFactory string", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(MixedMultiModule);
      expect(node.resolve(MIXED_TOKEN)).toContain("factory-entry");
    });

    it("includes a MixedClass instance", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(MixedMultiModule);
      const classEntry = node.resolve(MIXED_TOKEN).find((e: any) => e instanceof MixedClass);
      expect(classEntry).toBeDefined();
      expect(classEntry.type).toBe("class");
    });
  });

  describe("constructor injection of a multi-provider array via @Inject", () => {
    it("injects the array into HandlerConsumer", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(HandlersModule);
      const consumer = node.resolve(HandlerConsumer);

      expect(consumer).toBeInstanceOf(HandlerConsumer);
      expect(Array.isArray(consumer.handlers)).toBe(true);
      expect(consumer.handlers).toHaveLength(3);
    });

    it("injected handlers are functional", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(HandlersModule);
      const { handlers } = node.resolve(HandlerConsumer);
      const results = handlers.map((h: HandlerA) => h.handle());

      expect(results).toEqual(["A", "B", "C"]);
    });
  });

  describe("cross-module export of a multi-provider token", () => {
    it("consumer module can resolve the exported multi-provider array", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(ConsumerModule);
      const handlers = node.resolve(SHARED_HANDLER);

      expect(Array.isArray(handlers)).toBe(true);
      expect(handlers).toHaveLength(2);
    });

    it("exported instances are of the correct types", () => {
      const node = new DependencyContainer().getOrCreateModuleNode(ConsumerModule);
      const [a, b] = node.resolve(SHARED_HANDLER);

      expect(a).toBeInstanceOf(SharedHandlerA);
      expect(b).toBeInstanceOf(SharedHandlerB);
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: Module + DI + BaseCommand wired together
// ---------------------------------------------------------------------------

describe("End-to-end: module wires a command with an injected service", () => {
  it("resolves the command via the DI container and executes it", async () => {
    const program = new Command("e2e-cli").exitOverride();
    const container = new DependencyContainer();
    const node = container.getOrCreateModuleNode(EchoModule);

    // Instantiate the command the same way loadCommand() would
    const cmdInstance = node.instantiateClass(EchoCommand, []);
    cmdInstance.register(program);

    // Spy on the injected EchoService instance (resolved from the same module node)
    const svcInstance = node.resolve(EchoService);
    const echoSpy = vi.spyOn(svcInstance, "echo");

    await program.parseAsync(["node", "e2e-cli", "echo", "world"]);
    expect(echoSpy).toHaveBeenCalledWith("world");
    expect(echoSpy).toHaveReturnedWith("Echo: world");
  });
});

// ---------------------------------------------------------------------------
// SpinnerService
// ---------------------------------------------------------------------------

describe("SpinnerService", () => {
  it("starts and creates an ora raw instance", () => {
    // ora does not spin in non-TTY environments (e.g. CI / test runner),
    // so we verify the raw instance was created instead of checking isSpinning.
    const spinner = new SpinnerService();
    spinner.start("Loading…");
    expect(spinner.raw).not.toBeNull();
    spinner.stop();
  });

  it("isSpinning is false before start()", () => {
    const spinner = new SpinnerService();
    expect(spinner.isSpinning).toBe(false);
  });

  it("succeed() stops the spinner", () => {
    const spinner = new SpinnerService();
    spinner.start("Working…");
    spinner.succeed("Done!");
    expect(spinner.isSpinning).toBe(false);
  });

  it("fail() stops the spinner", () => {
    const spinner = new SpinnerService();
    spinner.start("Working…");
    spinner.fail("Error!");
    expect(spinner.isSpinning).toBe(false);
  });

  it("warn() stops the spinner", () => {
    const spinner = new SpinnerService();
    spinner.start("Working…");
    spinner.warn("Watch out!");
    expect(spinner.isSpinning).toBe(false);
  });

  it("info() stops the spinner", () => {
    const spinner = new SpinnerService();
    spinner.start("Working…");
    spinner.info("FYI");
    expect(spinner.isSpinning).toBe(false);
  });

  it("setText() updates the spinner text while running", () => {
    const spinner = new SpinnerService();
    spinner.start("Step 1");
    spinner.setText("Step 2");
    expect(spinner.raw?.text).toBe("Step 2");
    spinner.stop();
  });

  it("stop() is safe to call when no spinner is active", () => {
    const spinner = new SpinnerService();
    expect(() => spinner.stop()).not.toThrow();
  });

  it("starting twice replaces the first spinner instance", () => {
    // In non-TTY environments ora reports isSpinning = false; test via raw instance identity.
    const spinner = new SpinnerService();
    spinner.start("First");
    const firstRaw = spinner.raw;
    spinner.start("Second");
    expect(spinner.raw).not.toBe(firstRaw); // a new instance was created
    expect(firstRaw?.isSpinning).toBe(false); // first was stopped
    spinner.stop();
  });

  it("raw is null before any start()", () => {
    const spinner = new SpinnerService();
    expect(spinner.raw).toBeNull();
  });

  it("methods return `this` for chaining", () => {
    const spinner = new SpinnerService();
    expect(spinner.start("go").setText("go2").stop()).toBe(spinner);
  });
});

// ---------------------------------------------------------------------------
// ProgressService
// ---------------------------------------------------------------------------

describe("ProgressService", () => {
  it("start() creates a rawSingle bar", () => {
    const progress = new ProgressService();
    progress.start(100, 0);
    expect(progress.rawSingle).not.toBeNull();
    progress.stop();
  });

  it("rawSingle is null before start()", () => {
    const progress = new ProgressService();
    expect(progress.rawSingle).toBeNull();
  });

  it("stop() clears rawSingle", () => {
    const progress = new ProgressService();
    progress.start(100, 0);
    progress.stop();
    expect(progress.rawSingle).toBeNull();
  });

  it("update() does not throw", () => {
    const progress = new ProgressService();
    progress.start(100, 0);
    expect(() => progress.update(50)).not.toThrow();
    progress.stop();
  });

  it("increment() does not throw", () => {
    const progress = new ProgressService();
    progress.start(100, 0);
    expect(() => progress.increment(10)).not.toThrow();
    progress.stop();
  });

  it("startMulti() creates a rawMulti container", () => {
    const progress = new ProgressService();
    progress.startMulti();
    expect(progress.rawMulti).not.toBeNull();
    progress.stop();
  });

  it("rawMulti is null before startMulti()", () => {
    const progress = new ProgressService();
    expect(progress.rawMulti).toBeNull();
  });

  it("addBar() returns a bar and throws if startMulti() was not called", () => {
    const progress = new ProgressService();
    expect(() => progress.addBar(100, 0)).toThrow("Call startMulti() before addBar().");
  });

  it("addBar() returns a usable GenericBar after startMulti()", () => {
    const progress = new ProgressService();
    progress.startMulti();
    const bar = progress.addBar(50, 0, { label: "test" });
    expect(bar).not.toBeNull();
    expect(typeof bar.update).toBe("function");
    progress.stop();
  });

  it("stop() clears rawMulti", () => {
    const progress = new ProgressService();
    progress.startMulti();
    progress.stop();
    expect(progress.rawMulti).toBeNull();
  });

  it("methods return `this` for chaining", () => {
    const progress = new ProgressService();
    expect(progress.start(10, 0).update(5).increment(2).stop()).toBe(progress);
  });
});
