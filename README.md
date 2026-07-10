# Commander

A lightweight TypeScript library that brings **NestJS-style dependency injection and module system** to [commander.js](https://github.com/tj/commander.js) CLI applications. Organize your CLI commands into injectable services and modules with a clean, decorator-driven API.

## Features

- 🎯 **Decorator-based DI** — `@Injectable`, `@Inject`, `@Module`
- 📦 **Module system** — import/export providers across modules
- 🔌 **Multiple provider types** — `useClass`, `useValue`, `useFactory`
- 💉 **Constructor & property injection**
- 🔄 **Circular dependency detection**
- 🗄️ **Built-in `StorageService`** — simple file-system key-value store
- 🌀 **Built-in `SpinnerService`** — injectable [ora](https://github.com/sindresorhus/ora) spinner wrapper
- 📊 **Built-in `ProgressService`** — injectable [cli-progress](https://github.com/npkgjs/cli-progress) bar wrapper
- ⏱️ **Utility helpers** — `wait`, `debounce`, `throttle`
- 🏗️ **`loadCommand`** — one-call bootstrap that wires everything into a `commander` program

---

## Installation

```bash
npm install commander reflect-metadata ora cli-progress
```

> **Important:** You must import `reflect-metadata` once at the entry point of your application (or have it imported by the library automatically, as this package does it for you).

Enable TypeScript decorator support in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

---

## Quick Start

```ts
import "reflect-metadata";
import { Module, Injectable, BaseCommand, loadCommand } from "commander-lib";
import { Argument } from "commander";

@Injectable()
class GreetService {
  greet(name: string) {
    return `Hello, ${name}!`;
  }
}

class GreetCommand extends BaseCommand {
  name = "greet";
  description = "Greet someone";
  arguments = [new Argument("<name>", "Name to greet")];

  constructor(private svc: GreetService) {
    super();
  }

  exec(name: string) {
    console.log(this.svc.greet(name));
  }
}

@Module({
  providers: [GreetService],
  commands: [GreetCommand],
})
class AppModule {}

loadCommand(AppModule, {
  name: "my-cli",
  description: "My awesome CLI",
  version: "1.0.0",
});
```

Run it:

```bash
npx ts-node index.ts greet World
# Hello, World!
```

---

## Core Concepts

### `@Injectable()`

Marks a class as a dependency-injection candidate. Apply it to any service you want the DI container to manage.

```ts
@Injectable()
class DatabaseService {
  query(sql: string) {
    /* ... */
  }
}
```

### `@Module(options)`

Declares a module that groups providers, commands, imports, and exports. Modules are the unit of organization.

| Option      | Type    | Description                                                         |
| ----------- | ------- | ------------------------------------------------------------------- |
| `providers` | `any[]` | Services (classes or provider objects) available within this module |
| `commands`  | `any[]` | `BaseCommand` subclasses registered into the CLI program            |
| `imports`   | `any[]` | Other modules whose **exported** providers become available here    |
| `exports`   | `any[]` | Providers to expose to importing modules                            |

```ts
@Module({
  providers: [DatabaseService, UserService],
  commands: [UserCommand],
  exports: [UserService],
})
class UserModule {}

@Module({
  imports: [UserModule], // UserService is now available here
  commands: [AdminCommand],
})
class AdminModule {}
```

### `@Inject(token)`

Override the default injection token for a constructor parameter or property. Use this when injecting by a `Symbol` token or when `emitDecoratorMetadata` is not emitting the type automatically.

```ts
const DB_CONFIG = Symbol("DB_CONFIG");

@Module({
  providers: [{ provide: DB_CONFIG, useValue: { host: "localhost", port: 5432 } }, DatabaseService],
})
class AppModule {}

@Injectable()
class DatabaseService {
  constructor(@Inject(DB_CONFIG) private config: { host: string; port: number }) {}
}
```

---

## Provider Types

All three provider shapes are supported in `providers`:

### `useClass` (default for plain classes)

```ts
@Module({ providers: [MyService] })
// equivalent to:
@Module({ providers: [{ provide: MyService, useClass: MyService }] })
```

### `useValue`

Bind a token to a static value:

```ts
const API_URL = Symbol("API_URL");

@Module({
  providers: [{ provide: API_URL, useValue: "https://api.example.com" }],
})
class AppModule {}
```

### `useFactory`

Compute a value dynamically, with optional injected dependencies:

```ts
const CONFIG_TOKEN = Symbol("config");
const SERVICE_TOKEN = Symbol("service");

@Module({
  providers: [
    { provide: CONFIG_TOKEN, useValue: { prefix: "Hello" } },
    {
      provide: SERVICE_TOKEN,
      useFactory: (cfg: { prefix: string }) => new MyService(cfg),
      inject: [CONFIG_TOKEN],
    },
  ],
})
class AppModule {}
```

---

## `BaseCommand`

Extend `BaseCommand` to define CLI commands. The `register` method is called automatically by `loadCommand`.

```ts
import { BaseCommand } from "commander-lib";
import { Option, Argument } from "commander";

@Injectable()
class EchoService {
  echo(msg: string) {
    return `Echo: ${msg}`;
  }
}

class EchoCommand extends BaseCommand {
  name = "echo";
  description = "Echo a message";
  arguments = [new Argument("<msg>", "Message to echo")];
  options = [new Option("-u, --upper", "Uppercase output")];

  constructor(private svc: EchoService) {
    super();
  }

  exec(msg: string, opts: { upper?: boolean }) {
    const result = this.svc.echo(msg);
    console.log(opts.upper ? result.toUpperCase() : result);
  }
}

@Module({ providers: [EchoService], commands: [EchoCommand] })
class EchoModule {}
```

| Property        | Type         | Required | Description          |
| --------------- | ------------ | -------- | -------------------- |
| `name`          | `string`     | ✅       | The sub-command name |
| `description`   | `string`     | —        | Help text            |
| `arguments`     | `Argument[]` | —        | Positional arguments |
| `options`       | `Option[]`   | —        | Option flags         |
| `exec(...args)` | method       | ✅       | Command handler      |

---

## `loadCommand(rootModule, options)`

Bootstraps the entire CLI. Creates a `DependencyContainer`, resolves all modules, instantiates commands, and calls `program.parse()`.

```ts
loadCommand(AppModule, {
  name: "my-cli",
  description: "My awesome CLI",
  version: "1.0.0",
});
```

---

## `DependencyContainer` / `ModuleNode`

You can use the DI container directly without the CLI layer:

```ts
import { DependencyContainer } from "commander-lib";

const container = new DependencyContainer();
const node = container.getOrCreateModuleNode(AppModule);

const service = node.resolve(MyService);
```

- **`DependencyContainer`** — top-level registry; returns singleton `ModuleNode` instances per module class.
- **`ModuleNode`** — manages providers and instances for a single module. Providers are resolved lazily and cached (singleton within a module).

---

## `StorageService`

A built-in file-system key-value store backed by `.json` files in a `.storage/` directory. Useful for persisting CLI state between runs.

```ts
import { StorageService } from "commander-lib";

const store = new StorageService("my-cli"); // stores in .storage/my-cli/

store.set("lastRun", new Date().toISOString());
console.log(store.get("lastRun")); // "2026-07-10T..."
console.log(store.has("lastRun")); // true
store.delete("lastRun");
store.clear(); // remove all keys

// Iterate
for (const [key, value] of store.entries()) {
  console.log(key, value);
}
```

| Method            | Description                       |
| ----------------- | --------------------------------- |
| `has(key)`        | Check if a key exists             |
| `get<T>(key)`     | Read and deserialize a value      |
| `set(key, value)` | Serialize and write a value       |
| `delete(key)`     | Remove a single key               |
| `clear()`         | Remove all keys in this namespace |
| `size`            | Number of stored keys             |
| `keys()`          | Iterate over all keys             |
| `values()`        | Iterate over all values           |
| `entries()`       | Iterate over `[key, value]` pairs |

`StorageService<K, V>` is generic — `K` is the key type (`string | number`), `V` is the value type.

---

## `SpinnerService`

An injectable wrapper around [ora](https://github.com/sindresorhus/ora) for elegant terminal spinners.

```ts
import { SpinnerService } from "commander-lib";

const spinner = new SpinnerService();

spinner.start("Fetching data…");
await fetchData();
spinner.succeed("Done!");

// Update text while running
spinner.start("Step 1").setText("Step 2");
spinner.fail("Something went wrong!");
```

| Method               | Description                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `start(text, opts?)` | Start the spinner with optional [ora options](https://github.com/sindresorhus/ora#options) |
| `succeed(text?)`     | Stop with a ✔ success symbol                                                               |
| `fail(text?)`        | Stop with a ✖ failure symbol                                                               |
| `warn(text?)`        | Stop with a ⚠ warning symbol                                                               |
| `info(text?)`        | Stop with a ℹ info symbol                                                                  |
| `stop()`             | Stop without a result symbol                                                               |
| `setText(text)`      | Update the spinner text while running                                                      |
| `isSpinning`         | `true` when the spinner is active                                                          |
| `raw`                | Direct access to the underlying `Ora` instance                                             |

All methods return `this` for chaining. Calling `start()` when a spinner is already running automatically stops the previous one.

---

## `ProgressService`

An injectable wrapper around [cli-progress](https://github.com/npkgjs/cli-progress) for single and multi-bar progress displays.

### Single bar

```ts
import { ProgressService, wait } from "commander-lib";

const progress = new ProgressService();
progress.start(100, 0, { title: "Downloading" });

for (let i = 0; i <= 100; i++) {
  progress.update(i);
  await wait(10);
}

progress.stop();
```

### Multi-bar

```ts
const progress = new ProgressService();
progress.startMulti();

const bar1 = progress.addBar(100, 0, { label: "File 1" });
const bar2 = progress.addBar(50, 0, { label: "File 2" });

bar1.increment(10);
bar2.increment(5);

progress.stop();
```

| Method                                       | Description                                 |
| -------------------------------------------- | ------------------------------------------- |
| `start(total, startValue?, payload?, opts?)` | Start a single progress bar                 |
| `update(value, payload?)`                    | Set the current value                       |
| `increment(amount?, payload?)`               | Increment the value (default +1)            |
| `startMulti(opts?)`                          | Initialize a multi-bar container            |
| `addBar(total, startValue?, payload?)`       | Add a child bar to the multi-bar            |
| `stop()`                                     | Stop and clean up the active bar(s)         |
| `rawSingle`                                  | Direct access to the underlying `SingleBar` |
| `rawMulti`                                   | Direct access to the underlying `MultiBar`  |

All methods return `this` for chaining. The `Presets` enum from `cli-progress` is also re-exported for convenience.

---

## Utility Functions

### `wait(ms)`

Returns a promise that resolves after `ms` milliseconds.

```ts
import { wait } from "commander-lib";

await wait(1000); // pause for 1 second
```

### `debounce(fn, ms)`

Wraps a function so it only executes after `ms` milliseconds have passed since the last call.

```ts
import { debounce } from "commander-lib";

const save = debounce(() => console.log("Saving..."), 300);
save();
save();
save(); // only fires once after 300ms
```

### `throttle(fn, ms)`

Wraps a function so it fires immediately but then ignores further calls for `ms` milliseconds.

```ts
import { throttle } from "commander-lib";

const log = throttle(() => console.log("Fired!"), 500);
log(); // fires
log(); // ignored (within 500ms)
```

---

## Development

```bash
# Install dependencies
bun install

# Run tests
bun run test        # or: npx vitest

# Type-check
bun run typecheck   # tsc --noEmit

# Build
bun run build       # tsdown

# Watch mode
bun run dev         # tsdown --watch
```

---

## Project Structure

```
src/
├── decorators/
│   ├── injectable.decorator.ts   # @Injectable()
│   ├── inject.decorator.ts       # @Inject(token)
│   └── module.decorator.ts       # @Module(options)
├── di/
│   └── container.ts              # DependencyContainer + ModuleNode
├── commands/
│   ├── base-command.ts           # BaseCommand abstract class
│   ├── command-loader.ts         # loadCommand() bootstrap
│   └── command.interface.ts      # CommandInterface
├── built-in/
│   ├── storage.service.ts        # StorageService
│   ├── spinner.service.ts        # SpinnerService (ora wrapper)
│   └── progress.service.ts       # ProgressService (cli-progress wrapper)
├── utils/
│   └── timer.ts                  # wait / debounce / throttle
└── index.ts                      # Public re-exports
```

---

## License

MIT
