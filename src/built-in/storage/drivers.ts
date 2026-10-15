import { LocalStorageAdapter, type LocalStorageOptions } from "./local.adapter";
import { MemoryStorageAdapter } from "./memory.adapter";
import { S3StorageAdapter, type S3StorageOptions } from "./s3.adapter";
import type { StorageAdapter } from "./storage-adapter";

/**
 * Options of every named storage driver. Augment it to type a driver of your own:
 *
 * ```ts
 * declare module "cc-core" {
 *   interface StorageDrivers { redis: { url: string } }
 * }
 * registerStorageDriver("redis", ({ url }, namespace) => new RedisAdapter(url, namespace));
 * ```
 */
export interface StorageDrivers {
  local: LocalStorageOptions;
  memory: object;
  s3: S3StorageOptions;
}

export type StorageDriver = keyof StorageDrivers;

/** `{ driver, namespace?, ...that driver's options }`, discriminated on `driver`. */
export type StorageConfig = {
  [D in StorageDriver]: { driver: D; namespace?: string } & StorageDrivers[D];
}[StorageDriver];

export type StorageDriverFactory<D extends StorageDriver = StorageDriver> = (
  options: StorageDrivers[D],
  namespace: string,
) => StorageAdapter;

const factories = new Map<string, StorageDriverFactory<any>>([
  ["local", (options: LocalStorageOptions, namespace) => new LocalStorageAdapter(options, namespace)],
  ["memory", () => new MemoryStorageAdapter()],
  ["s3", (options: S3StorageOptions, namespace) => new S3StorageAdapter(options, namespace)],
]);

/** Add a driver, or replace a built-in one, for `new StorageService({ driver })`. */
export function registerStorageDriver<D extends StorageDriver>(driver: D, factory: StorageDriverFactory<D>): void {
  factories.set(driver, factory);
}

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  const { driver, namespace = "default", ...options } = config;
  const factory = factories.get(driver);
  if (!factory) {
    throw new TypeError(`Unknown storage driver "${driver}". Register it with registerStorageDriver().`);
  }
  return factory(options, namespace);
}
