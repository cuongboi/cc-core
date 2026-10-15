# cc-core

[![npm version](https://img.shields.io/npm/v/cc-core.svg)](https://www.npmjs.com/package/cc-core)
[![npm downloads](https://img.shields.io/npm/dm/cc-core.svg)](https://www.npmjs.com/package/cc-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/cuongboi/cc-core)

NestJS-style **modules and dependency injection** for [commander.js](https://github.com/tj/commander.js) CLIs. Declare commands as classes, inject services into them, and let one call wire everything into a `commander` program.

```ts
@Injectable()
class GreetCommand extends BaseCommand {
  name = "greet";
  arguments = [new Argument("<name>")];

  constructor(private greeter: GreetService) {
    super();
  }

  exec(name: string) {
    console.log(this.greeter.greet(name));
  }
}
```

## Features

- **Decorator-based DI**: `@Module`, `@Injectable`, `@Inject`, with constructor and property injection
- **Module graph**: `imports` / `exports` with per-module singletons
- **Providers**: `useClass`, `useValue`, `useFactory`, and multi-providers
- **Clear errors**: the full resolution path is reported for missing providers, cycles and missing type metadata
- **Async-aware bootstrap**: `loadCommand` awaits async commands and surfaces their errors
- **Built-ins**: `StorageService` (JSON key-value store with `local`, `s3` and `memory` drivers, or your own adapter), task scheduling (`@Cron`, `@Interval`, `@Timeout` via [croner](https://github.com/hexagon/croner)), `Logger` ([pino](https://getpino.io), pretty or JSON, to stderr), `SpinnerService` ([ora](https://github.com/sindresorhus/ora)), `ProgressService` ([cli-progress](https://github.com/npkgjs/cli-progress))
- **Utilities**: `wait`, `debounce`, `throttle`
- Re-exports all of `commander` (`Command`, `Option`, `Argument`, …), so you need only one import source

## Requirements

- **Node.js ≥ 22.12** (required by commander 15)
- **ESM only**: the package ships as an ES module
- **TypeScript decorators** (legacy) with metadata:

  ```json
  {
    "compilerOptions": {
      "experimentalDecorators": true,
      "emitDecoratorMetadata": true
    }
  }
  ```

> [!IMPORTANT]
> Injection by type relies on `design:paramtypes` metadata. `tsc`, SWC and Bun emit it.
> **esbuild and tsx do not.** With those tools, add `@Inject(Token)` to every constructor
> parameter, or the container will throw an error telling you which parameter it cannot resolve.

## Installation

```bash
npm install cc-core
```

Or using your package manager of choice:

```bash
# pnpm
pnpm add cc-core

# yarn
yarn add cc-core

# bun
bun add cc-core
```

`commander`, `reflect-metadata`, `pino`, `pino-pretty`, `ora` and `cli-progress` are installed as dependencies, and `reflect-metadata` is loaded for you.

## Quick start

```ts
// src/main.ts
import { Argument, BaseCommand, Injectable, Module, Option, loadCommand } from "cc-core";

@Injectable()
class GreetService {
  greet(name: string) {
    return `Hello, ${name}!`;
  }
}

@Injectable()
class GreetCommand extends BaseCommand {
  name = "greet";
  description = "Greet someone";
  arguments = [new Argument("<name>", "who to greet")];
  options = [new Option("-u, --upper", "shout it")];

  constructor(private greeter: GreetService) {
    super();
  }

  exec(name: string, opts: { upper?: boolean }) {
    const message = this.greeter.greet(name);
    console.log(opts.upper ? message.toUpperCase() : message);
  }
}

@Module({
  providers: [GreetService],
  commands: [GreetCommand],
})
class AppModule {}

await loadCommand(AppModule, {
  name: "my-cli",
  description: "My awesome CLI",
  version: "1.0.0",
});
```

```bash
$ npx tsc && node dist/main.js greet World --upper
HELLO, WORLD!
```

> Commands need `@Injectable()` (or `@Inject` on each parameter) to receive dependencies,
> because plain classes carry no constructor type metadata.

---

## Modules

`@Module()` groups providers and commands. Modules are the unit of encapsulation: a provider is only visible inside its own module, unless that module **exports** it and another module **imports** that module.

| Option      | Type                 | Description                                                   |
| ----------- | -------------------- | ------------------------------------------------------------- |
| `providers` | `Provider[]`         | Services owned by this module                                 |
| `commands`  | `Type<BaseCommand>[]` | Commands registered on the CLI program                        |
| `imports`   | `Type[]`             | Modules whose exported providers become available here        |
| `exports`   | `InjectionToken[]`   | Tokens of this module's providers that importers may resolve  |

```ts
@Module({
  providers: [DatabaseService, UserService],
  commands: [UserCommand],
  exports: [UserService],
})
class UserModule {}

@Module({
  imports: [UserModule], // UserService is injectable here; DatabaseService is not
  commands: [AdminCommand],
})
class AdminModule {}
```

- Each provider is created lazily the first time it is resolved, then cached: **one instance per module**. Importers of an exported provider share the exporting module's instance.
- Commands from every module reachable from the root are registered **once**, even when a module is imported along several paths. Each command is resolved against the module that declares it.

## Providers

A token is a class, a `string`, or a `symbol`.

```ts
const API_URL = Symbol("API_URL");

@Module({
  providers: [
    // Class shorthand, same as { provide: Logger, useClass: Logger }
    Logger,

    // Swap the implementation behind a token
    { provide: Cache, useClass: MemoryCache },

    // A constant
    { provide: API_URL, useValue: "https://api.example.com" },

    // Computed once, with injected dependencies
    {
      provide: HttpClient,
      useFactory: (url: string, logger: Logger) => new HttpClient(url, logger),
      inject: [API_URL, Logger],
    },
  ],
})
class AppModule {}
```

### Multi-providers

If you register the same token more than once, or set `multi: true`, it resolves to an **array** of every entry, in registration order. Entries may mix `useClass`, `useValue` and `useFactory`.

```ts
const PLUGINS = Symbol("PLUGINS");

@Module({
  providers: [
    { provide: PLUGINS, useClass: GitPlugin },
    { provide: PLUGINS, useClass: DockerPlugin },
  ],
})
class PluginModule {}

@Injectable()
class PluginRunner {
  constructor(@Inject(PLUGINS) private plugins: Plugin[]) {}
}
```

## `@Inject(token)`

Use `@Inject` whenever the type alone can't identify the provider: `string`/`symbol` tokens, interfaces, or toolchains without decorator metadata. It works on constructor parameters and on properties.

```ts
const CONFIG = Symbol("CONFIG");

interface Config {
  apiUrl: string;
}

@Injectable()
class ApiClient {
  @Inject(Logger) private logger!: Logger; // property injection

  constructor(@Inject(CONFIG) private config: Config) {}
}
```

Subclasses that don't declare their own constructor inherit the parent's constructor injections, and property injections are inherited from the whole class hierarchy.

## Commands

Extend `BaseCommand` and describe the command declaratively:

| Member            | Required | Description                                                         |
| ----------------- | -------- | ------------------------------------------------------------------- |
| `name`            | ✅       | Sub-command name                                                    |
| `description`     |          | Help text                                                           |
| `arguments`       |          | `Argument[]` positional arguments                                   |
| `options`         |          | `Option[]` flags                                                    |
| `exec(...args)`   | ✅       | Handler: receives the positional args, then the options object, then the `Command`. May be `async`. |
| `configure(cmd)`  |          | Optional hook for anything else commander supports (aliases, help, hooks) |

```ts
@Injectable()
class DeployCommand extends BaseCommand {
  name = "deploy";
  description = "Deploy to an environment";
  arguments = [new Argument("<env>").choices(["staging", "production"])];
  options = [new Option("--dry-run", "print the plan only")];

  constructor(private deployer: Deployer) {
    super();
  }

  protected override configure(command: Command) {
    command.alias("d").addHelpText("after", "\nExample: my-cli deploy staging --dry-run");
  }

  async exec(env: string, opts: { dryRun?: boolean }) {
    await this.deployer.run(env, opts);
  }
}
```

## Bootstrapping

### `loadCommand(rootModule, options, argv?)`

Builds the program, parses `argv` (default `process.argv`) and runs the matching command. It returns a `Promise` that resolves after an async `exec` finishes and **rejects if it throws**.

```ts
await loadCommand(AppModule, { name: "my-cli", description: "…", version: "1.0.0" });
```

### `createProgram(rootModule, options)`

Same wiring but without parsing. It returns the `commander` `Command`, so you can customise it or test it:

```ts
const program = createProgram(AppModule, { name: "my-cli" }).exitOverride();
await program.parseAsync(["deploy", "staging"], { from: "user" });
```

### Using the container directly

```ts
const node = new DependencyContainer().getOrCreateModuleNode(AppModule);
const client = node.resolve(ApiClient); // typed as ApiClient
const url = node.resolve<string>(API_URL);
```

## Errors

All container errors extend `ResolutionError`, so you can catch them as a group:

| Error                     | Thrown when                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `ProviderNotFoundError`   | A token isn't provided by the module or exported by any of its imports. The message shows the resolution path. |
| `CircularDependencyError` | Providers depend on each other in a cycle; `error.path` lists it                             |
| `InvalidProviderError`    | A `providers` entry is neither a class nor a `{ provide, use* }` object                      |
| `ResolutionError`         | Other problems: missing type metadata, a non-injectable parameter type such as an interface, or a non-module in `imports` |

```text
ProviderNotFoundError: Provider not found: GreetService in module AppModule
(while resolving GreetCommand). Register it in "providers", or import a module that exports it.
```

---

## Built-in services

### `StorageService<K, V>`

An async key-value store of JSON values over a pluggable adapter. It's useful for CLI state that should survive between runs. Pick a backend with `driver`. Every driver behaves the same.

```ts
const store = new StorageService<string, Session>({ driver: "local", namespace: "my-cli" });

await store.set("session", { token: "…", expires: Date.now() + 3600_000 });
await store.get("session"); // Session | undefined
await store.has("session"); // true
await store.delete("session"); // true if it existed

for await (const [key, value] of store) console.log(key, value);
```

| Driver   | Config                                                      | Where entries live                                    |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| `local`  | `dir?` (default `./.storage`)                               | `<dir>/<namespace>/<key>.json`, atomic temp + rename  |
| `s3`     | `bucket`, `prefix?`, `client?`, or any `S3ClientConfig` option | `s3://<bucket>/<prefix>/<namespace>/<key>.json`      |
| `memory` | none                                                        | Process memory (useful in tests)                      |

Every config also takes `namespace` (default `"default"`). `new StorageService()` uses the `local` driver.

```ts
// Amazon S3, or any S3-compatible service (R2, MinIO, …) via `endpoint`
new StorageService({
  driver: "s3",
  namespace: "my-cli",
  bucket: "my-bucket",
  prefix: "apps",
  region: "us-east-1",
  // endpoint: "https://<account>.r2.cloudflarestorage.com", credentials: { … }
});

// Reuse a client you already have
new StorageService({ driver: "s3", bucket: "my-bucket", client: existingS3Client });
```

The `s3` driver loads [`@aws-sdk/client-s3`](https://www.npmjs.com/package/@aws-sdk/client-s3) only on first use, so CLIs that store data locally don't pay its startup cost.

| Member                                             | Description                                                     |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `new StorageService(config? \| adapter)`           | A driver config (see above) or any `StorageAdapter` instance     |
| `get<T>(key)`                                      | Parsed value, or `undefined` if the key doesn't exist            |
| `set(key, value)`                                  | Atomic write; no reader ever sees a partial value               |
| `has(key)` / `delete(key)`                         | Existence check / removal                                        |
| `clear()` / `size()`                               | Remove all keys / count them                                     |
| `keys()` / `values()` / `entries()` / `forEach()`  | Async iteration. The store itself iterates with `for await` as `[key, value]`. |
| `adapter`                                          | The underlying adapter (e.g. `LocalStorageAdapter#directory`)    |

- All methods are async and return promises.
- Keys are percent-encoded into file and object names. Any string round-trips exactly, and `"a/b"` and `"a_b"` stay distinct.
- Adapters store keys as strings, so their original type is lost. A key that looks like a canonical number (`"42"`) is yielded by `keys()` as a `number`.
- A missing key reads as `undefined`. Real I/O failures, a missing S3 bucket and corrupted JSON **throw** rather than being logged and swallowed.
- Values must be JSON-serializable. `set(key, undefined)` rejects.
- On S3, `delete()` checks that the object exists before deleting it. That takes two requests, because S3 deletes don't report whether anything was removed.

To inject it, register a factory:

```ts
@Module({
  providers: [
    { provide: StorageService, useFactory: () => new StorageService({ driver: "s3", bucket: "my-bucket" }) },
  ],
})
class AppModule {}
```

#### Custom adapters

An adapter moves strings. The service handles JSON, key validation and numeric keys. Only `get`, `set`, `delete` and `keys` are required. `has` and `clear` are optional fast paths.

```ts
class RedisAdapter implements StorageAdapter {
  constructor(private redis: Redis, private ns: string) {}
  get = (key: string) => this.redis.get(`${this.ns}:${key}`).then((v) => v ?? undefined);
  set = async (key: string, value: string) => void (await this.redis.set(`${this.ns}:${key}`, value));
  delete = async (key: string) => (await this.redis.del(`${this.ns}:${key}`)) > 0;
  async *keys() { /* SCAN `${this.ns}:*` and strip the prefix */ }
}

new StorageService(new RedisAdapter(redis, "my-cli")); // pass an instance…

// …or register it as a named driver, with typed options
declare module "cc-core" {
  interface StorageDrivers { redis: { url: string } }
}
registerStorageDriver("redis", ({ url }, namespace) => new RedisAdapter(new Redis(url), namespace));
new StorageService({ driver: "redis", url: "redis://localhost", namespace: "my-cli" });
```

### Scheduling

Import `ScheduleModule` once, decorate methods on any provider, and let a long-running command run them:

```ts
import { BaseCommand, Cron, CronExpression, Inject, Injectable, Interval, Module,
  ScheduleModule, ScheduleOrchestrator, Timeout } from "cc-core";

@Injectable()
class ReportTasks {
  constructor(private reports: ReportService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { timeZone: "Asia/Ho_Chi_Minh" })
  nightly() { return this.reports.build(); }

  @Interval("poll", 10_000) // or @Interval(10_000, { name, allowOverlap, runOnStart, disabled })
  poll() { /* … */ }

  @Timeout(5_000)
  warmup() { /* … */ }
}

class WorkerCommand extends BaseCommand {
  name = "worker";
  constructor(@Inject(ScheduleOrchestrator) private scheduler: ScheduleOrchestrator) { super(); }
  exec() { return this.scheduler.run(); }
}

@Module({ imports: [ScheduleModule], providers: [ReportService, ReportTasks], commands: [WorkerCommand] })
class AppModule {}
```

- **Lazy**: nothing is scheduled until `start()` / `run()`, so other commands never start timers or hang the process.
- **Discovery** covers every module in the graph. Providers registered with `useClass` or `useValue` are found; `useFactory` ones aren't (their class is unknown until created) — add those via the registry.
- **`run({ signals?, signal?, onError? })`** resolves on `SIGINT`/`SIGTERM`, when `signal` aborts, or once no job is left (e.g. only timeouts, all fired), then waits for running jobs to finish. A second Ctrl+C exits immediately.
- **No pile-ups**: a tick is skipped while the previous run of that job is still in progress, unless `allowOverlap: true`.
- **Failures are isolated**: a throwing job is reported to `onError` (default: logged as an error by [`Logger`](#logger) under the `Schedule` context) and keeps its schedule.
- Cron expressions take 5 fields, or 6 with leading seconds; invalid expressions, time zones and delays throw when the class is defined.

`SchedulerRegistry` manages jobs at runtime. Jobs added while the scheduler is started start immediately:

```ts
registry.addCron("backup", CronExpression.EVERY_DAY_AT_2AM, () => backup(), { timeZone: "UTC" });
registry.addInterval("heartbeat", 30_000, () => ping());
registry.get("backup")?.nextRunAt;  // also: isRunning, lastRunAt, runCount, run(), start(), stop()
registry.getJobs("cron");
await registry.delete("backup");    // stops it and waits for a running backup to finish
```

### `Logger`

A context-aware wrapper around [pino](https://getpino.io), with readable output from [pino-pretty](https://github.com/pinojs/pino-pretty). Create one per class:

```ts
import { Logger } from "cc-core";

@Injectable()
class DeployService {
  private readonly logger = new Logger(DeployService.name);

  async deploy(files: string[]) {
    this.logger.info("Uploading %d files", files.length); // INFO: [DeployService] Uploading 3 files
    this.logger.debug({ files }, "file list");            // hidden unless the level is debug or trace
    try {
      await upload(files);
    } catch (error) {
      this.logger.error(error, "Upload failed");          // error first: stack and cause chain included
    }
  }
}
```

- **Calls use pino's signature**: `logger.info(message, ...args)` or `logger.info(objectOrError, message?, ...args)`. Object fields become structured fields on the line.
- **Levels**, most severe first: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. Use `"silent"` to write nothing. The default is `$LOG_LEVEL` if it is set, otherwise `info`.
- **Writes to stderr**, so logs never end up in a command's piped stdout. Pass `stream` to write somewhere else.
- **Formats**: `"pretty"` (the default) and `"json"`, which is pino's NDJSON with label levels and ISO timestamps:
  `{"level":"info","time":"2026-10-15T03:30:12.872Z","context":"Deploy:S3","key":"a.zip","msg":"put"}`
- **Never loses lines on `process.exit()`.** Output is written synchronously in-process, not through a pino transport, which would run in a worker thread.
- **Colors** are used on a TTY only. `NO_COLOR` and `FORCE_COLOR` are respected.

`Logger.configure()` sets options for every logger, and loggers created before the call pick them up too, because each one rebuilds its pino instance after a `configure()`. This lets you wire up global flags after commands and services have been built:

```ts
import { LOG_LEVELS, Option } from "cc-core";

const program = createProgram(AppModule, { name: "my-cli" })
  .option("-v, --verbose", "show debug output")
  .addOption(new Option("--log-level <level>").choices(["silent", ...LOG_LEVELS]))
  .option("--json", "machine-readable logs")
  .hook("preAction", (cmd) => {
    const { verbose, logLevel, json } = cmd.opts();
    Logger.configure({ level: logLevel ?? (verbose ? "debug" : undefined), format: json ? "json" : "pretty" });
  });

await program.parseAsync();
```

| Member                                               | Description                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `new Logger(context?, options?)`                     | Options set here override the global ones for this logger           |
| `fatal` / `error` / `warn` / `info` / `debug` / `trace` | pino's log methods                                               |
| `isLevelEnabled(level)`                              | Check this before building an expensive message                     |
| `child(context, bindings?)`                          | A logger with the context `parent:context`, the same options, and `bindings` added to every line |
| `level` / `context`                                  | The current threshold and the context                               |
| `raw`                                                | The underlying pino logger                                          |
| `Logger.configure(options)` / `Logger.resetConfig()` | Merge into or reset the global options                              |

Options: `level`, `format` (`"pretty"` \| `"json"`), `timestamp` (local time in pretty output, default `false`), `colors`, `stream` (any `{ write(string) }`), and `pino` (raw [pino options](https://getpino.io/#/docs/api?id=options) such as `redact`, `serializers` or `mixin`, applied last). An invalid level throws a `TypeError`. The environment (`LOG_LEVEL`, `NO_COLOR`, `FORCE_COLOR`) is read when the pino instance is built.

`Logger` is not decorated with `@Injectable()`. If you list it as a plain provider, it is created without a context. For a logger with a context or options, use `useFactory` or create it in the class as shown above. The pino `Logger` and `LoggerOptions` types are re-exported as `PinoLogger` and `PinoOptions`.

### `SpinnerService`

An injectable wrapper around [ora](https://github.com/sindresorhus/ora).

```ts
spinner.start("Fetching data…");
await fetchData();
spinner.succeed("Done!");
```

| Member                                   | Description                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `start(text, opts?)`                     | Start a spinner with [ora options](https://github.com/sindresorhus/ora#options). Stops one already running. |
| `succeed` / `fail` / `warn` / `info(text?)` | Stop with ✔ / ✖ / ⚠ / ℹ                                                  |
| `stop()`                                 | Stop without a symbol                                                       |
| `setText(text)`                          | Change the text while it is spinning                                        |
| `isSpinning` / `raw`                     | State, and the underlying `Ora` instance                                    |

### `ProgressService`

An injectable wrapper around [cli-progress](https://github.com/npkgjs/cli-progress), for a single bar or a group of bars.

```ts
progress.start(files.length);
for (const file of files) {
  await upload(file);
  progress.increment();
}
progress.stop();

// Several bars at once
progress.startMulti();
const a = progress.addBar(100, 0, { label: "a.zip" });
const b = progress.addBar(50, 0, { label: "b.zip" });
a.increment(10);
progress.stop();
```

| Member                                       | Description                                                |
| -------------------------------------------- | ---------------------------------------------------------- |
| `start(total, startValue?, payload?, opts?)` | Start a single bar. Stops any bar already running.         |
| `update(value, payload?)`                    | Set the absolute value                                     |
| `increment(amount = 1, payload?)`            | Add to the value                                           |
| `startMulti(opts?)`                          | Start a multi-bar container (format includes `{label}`)    |
| `addBar(total, startValue?, payload?)`       | Add a bar to the container; throws before `startMulti()`   |
| `stop()`                                     | Stop and release every bar                                 |
| `rawSingle` / `rawMulti`                     | The underlying `cli-progress` instances                    |

`Presets` and the option types from `cli-progress` are re-exported.

## Utilities

```ts
await wait(1000); // sleep 1 s

const save = debounce((doc: Doc) => persist(doc), 300); // runs once, 300 ms after the last call
const log = throttle((msg: string) => console.log(msg), 500); // at most once per 500 ms
```

Both `debounce` and `throttle` keep the wrapped function's parameter types.

---

## Upgrading from 0.1.x

- **`loadCommand` now returns a `Promise`** and uses `parseAsync`, so errors from async commands reach you. Add `await` (or `.catch`) at the call site.
- **Commands with dependencies must be decorated** with `@Injectable()`. Before, undecorated commands silently received `undefined`; now you get an explanatory error.
- **`StorageService` is async and adapter-based.** Every method returns a promise, so add `await`. Iterate with `for await`. `size` is now `size()`. `set()` no longer chains. The constructor takes a config instead of positional arguments: `new StorageService("my-cli", dir)` becomes `new StorageService({ driver: "local", namespace: "my-cli", dir })`. `storage.directory` is now `(storage.adapter as LocalStorageAdapter).directory`. Files on disk keep the same layout, so existing data is still read.
- **`StorageService`** writes are atomic and errors are thrown instead of logged. Keys are percent-encoded instead of having special characters replaced by `_`. Keys made only of `[A-Za-z0-9._-]` map to the same files as before. Other keys map to new filenames, so their old data is not read under the same key.
- `ModuleNode`'s constructor no longer takes the container argument. Use `DependencyContainer#getOrCreateModuleNode`.

## Development

```bash
bun install
bun run test        # vitest
bun run typecheck   # tsc --noEmit
bun run build       # tsdown → dist/
bun run dev         # tsdown --watch
```

```text
src/
├── decorators/   @Module, @Injectable, @Inject
├── di/           DependencyContainer, ModuleNode, provider types, errors
├── commands/     BaseCommand, createProgram, loadCommand
├── built-in/     StorageService (+ local / s3 / memory adapters), scheduling, Logger, SpinnerService, ProgressService
├── utils/        wait, debounce, throttle
└── index.ts      public API (also re-exports commander)
```

## License

MIT
