import type { SupabaseClient } from '@supabase/supabase-js';
import type { ArchiveStorage } from './storage';

const BUCKET = 'legal-archive';

function throwStorageError(error: { message?: string } | null, operation: string): void {
  if (error) throw new Error(`Supabase archive ${operation} failed`);
}

export class SupabaseArchiveStorage implements ArchiveStorage {
  readonly name = 'supabase';

  constructor(private readonly client: SupabaseClient) {}

  async putTemporary(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).upload(key, body, {
      contentType,
      upsert: false,
    });
    throwStorageError(error, 'upload');
  }

  async promote(temporaryKey: string, finalKey: string, immutable: boolean): Promise<void> {
    if (immutable && await this.exists(finalKey)) throw new Error('Immutable archive key exists');
    const { error } = await this.client.storage.from(BUCKET).copy(temporaryKey, finalKey);
    throwStorageError(error, 'copy');
  }

  async exists(key: string): Promise<boolean> {
    const separator = key.lastIndexOf('/');
    const directory = separator >= 0 ? key.slice(0, separator) : '';
    const name = separator >= 0 ? key.slice(separator + 1) : key;
    const { data, error } = await this.client.storage.from(BUCKET).list(directory, {
      search: name,
      limit: 1,
    });
    throwStorageError(error, 'list');
    return (data ?? []).some((entry) => entry.name === name);
  }

  async read(key: string): Promise<Uint8Array> {
    const { data, error } = await this.client.storage.from(BUCKET).download(key);
    throwStorageError(error, 'download');
    if (!data) throw new Error('Supabase archive download returned no data');
    return new Uint8Array(await data.arrayBuffer());
  }

  async removeTemporary(prefix: string): Promise<void> {
    const bucket = this.client.storage.from(BUCKET);
    const { data, error } = await bucket.list(prefix, { limit: 1000 });
    throwStorageError(error, 'staging list');
    const paths = (data ?? []).map((entry) => `${prefix}/${entry.name}`);
    if (paths.length === 0) return;
    const removal = await bucket.remove(paths);
    throwStorageError(removal.error, 'staging removal');
  }
}
