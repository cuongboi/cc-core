import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { STORAGE_EXTENSION, decodeStorageKey, encodeStorageKey, type StorageAdapter } from "./storage-adapter";

/** Leaves room for the extension and the temp-file suffix within the 255-byte filename limit. */
const MAX_ENCODED_KEY_LENGTH = 200;

const isNotFound = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

export interface LocalStorageOptions {
  /** Root directory; each namespace is a subdirectory of it. Default: `./.storage`. */
  dir?: string;
}

/**
 * One JSON file per key under `<dir>/<namespace>/`. The directory is created on first write.
 * Writes are atomic (temp file + rename), so a crash never leaves a half-written value.
 */
export class LocalStorageAdapter implements StorageAdapter {
  /** Absolute directory holding this namespace's files. */
  readonly directory: string;

  constructor({ dir = path.join(process.cwd(), ".storage") }: LocalStorageOptions = {}, namespace = "default") {
    this.directory = path.resolve(dir, namespace);
  }

  async get(key: string): Promise<string | undefined> {
    try {
      return await fs.readFile(this.filePath(key), "utf8");
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.filePath(key);
    // Unique per call, so concurrent writes to the same key never share a temp file.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, value);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(tmp, value);
    }
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(key));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      await fs.access(this.filePath(key));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const file of await this.files()) {
      const key = decodeStorageKey(file.slice(0, -STORAGE_EXTENSION.length));
      if (key) yield key;
    }
  }

  async clear(): Promise<void> {
    const files = await this.files();
    await Promise.all(files.map((file) => fs.rm(path.join(this.directory, file), { force: true })));
  }

  private filePath(key: string): string {
    const encoded = encodeStorageKey(key);
    if (encoded.length > MAX_ENCODED_KEY_LENGTH) {
      throw new RangeError(`Storage key is too long: "${key.slice(0, 40)}…"`);
    }
    return path.join(this.directory, encoded + STORAGE_EXTENSION);
  }

  private async files(): Promise<string[]> {
    try {
      return (await fs.readdir(this.directory)).filter((file) => file.endsWith(STORAGE_EXTENSION));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }
}
