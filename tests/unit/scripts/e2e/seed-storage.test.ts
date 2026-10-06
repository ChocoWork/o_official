/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SEED_IMAGE_PNG_BASE64,
  SEED_STORAGE_OBJECTS,
  seedLocalStorage,
  type StorageClient,
} from '@/../scripts/e2e/seed-storage';

const localEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'local-service-role-key',
};

function fakeClient(result: { error: { message: string } | null } = { error: null }) {
  const upload = jest.fn().mockResolvedValue(result);
  const from = jest.fn(() => ({ upload }));
  const client: StorageClient = { storage: { from } };
  return { client, from, upload };
}

describe('seedLocalStorage', () => {
  it('見本データが指す40件の画像を、上書きで置く', async () => {
    const { client, from, upload } = fakeClient();
    const makeClient = jest.fn(() => client);

    await expect(seedLocalStorage(localEnv, makeClient)).resolves.toBe(40);

    expect(makeClient).toHaveBeenCalledWith('http://127.0.0.1:54321', 'local-service-role-key');
    expect(upload).toHaveBeenCalledTimes(40);
    expect(from).toHaveBeenCalledWith('item-images');
    expect(from).toHaveBeenCalledWith('look-images');
    expect(from).toHaveBeenCalledWith('news-images');
    const [path, body, options] = upload.mock.calls[0];
    expect(path).toBe('e2e/item-1-1.png');
    expect(Buffer.compare(body, Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64'))).toBe(0);
    expect(options).toEqual({ contentType: 'image/png', upsert: true });
  });

  it('手元でない Supabase には置かない', async () => {
    const { client } = fakeClient();
    const makeClient = jest.fn(() => client);
    await expect(
      seedLocalStorage({ ...localEnv, NEXT_PUBLIC_SUPABASE_URL: 'https://prodproject.supabase.co' }, makeClient),
    ).rejects.toThrow('手元の Supabase 以外には見本の画像を置きません');
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('置けなかったら、どの画像かを言って止める', async () => {
    const { client } = fakeClient({ error: { message: 'Bucket not found' } });
    await expect(seedLocalStorage(localEnv, () => client)).rejects.toThrow(
      'item-images/e2e/item-1-1.png（Bucket not found）',
    );
  });

  it('PNG の頭（署名）を持つ', () => {
    expect(Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('seed.sql が指す画像と、置く画像の一覧が一致する', () => {
    const seed = readFileSync(join(process.cwd(), 'supabase', 'seed.sql'), 'utf8');
    const referenced = new Set(seed.match(/e2e\/(?:item|look|news)-[0-9-]+\.png/g) ?? []);
    const placed = new Set(SEED_STORAGE_OBJECTS.map((object) => object.path));
    expect([...referenced].sort()).toEqual([...placed].sort());
    for (const object of SEED_STORAGE_OBJECTS) {
      const kind = object.path.slice('e2e/'.length).split('-')[0];
      expect(object.bucket).toBe(`${kind}-images`);
    }
  });
});
