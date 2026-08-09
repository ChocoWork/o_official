import { createHash } from 'node:crypto';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export type LegalArchiveManifest = {
  schemaVersion: 1;
  fiscalYear: number;
  retentionYears: number;
  generatedAt: string;
  gitCommit: string;
  previousManifestSha256: string | null;
  files: Record<string, { sha256: string; byteSize: number }>;
  rowCounts: { orders: number; orderItems: number; revisions: number };
  totals: { grossAmount: number; refundedAmount: number; netAmount: number };
  storageTargets: Array<{ name: string; verified: boolean }>;
};

export function buildManifest(input: {
  fiscalYear: number;
  retentionYears?: number;
  generatedAt: string;
  gitCommit: string;
  previousManifestSha256?: string | null;
  artifacts: Record<string, string | Uint8Array>;
  rowCounts: LegalArchiveManifest['rowCounts'];
  totals: LegalArchiveManifest['totals'];
  storageTargets: LegalArchiveManifest['storageTargets'];
}): LegalArchiveManifest {
  const files = Object.fromEntries(
    Object.entries(input.artifacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, body]) => [name, {
        sha256: sha256(body),
        byteSize: typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength,
      }]),
  );
  return {
    schemaVersion: 1,
    fiscalYear: input.fiscalYear,
    retentionYears: input.retentionYears ?? 7,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit,
    previousManifestSha256: input.previousManifestSha256 ?? null,
    files,
    rowCounts: input.rowCounts,
    totals: input.totals,
    storageTargets: [...input.storageTargets].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function serializeManifest(manifest: LegalArchiveManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
