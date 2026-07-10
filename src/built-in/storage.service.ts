import * as fs from "fs";
import * as path from "path";

import { Injectable } from "../decorators/injectable.decorator";

@Injectable()
export class StorageService<K extends string | number = string, V = unknown> {
  private static readonly STORAGE_PATH = path.join(process.cwd(), ".storage");
  private baseDir: string;

  constructor(subPath: string = "default") {
    this.baseDir = path.join(StorageService.STORAGE_PATH, subPath);
    this.ensureDirectoryExists();
  }

  private ensureDirectoryExists(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getFilePath(key: K): string {
    const safeKey = this.sanitizeKey(key);
    return path.join(this.baseDir, `${safeKey}.json`);
  }

  private sanitizeKey(key: K): string {
    let keyStr = String(key).trim();
    if (!keyStr) keyStr = "empty";
    keyStr = keyStr.replace(/[^a-zA-Z0-9._-]/g, "_");
    return keyStr.length > 200 ? keyStr.substring(0, 200) : keyStr;
  }

  // Fast check if file exists
  has(key: K): boolean {
    try {
      return fs.existsSync(this.getFilePath(key));
    } catch {
      return false;
    }
  }

  // Get with existence check first
  get<T = V>(key: K): T | undefined {
    if (!this.has(key)) {
      return undefined;
    }

    try {
      const filePath = this.getFilePath(key);
      const content = fs.readFileSync(filePath, "utf8");
      return JSON.parse(content) as unknown as T;
    } catch (err) {
      console.warn(`Failed to load key "${key}":`, err);
      return undefined;
    }
  }

  set(key: K, value: V): this {
    try {
      fs.writeFileSync(this.getFilePath(key), JSON.stringify(value, null, 2));
    } catch (err) {
      console.error(`Failed to save key "${key}":`, err);
    }
    return this;
  }

  delete(key: K): boolean {
    try {
      const filePath = this.getFilePath(key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch (err) {
      console.error(`Failed to delete key "${key}":`, err);
    }
    return false;
  }

  clear(): void {
    try {
      const files = fs.readdirSync(this.baseDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          fs.unlinkSync(path.join(this.baseDir, file));
        }
      }
    } catch (err) {
      console.error("Failed to clear storage:", err);
    }
  }

  get size(): number {
    try {
      const files = fs.readdirSync(this.baseDir);
      return files.filter((file) => file.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  // Iterator helpers (loads all keys)
  *keys(): IterableIterator<K> {
    try {
      const files = fs.readdirSync(this.baseDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const keyStr = file.slice(0, -5);
          const key = (Number.isNaN(Number(keyStr)) ? keyStr : Number(keyStr)) as K;
          yield key;
        }
      }
    } catch (_) {}
  }

  *values(): IterableIterator<V> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value !== undefined) yield value;
    }
  }

  *entries(): IterableIterator<[K, V]> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value !== undefined) yield [key, value];
    }
  }

  forEach(callback: (value: V, key: K, map: this) => void): void {
    for (const [key, value] of this.entries()) {
      callback(value, key, this);
    }
  }
}
