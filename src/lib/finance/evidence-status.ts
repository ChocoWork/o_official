export type EvidenceStatus = 'attached' | 'missing' | 'system_record';

export function resolveEvidenceStatus(entry: {
  source?: 'manual' | 'order';
  receipts?: readonly unknown[];
}): EvidenceStatus {
  if (entry.source === 'order') {
    return 'system_record';
  }

  return (entry.receipts?.length ?? 0) > 0 ? 'attached' : 'missing';
}
