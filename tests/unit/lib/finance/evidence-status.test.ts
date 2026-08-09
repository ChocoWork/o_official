import { resolveEvidenceStatus } from '@/lib/finance/evidence-status';

describe('resolveEvidenceStatus', () => {
  it('treats online orders as a saved system record', () => {
    expect(resolveEvidenceStatus({ source: 'order', receipts: [] })).toBe(
      'system_record',
    );
  });

  it('requires evidence for manual entries without receipts', () => {
    expect(resolveEvidenceStatus({ source: 'manual', receipts: [] })).toBe(
      'missing',
    );
  });

  it('marks manual entries with receipts as attached', () => {
    expect(
      resolveEvidenceStatus({ source: 'manual', receipts: [{ id: 1 }] }),
    ).toBe('attached');
  });
});
