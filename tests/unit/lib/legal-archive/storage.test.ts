import { storeArchiveAtomically, type ArchiveStorage } from '@/lib/legal-archive/storage';

function memoryTarget(name: string): ArchiveStorage & { values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return {
    name,
    values,
    putTemporary: jest.fn(async (key, body) => { values.set(key, body); }),
    promote: jest.fn(async (temporaryKey, finalKey, immutable) => {
      if (immutable && values.has(finalKey)) throw new Error('exists');
      values.set(finalKey, values.get(temporaryKey)!);
    }),
    exists: jest.fn(async (key) => values.has(key)),
    read: jest.fn(async (key) => values.get(key)!),
    removeTemporary: jest.fn(async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    }),
  };
}

describe('storeArchiveAtomically', () => {
  it('verifies every target before promoting artifacts and manifest', async () => {
    const first = memoryTarget('supabase');
    const second = memoryTarget('external');
    const result = await storeArchiveAtomically({
      artifacts: { 'orders.csv': new TextEncoder().encode('id\r\n') },
      targets: [first, second],
      finalPrefix: 'legal-archive/2026/daily/2026-08-10',
      runId: 'run-1',
      immutable: true,
      buildManifest: (targets) => new TextEncoder().encode(JSON.stringify(targets)),
    });
    expect(result.targets).toEqual([
      { name: 'external', verified: true },
      { name: 'supabase', verified: true },
    ]);
    expect(first.values.has('legal-archive/2026/daily/2026-08-10/manifest.json')).toBe(true);
    expect(second.values.has('legal-archive/2026/daily/2026-08-10/orders.csv')).toBe(true);
  });

  it('cleans staging and promotes nothing when verification fails', async () => {
    const target = memoryTarget('broken');
    target.read = jest.fn(async () => new TextEncoder().encode('changed'));
    await expect(storeArchiveAtomically({
      artifacts: { 'orders.csv': new TextEncoder().encode('id\r\n') },
      targets: [target], finalPrefix: 'final', runId: 'run-2', immutable: true,
      buildManifest: () => new Uint8Array(),
    })).rejects.toThrow('verification');
    expect(target.promote).not.toHaveBeenCalled();
    expect(target.removeTemporary).toHaveBeenCalledWith('_staging/run-2');
  });
});
