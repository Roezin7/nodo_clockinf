/**
 * Object storage para fotos (R2/S3-compatible).
 * Si no hay credenciales S3 configuradas, usa disco local (./uploads-local) —
 * SOLO para desarrollo; en producción las fotos nunca viven en el disco del server.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export interface PhotoStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** URL temporal para visualizar la foto (firmada, expira). */
  viewUrl(key: string): Promise<string>;
  remove(key: string): Promise<void>;
  /** Lista keys bajo un prefijo (para el job de retención). */
  list(prefix: string): Promise<string[]>;
}

class S3Storage implements PhotoStorage {
  private client = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint || undefined,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  });

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: body, ContentType: contentType })
    );
  }

  async viewUrl(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }), {
      expiresIn: 900,
    });
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token })
      );
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.NextContinuationToken;
    } while (token);
    return keys;
  }
}

const LOCAL_DIR = path.resolve(process.cwd(), 'uploads-local');

class LocalStorage implements PhotoStorage {
  private filePath(key: string): string {
    const p = path.resolve(LOCAL_DIR, key);
    if (!p.startsWith(LOCAL_DIR + path.sep)) throw new Error('key inválida');
    return p;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const p = this.filePath(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
  }

  async viewUrl(key: string): Promise<string> {
    return `/api/photos/local/${encodeURIComponent(key)}`;
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.filePath(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const base = path.resolve(LOCAL_DIR, prefix);
    const keys: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else keys.push(path.relative(LOCAL_DIR, full));
      }
    }
    await walk(base);
    return keys;
  }
}

export const storageIsLocal = !config.s3.accessKeyId;
export const storage: PhotoStorage = storageIsLocal ? new LocalStorage() : new S3Storage();
export { LOCAL_DIR };
