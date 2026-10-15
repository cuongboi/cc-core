import "reflect-metadata";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command, Option, Argument } from "commander";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

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
  LocalStorageAdapter,
  MemoryStorageAdapter,
  registerStorageDriver,
  type S3StorageOptions,
  type StorageAdapter,
  type StorageConfig,
  type StorageDriver,
  SpinnerService,
  ProgressService,
  createProgram,
  loadCommand,
  CircularDependencyError,
  InvalidProviderError,
  ProviderNotFoundError,
  ResolutionError,
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

  it("detects circular dependencies and names the cycle", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(CircularModule);
    expect(() => node.resolve(CIR_A)).toThrowError(CircularDependencyError);
    expect(() => node.resolve(CIR_A)).toThrowError(
      "Circular dependency detected: Symbol(A) -> Symbol(B) -> Symbol(A)",
    );
  });

  it("reports a missing symbol token without crashing on string conversion", () => {
    @Module({})
    class EmptySymbolModule {}

    const MISSING = Symbol("Missing");
    const node = new DependencyContainer().getOrCreateModuleNode(EmptySymbolModule);
    expect(() => node.resolve(MISSING)).toThrowError(ProviderNotFoundError);
    expect(() => node.resolve(MISSING)).toThrowError(/Provider not found: Symbol\(Missing\)/);
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

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
};

/** An in-memory S3 that answers the real SDK commands, paging listings 2 objects at a time. */
class FakeS3 {
  readonly objects = new Map<string, string>();
  readonly sent: string[] = [];

  async send(command: { input: any }): Promise<any> {
    const input = command.input;
    this.sent.push(command.constructor.name);
    if (input.Bucket !== "bucket") throw Object.assign(new Error("no bucket"), { name: "NoSuchBucket" });

    if (command instanceof GetObjectCommand) {
      const body = this.objects.get(input.Key);
      if (body === undefined) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => body } };
    }
    if (command instanceof HeadObjectCommand) {
      if (!this.objects.has(input.Key)) throw Object.assign(new Error("missing"), { name: "NotFound" });
      return {};
    }
    if (command instanceof PutObjectCommand) {
      this.objects.set(input.Key, input.Body);
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(input.Key);
      return {};
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const { Key } of input.Delete.Objects) this.objects.delete(Key);
      return { Errors: [] };
    }
    if (command instanceof ListObjectsV2Command) {
      const keys = [...this.objects.keys()]
        .filter((key) => key.startsWith(input.Prefix))
        .filter((key) => !input.Delimiter || !key.slice(input.Prefix.length).includes(input.Delimiter))
        .sort();
      const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
      const end = start + 2;
      return {
        Contents: keys.slice(start, end).map((Key) => ({ Key })),
        IsTruncated: end < keys.length,
        NextContinuationToken: end < keys.length ? String(end) : undefined,
      };
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

let storageRoot: string;
beforeEach(() => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-core-storage-"));
});
afterEach(() => {
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

const storageDrivers: [string, (namespace: string) => StorageService<string | number>][] = [
  ["local", (namespace) => new StorageService({ driver: "local", namespace, dir: storageRoot })],
  ["memory", () => new StorageService({ driver: "memory" })],
  [
    "s3",
    (namespace) =>
      new StorageService({ driver: "s3", namespace, bucket: "bucket", client: new FakeS3() as unknown as S3Client }),
  ],
];

describe.each(storageDrivers)("StorageService (%s driver)", (_, create) => {
  let storage: StorageService<string | number>;

  beforeEach(() => {
    storage = create("test");
  });

  it("returns undefined / false for a missing key", async () => {
    expect(await storage.get("nonexistent")).toBeUndefined();
    expect(await storage.has("ghost")).toBe(false);
    expect(await storage.delete("nope")).toBe(false);
  });

  it("round-trips primitives and objects", async () => {
    await storage.set("name", "Alice");
    await storage.set("user", { age: 30, active: true });
    expect(await storage.get("name")).toBe("Alice");
    expect(await storage.get("user")).toEqual({ age: 30, active: true });
    expect(await storage.has("user")).toBe(true);
  });

  it("returns a fresh copy on every read", async () => {
    await storage.set("obj", { n: 1 });
    const first = await storage.get<{ n: number }>("obj");
    first!.n = 2;
    expect(await storage.get("obj")).toEqual({ n: 1 });
  });

  it("delete() removes a key and returns true", async () => {
    await storage.set("temp", "gone");
    expect(await storage.delete("temp")).toBe(true);
    expect(await storage.has("temp")).toBe(false);
  });

  it("round-trips keys with special characters without collisions", async () => {
    const keys = ["a/b", "a_b", "../escape", "spaced key", "ünïcödé", "*?:<>|", "100%"];
    for (const [i, key] of keys.entries()) await storage.set(key, i);

    for (const [i, key] of keys.entries()) expect(await storage.get(key)).toBe(i);
    expect((await collect(storage.keys())).sort()).toEqual([...keys].sort());
  });

  it("yields canonical numeric keys back as numbers", async () => {
    await storage.set(42, "a");
    await storage.set("007", "b");
    expect(await collect(storage.keys())).toEqual(expect.arrayContaining([42, "007"]));
  });

  it("rejects empty keys and values that are not JSON-serializable", async () => {
    await expect(storage.set("", 1)).rejects.toThrow(TypeError);
    await expect(storage.get("")).rejects.toThrow(TypeError);
    await expect(storage.set("u", undefined)).rejects.toThrow(TypeError);
    expect(await storage.has("u")).toBe(false);
  });

  it("size(), clear() and iteration cover every entry", async () => {
    for (const key of ["a", "b", "c", "d", "e"]) await storage.set(key, key.toUpperCase());

    expect(await storage.size()).toBe(5);
    expect(await collect(storage)).toContainEqual(["c", "C"]);
    expect((await collect(storage.values())).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(await collect(storage.entries())).toHaveLength(5);

    const seen: unknown[] = [];
    await storage.forEach((value, key) => seen.push([key, value]));
    expect(seen).toHaveLength(5);

    await storage.clear();
    expect(await storage.size()).toBe(0);
  });

  it("keeps namespaces apart", async () => {
    if (_ === "memory") return; // each memory adapter is its own namespace
    const other = create("other");
    await storage.set("k", "mine");
    expect(await other.has("k")).toBe(false);
  });
});

describe("LocalStorageAdapter", () => {
  it("stores one JSON file per key under <dir>/<namespace>, created on first write", async () => {
    const storage = new StorageService({ driver: "local", namespace: "app", dir: storageRoot });
    const adapter = storage.adapter as LocalStorageAdapter;
    expect(adapter.directory).toBe(path.join(storageRoot, "app"));
    expect(fs.existsSync(adapter.directory)).toBe(false);

    await storage.set("a/b", { big: "x".repeat(1000) });
    expect(fs.readdirSync(storageRoot)).toEqual(["app"]); // nothing escaped the namespace
    expect(fs.readdirSync(adapter.directory)).toEqual(["a%2Fb.json"]); // and no temp files left
  });

  it("survives concurrent writes to the same key", async () => {
    const storage = new StorageService<string, number>({ driver: "local", dir: storageRoot });
    await Promise.all(Array.from({ length: 20 }, (_, i) => storage.set("k", i)));
    expect(typeof (await storage.get("k"))).toBe("number");
    expect(fs.readdirSync(path.join(storageRoot, "default"))).toEqual(["k.json"]);
  });

  it("rejects keys too long for a filename", async () => {
    const storage = new StorageService({ driver: "local", dir: storageRoot });
    await expect(storage.set("x".repeat(201), 1)).rejects.toThrow(RangeError);
  });

  it("defaults to ./.storage/default", () => {
    const adapter = new StorageService().adapter as LocalStorageAdapter;
    expect(adapter.directory).toBe(path.join(process.cwd(), ".storage", "default"));
  });
});

describe("S3StorageAdapter", () => {
  const s3 = (fake: FakeS3, options: Partial<S3StorageOptions> & { namespace?: string } = {}) =>
    new StorageService({
      driver: "s3",
      bucket: "bucket",
      client: fake as unknown as S3Client,
      namespace: "my-cli",
      ...options,
    });

  it("writes JSON objects at <prefix>/<namespace>/<encoded key>.json", async () => {
    const fake = new FakeS3();
    await s3(fake, { prefix: "/apps/" }).set("user:1", { id: 1 });
    expect([...fake.objects.keys()]).toEqual(["apps/my-cli/user%3A1.json"]);
    expect(JSON.parse(fake.objects.get("apps/my-cli/user%3A1.json")!)).toEqual({ id: 1 });
  });

  it("does not list or clear the keys of a nested namespace", async () => {
    const fake = new FakeS3();
    const parent = s3(fake, { namespace: "a" });
    await s3(fake, { namespace: "a/b" }).set("k", 1);
    await parent.set("k", 2);

    expect(await collect(parent.keys())).toEqual(["k"]);
    await parent.clear();
    expect([...fake.objects.keys()]).toEqual(["a/b/k.json"]);
  });

  it("pages through listings and clears with batched deletes", async () => {
    const fake = new FakeS3();
    const storage = s3(fake);
    for (let i = 0; i < 5; i++) await storage.set(`k${i}`, i);
    fake.objects.set("my-cli/not-ours.txt", "x");

    expect(await storage.size()).toBe(5);
    fake.sent.length = 0;
    await storage.clear();
    expect(fake.sent.filter((name) => name === "DeleteObjectsCommand")).toHaveLength(1);
    expect([...fake.objects.keys()]).toEqual(["my-cli/not-ours.txt"]);
  });

  it("propagates errors other than a missing key", async () => {
    const storage = s3(new FakeS3(), { bucket: "wrong" });
    await expect(storage.get("k")).rejects.toMatchObject({ name: "NoSuchBucket" });
    await expect(storage.has("k")).rejects.toMatchObject({ name: "NoSuchBucket" });
  });

  it("requires a bucket", () => {
    expect(() => s3(new FakeS3(), { bucket: "" })).toThrow(/bucket/);
  });
});

describe("storage drivers", () => {
  /** Implements only the required methods, so the service's fallbacks are exercised. */
  class MinimalAdapter implements StorageAdapter {
    readonly map = new Map<string, string>();
    constructor(readonly namespace = "") {}
    async get(key: string) {
      return this.map.get(key);
    }
    async set(key: string, value: string) {
      this.map.set(key, value);
    }
    async delete(key: string) {
      return this.map.delete(key);
    }
    async *keys() {
      yield* this.map.keys();
    }
  }

  it("accepts an adapter instance and falls back for optional methods", async () => {
    const adapter = new MinimalAdapter();
    const storage = new StorageService(adapter);
    expect(storage.adapter).toBe(adapter);

    await storage.set("a", 1);
    await storage.set("b", 2);
    expect(await storage.has("a")).toBe(true);
    await storage.clear();
    expect(adapter.map.size).toBe(0);
  });

  it("creates adapters from registered custom drivers", async () => {
    registerStorageDriver("minimal" as StorageDriver, (_options, namespace) => new MinimalAdapter(namespace));
    const storage = new StorageService({ driver: "minimal", namespace: "ns" } as unknown as StorageConfig);
    expect(storage.adapter).toBeInstanceOf(MinimalAdapter);
    expect((storage.adapter as MinimalAdapter).namespace).toBe("ns");
  });

  it("throws for an unknown driver", () => {
    expect(() => new StorageService({ driver: "nope" } as unknown as StorageConfig)).toThrow(/Unknown storage driver "nope"/);
  });

  it("uses the memory driver without touching the filesystem", async () => {
    const storage = new StorageService({ driver: "memory" });
    await storage.set("k", 1);
    expect(storage.adapter).toBeInstanceOf(MemoryStorageAdapter);
    expect(fs.readdirSync(storageRoot)).toEqual([]);
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

// ---------------------------------------------------------------------------
// DI edge cases: inheritance, property injection, diagnostics
// ---------------------------------------------------------------------------

const BASE_TOKEN = Symbol("BASE_TOKEN");

@Injectable()
class BaseConsumer {
  constructor(@Inject(BASE_TOKEN) public value: string) {}
}

/** No constructor of its own: must inherit both param types and @Inject overrides. */
@Injectable()
class DerivedConsumer extends BaseConsumer {}

const PROP_TOKEN = Symbol("PROP_TOKEN");

@Injectable()
class PropertyBase {
  @Inject(PROP_TOKEN) base!: string;
}

@Injectable()
class PropertyDerived extends PropertyBase {
  @Inject(GreetingService) greeting!: GreetingService;
}

@Module({
  providers: [
    { provide: BASE_TOKEN, useValue: "from-base" },
    { provide: PROP_TOKEN, useValue: "prop-value" },
    GreetingService,
    DerivedConsumer,
    PropertyDerived,
  ],
})
class InheritanceModule {}

class Undecorated {
  constructor(public greeting: GreetingService) {}
}

interface Config {
  url: string;
}

@Injectable()
class NeedsInterface {
  constructor(public config: Config) {}
}

@Module({ providers: [GreetingService, Undecorated, NeedsInterface] })
class DiagnosticsModule {}

describe("DI edge cases", () => {
  it("subclasses inherit constructor @Inject overrides from their parent", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(InheritanceModule);
    expect(node.resolve(DerivedConsumer).value).toBe("from-base");
  });

  it("injects properties, including ones declared on a parent class", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(InheritanceModule);
    const instance = node.resolve(PropertyDerived);
    expect(instance.base).toBe("prop-value");
    expect(instance.greeting).toBeInstanceOf(GreetingService);
  });

  it("explains missing type metadata instead of passing undefined", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(DiagnosticsModule);
    expect(() => node.resolve(Undecorated)).toThrowError(/no constructor type metadata.*@Injectable/);
  });

  it("explains non-injectable parameter types such as interfaces", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(DiagnosticsModule);
    expect(() => node.resolve(NeedsInterface)).toThrowError(
      /parameter #0 of NeedsInterface: type "Object" is not injectable/,
    );
  });

  it("includes the resolution path when a nested dependency is missing", () => {
    @Module({ providers: [FarewellService] })
    class MissingGreetingModule {}

    const node = new DependencyContainer().getOrCreateModuleNode(MissingGreetingModule);
    expect(() => node.resolve(FarewellService)).toThrowError(
      /GreetingService in module MissingGreetingModule \(while resolving FarewellService\)/,
    );
  });

  it("rejects importing a class that is not a module", () => {
    @Module({ imports: [GreetingService] })
    class BadImportModule {}

    expect(() => new DependencyContainer().getOrCreateModuleNode(BadImportModule)).toThrowError(
      /GreetingService is not a module/,
    );
  });

  it("rejects malformed provider definitions", () => {
    @Module({ providers: [{ provide: "nothing" } as any] })
    class BadProviderModule {}

    expect(() => new DependencyContainer().getOrCreateModuleNode(BadProviderModule)).toThrowError(
      InvalidProviderError,
    );
  });

  it("keeps earlier registrations when a later one sets multi: true", () => {
    const TOKEN = Symbol("MIXED_MULTI");

    @Module({
      providers: [
        { provide: TOKEN, useValue: "plain" },
        { provide: TOKEN, useValue: "multi", multi: true },
      ],
    })
    class MixedFlagModule {}

    const node = new DependencyContainer().getOrCreateModuleNode(MixedFlagModule);
    expect(node.resolve(TOKEN)).toEqual(["plain", "multi"]);
  });

  it("all container errors share the ResolutionError base class", () => {
    const node = new DependencyContainer().getOrCreateModuleNode(CircularModule);
    expect(() => node.resolve(CIR_A)).toThrowError(ResolutionError);
  });
});

// ---------------------------------------------------------------------------
// createProgram / loadCommand
// ---------------------------------------------------------------------------

const commandLog: string[] = [];

@Injectable()
class SharedCommand extends BaseCommand {
  name = "shared";
  constructor(private greeting: GreetingService) {
    super();
  }
  exec() {
    commandLog.push(this.greeting.greet("shared"));
  }
}

@Injectable()
class SlowCommand extends BaseCommand {
  name = "slow";
  async exec() {
    await wait(10);
    commandLog.push("slow-done");
  }
}

@Injectable()
class FailingCommand extends BaseCommand {
  name = "fail";
  async exec() {
    throw new Error("boom");
  }
}

@Module({ providers: [GreetingService], commands: [SharedCommand], exports: [GreetingService] })
class SharedCommandModule {}

/** Imports SharedCommandModule twice via two paths: commands must register once. */
@Module({ imports: [SharedCommandModule] })
class SiblingModule {}

@Module({ imports: [SharedCommandModule, SiblingModule], commands: [SlowCommand, FailingCommand] })
class CliRootModule {}

describe("createProgram / loadCommand", () => {
  beforeEach(() => {
    commandLog.length = 0;
  });

  it("registers commands from every module exactly once", () => {
    const program = createProgram(CliRootModule, { name: "cli", version: "1.2.3" });
    expect(program.commands.map((c) => c.name()).sort()).toEqual(["fail", "shared", "slow"]);
    expect(program.version()).toBe("1.2.3");
  });

  it("resolves command dependencies from the command's own module", async () => {
    await loadCommand(CliRootModule, { name: "cli" }, ["node", "cli", "shared"]);
    expect(commandLog).toEqual(["Hello, shared!"]);
  });

  it("waits for async exec() before resolving", async () => {
    await loadCommand(CliRootModule, { name: "cli" }, ["node", "cli", "slow"]);
    expect(commandLog).toEqual(["slow-done"]);
  });

  it("rejects when exec() throws", async () => {
    await expect(
      loadCommand(CliRootModule, { name: "cli" }, ["node", "cli", "fail"]),
    ).rejects.toThrow("boom");
  });

  it("calls the configure() hook with the sub-command", () => {
    class AliasedCommand extends BaseCommand {
      name = "status";
      protected override configure(command: Command) {
        command.alias("st");
      }
      exec() {}
    }

    const program = new Command("cli");
    expect(new AliasedCommand().register(program).aliases()).toEqual(["st"]);
  });
});

describe("ProgressService restarts", () => {
  it("start() stops a bar that is already running", () => {
    const progress = new ProgressService();
    progress.start(10);
    const first = progress.rawSingle!;
    const stopSpy = vi.spyOn(first, "stop");
    progress.start(20);
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(progress.rawSingle).not.toBe(first);
    progress.stop();
  });
});
