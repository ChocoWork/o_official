import { SupabaseArchiveStorage } from '@/lib/legal-archive/supabase-storage';

it('uses the private legal-archive bucket without upserts', async () => {
  const bucket = {
    upload: jest.fn().mockResolvedValue({ error: null }),
    download: jest.fn().mockResolvedValue({ data: new Blob(['data']), error: null }),
    copy: jest.fn().mockResolvedValue({ error: null }),
    list: jest.fn().mockResolvedValue({ data: [], error: null }),
    remove: jest.fn().mockResolvedValue({ error: null }),
  };
  const client = { storage: { from: jest.fn().mockReturnValue(bucket) } };
  const storage = new SupabaseArchiveStorage(client as never);
  await storage.putTemporary('_staging/run/orders.csv', new Uint8Array([1]), 'text/csv');
  expect(client.storage.from).toHaveBeenCalledWith('legal-archive');
  expect(bucket.upload).toHaveBeenCalledWith(
    '_staging/run/orders.csv', expect.any(Uint8Array),
    expect.objectContaining({ upsert: false, contentType: 'text/csv' }),
  );
});
