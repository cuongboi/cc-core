/**
 * The persistence backend behind {@link StorageService}: string keys to serialized string
 * values, scoped to a single namespace. JSON encoding, key validation and numeric-key revival
 * live in the service, so every adapter behaves the same and only has to move strings.
 */
export interface StorageAdapter {
  /** The stored value, or `undefined` if the key doesn't exist. */
  get(key: string): Promise<string | undefined>;
  /** Must never expose a partially written value to readers. */
  set(key: string, value: string): Promise<void>;
  /** @returns `true` if the key existed. */
  delete(key: string): Promise<boolean>;
  /** Every stored key, in any order. Entries this adapter did not write are skipped. */
  keys(): AsyncIterable<string>;
  /** Optional fast path. Defaults to `get(key) !== undefined`. */
  has?(key: string): Promise<boolean>;
  /** Optional fast path. Defaults to deleting every key one by one. */
  clear?(): Promise<void>;
}

/** Suffix of every entry written by the file-like adapters (`local`, `s3`). */
export const STORAGE_EXTENSION = ".json";

/**
 * Reversible key encoding that is safe as a filename or object-key segment: percent-encoding,
 * plus the few characters `encodeURIComponent` leaves alone that are invalid in Windows
 * filenames. Encoding `/` also keeps keys from nesting into each other's "directories".
 */
export const encodeStorageKey = (key: string) =>
  encodeURIComponent(key).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Inverse of {@link encodeStorageKey}; `undefined` for names this encoding never produces. */
export const decodeStorageKey = (encoded: string): string | undefined => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
};
