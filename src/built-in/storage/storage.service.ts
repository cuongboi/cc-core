import { createStorageAdapter, type StorageConfig } from "./drivers";
import type { StorageAdapter } from "./storage-adapter";

const isAdapter = (value: StorageConfig | StorageAdapter): value is StorageAdapter =>
  typeof (value as StorageAdapter).get === "function";

const toRawKey = (key: string | number): string => {
  const raw = String(key);
  if (!raw) throw new TypeError("Storage key must be a non-empty string or number.");
  return raw;
};

/**
 * A persistent, async key-value store of JSON values over a pluggable {@link StorageAdapter}.
 * Missing keys read as `undefined`; I/O errors are thrown.
 *
 * ```ts
 * new StorageService();                                            // ./.storage/default
 * new StorageService({ driver: "local", namespace: "my-cli", dir: "~/.config" });
 * new StorageService({ driver: "s3", namespace: "my-cli", bucket: "b", region: "us-east-1" });
 * new StorageService(myAdapter);                                   // any StorageAdapter
 * ```
 *
 * Not decorated with `@Injectable()`, so listing it as a plain provider constructs it with the
 * default local driver. For any other configuration, register it with `useFactory`.
 */
export class StorageService<K extends string | number = string, V = unknown> {
  readonly adapter: StorageAdapter;

  constructor(config: StorageConfig | StorageAdapter = { driver: "local" }) {
    this.adapter = isAdapter(config) ? config : createStorageAdapter(config);
  }

  async has(key: K): Promise<boolean> {
    const raw = toRawKey(key);
    if (this.adapter.has) return this.adapter.has(raw);
    return (await this.adapter.get(raw)) !== undefined;
  }

  async get<T = V>(key: K): Promise<T | undefined> {
    const content = await this.adapter.get(toRawKey(key));
    return content === undefined ? undefined : (JSON.parse(content) as T);
  }

  async set(key: K, value: V): Promise<void> {
    const raw = toRawKey(key);
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) {
      throw new TypeError(`Cannot store key "${raw}": value is not JSON-serializable.`);
    }
    await this.adapter.set(raw, json);
  }

  /** @returns `true` if the key existed. */
  async delete(key: K): Promise<boolean> {
    return this.adapter.delete(toRawKey(key));
  }

  async clear(): Promise<void> {
    if (this.adapter.clear) return this.adapter.clear();
    const keys: string[] = [];
    for await (const key of this.adapter.keys()) keys.push(key); // don't delete mid-listing
    for (const key of keys) await this.adapter.delete(key);
  }

  async size(): Promise<number> {
    let count = 0;
    for await (const _ of this.adapter.keys()) count++;
    return count;
  }

  /**
   * Adapters store keys as strings, so their original type is lost: a key that reads back
   * as a canonical number (e.g. `"42"`, not `"042"`) is yielded as a number.
   */
  async *keys(): AsyncIterableIterator<K> {
    for await (const key of this.adapter.keys()) {
      yield (String(Number(key)) === key ? Number(key) : key) as K;
    }
  }

  async *values(): AsyncIterableIterator<V> {
    for await (const [, value] of this.entries()) yield value;
  }

  async *entries(): AsyncIterableIterator<[K, V]> {
    for await (const key of this.keys()) {
      const value = await this.get(key);
      if (value !== undefined) yield [key, value];
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[K, V]> {
    return this.entries();
  }

  /** Visits entries one at a time, awaiting the callback before reading the next. */
  async forEach(callback: (value: V, key: K, storage: this) => unknown): Promise<void> {
    for await (const [key, value] of this.entries()) {
      await callback(value, key, this);
    }
  }
}
