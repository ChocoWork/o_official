export type EvidenceStatus =
  | 'attached'
  | 'missing'
  | 'system_record'
  | 'unavailable_recorded';

export function resolveEvidenceStatus(entry: {
  source?: 'manual' | 'order';
  receipts?: readonly unknown[];
  evidenceUnavailable?: unknown | null;
}): EvidenceStatus {
  if (entry.source === 'order') {
    return 'system_record';
  }

  if ((entry.receipts?.length ?? 0) > 0) {
    return 'attached';
  }

  return entry.evidenceUnavailable ? 'unavailable_recorded' : 'missing';
}
