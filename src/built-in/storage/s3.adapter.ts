import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { STORAGE_EXTENSION, decodeStorageKey, encodeStorageKey, type StorageAdapter } from "./storage-adapter";

type S3Module = typeof import("@aws-sdk/client-s3");

/** S3's object-key limit, in UTF-8 bytes. */
const MAX_OBJECT_KEY_BYTES = 1024;
/** DeleteObjects accepts at most this many keys per request. */
const DELETE_BATCH_SIZE = 1000;

/** The SDK is loaded on first use, so CLIs that never touch S3 don't pay its startup cost. */
let s3Module: Promise<S3Module> | undefined;
const loadS3 = () => (s3Module ??= import("@aws-sdk/client-s3"));

/**
 * `NoSuchKey` (GetObject) and `NotFound` (HeadObject) mean the object is missing.
 * Anything else, including `NoSuchBucket`, is a real error and is rethrown.
 */
const isMissing = (err: unknown) => {
  const name = (err as Error)?.name;
  return name === "NoSuchKey" || name === "NotFound";
};

const trimSlashes = (segment: string) => segment.replace(/^\/+|\/+$/g, "");

export interface S3StorageOptions extends S3ClientConfig {
  bucket: string;
  /** Object-key prefix that namespaces live under, e.g. `"apps/my-cli"`. Default: none. */
  prefix?: string;
  /** An existing client to reuse. When given, the client config options are ignored. */
  client?: S3Client;
}

/**
 * One JSON object per key at `s3://<bucket>/<prefix>/<namespace>/<encoded key>.json`.
 * Works with any S3-compatible service (R2, MinIO, …) via the `endpoint` option.
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly bucket: string;
  /** Object-key prefix of this namespace, always ending in `/`. */
  readonly prefix: string;
  private client: Promise<S3Client> | undefined;
  private readonly clientConfig: S3ClientConfig;

  constructor({ bucket, prefix = "", client, ...clientConfig }: S3StorageOptions, namespace = "default") {
    if (!bucket) throw new TypeError('The "s3" storage driver requires a "bucket".');
    this.bucket = bucket;
    this.prefix = `${[prefix, namespace].map(trimSlashes).filter(Boolean).join("/")}/`;
    this.client = client && Promise.resolve(client);
    this.clientConfig = clientConfig;
  }

  async get(key: string): Promise<string | undefined> {
    const [{ GetObjectCommand }, client] = await this.connect();
    try {
      const { Body } = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return await Body?.transformToString("utf-8");
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  }

  /** PutObject is atomic: readers see the old object or the new one, never a partial write. */
  async set(key: string, value: string): Promise<void> {
    const [{ PutObjectCommand }, client] = await this.connect();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: value,
        ContentType: "application/json",
      }),
    );
  }

  /** S3 deletes don't report whether the object existed, so this checks first (two requests). */
  async delete(key: string): Promise<boolean> {
    if (!(await this.has(key))) return false;
    const [{ DeleteObjectCommand }, client] = await this.connect();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    return true;
  }

  async has(key: string): Promise<boolean> {
    const [{ HeadObjectCommand }, client] = await this.connect();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for await (const objectKey of this.objectKeys()) {
      const key = decodeStorageKey(objectKey.slice(this.prefix.length, -STORAGE_EXTENSION.length));
      if (key) yield key;
    }
  }

  async clear(): Promise<void> {
    const [{ DeleteObjectsCommand }, client] = await this.connect();
    const flush = async (batch: string[]) => {
      const { Errors } = await client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (Errors?.length) {
        const [first] = Errors;
        throw new Error(`Failed to delete ${Errors.length} object(s), e.g. "${first?.Key}": ${first?.Message}`);
      }
    };

    let batch: string[] = [];
    for await (const objectKey of this.objectKeys()) {
      batch.push(objectKey);
      if (batch.length === DELETE_BATCH_SIZE) {
        await flush(batch);
        batch = [];
      }
    }
    if (batch.length) await flush(batch);
  }

  /**
   * Full object keys of this namespace's entries, across every page of the listing.
   * Encoded keys never contain `/`, so the delimiter excludes nested namespaces (`a/b` under `a`).
   */
  private async *objectKeys(): AsyncIterableIterator<string> {
    const [{ ListObjectsV2Command }, client] = await this.connect();
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          Delimiter: "/",
          ContinuationToken: token,
        }),
      );
      for (const { Key } of page.Contents ?? []) {
        if (Key?.endsWith(STORAGE_EXTENSION)) yield Key;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  private objectKey(key: string): string {
    const objectKey = this.prefix + encodeStorageKey(key) + STORAGE_EXTENSION;
    if (Buffer.byteLength(objectKey) > MAX_OBJECT_KEY_BYTES) {
      throw new RangeError(`Storage key is too long: "${key.slice(0, 40)}…"`);
    }
    return objectKey;
  }

  private connect(): Promise<[S3Module, S3Client]> {
    this.client ??= loadS3().then(({ S3Client }) => new S3Client(this.clientConfig));
    return Promise.all([loadS3(), this.client]);
  }
}
