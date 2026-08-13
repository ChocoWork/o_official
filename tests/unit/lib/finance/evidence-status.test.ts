import { resolveEvidenceStatus } from '@/lib/finance/evidence-status';

describe('resolveEvidenceStatus', () => {
  test.each([
    [
      { source: 'order', receipts: [], evidenceUnavailable: {} },
      'system_record',
    ],
    [
      { source: 'manual', receipts: [{}], evidenceUnavailable: {} },
      'attached',
    ],
    [
      {
        source: 'manual',
        receipts: [],
        evidenceUnavailable: { reason: 'not_issued' },
      },
      'unavailable_recorded',
    ],
    [{ source: 'manual', receipts: [] }, 'missing'],
  ] as const)(
    'returns %s when evidence inputs are prioritized',
    (entry, expected) => {
      expect(resolveEvidenceStatus(entry)).toBe(expected);
    },
  );
});
