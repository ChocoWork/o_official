import { buildManifest, serializeManifest, sha256 } from '@/lib/legal-archive/manifest';

describe('legal archive manifest', () => {
  it('hashes UTF-8 artifacts and serializes deterministically', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const manifest = buildManifest({
      fiscalYear: 2026,
      generatedAt: '2026-08-10T00:00:00.000Z',
      gitCommit: 'abc123',
      previousManifestSha256: 'previous',
      artifacts: { 'orders.csv': '注文\r\n' },
      rowCounts: { orders: 1, orderItems: 0, revisions: 0 },
      totals: { grossAmount: 1000, refundedAmount: 100, netAmount: 900 },
      storageTargets: [{ name: 'supabase', verified: true }],
    });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.retentionYears).toBe(7);
    expect(manifest.files['orders.csv'].byteSize).toBe(Buffer.byteLength('注文\r\n'));
    expect(serializeManifest(manifest)).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });
});
