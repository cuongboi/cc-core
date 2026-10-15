import type { StorageAdapter } from "./storage-adapter";

/**
 * Keeps entries in process memory; nothing survives a restart. Values are stored serialized,
 * so reads return fresh copies exactly as the persistent adapters do. Handy in tests.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly entries = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.entries.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.entries.has(key);
  }

  async *keys(): AsyncIterableIterator<string> {
    yield* [...this.entries.keys()]; // snapshot, so deleting while iterating is safe
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}
