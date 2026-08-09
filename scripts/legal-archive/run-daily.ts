import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { buildArchiveCsv } from '../../src/lib/legal-archive/csv';
import { buildManifest, serializeManifest, sha256 } from '../../src/lib/legal-archive/manifest';
import { createS3ArchiveStorageFromEnv } from '../../src/lib/legal-archive/s3-storage';
import { storeArchiveAtomically, type ArchiveStorage } from '../../src/lib/legal-archive/storage';
import { SupabaseArchiveStorage } from '../../src/lib/legal-archive/supabase-storage';
import type { LegalArchivePage } from '../../src/lib/legal-archive/types';

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function jstParts(now: Date): { date: string; year: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  return { date, year: Number(value('year')) };
}

async function postStatus(baseUrl: string, secret: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/cron/legal-archive/status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Failed to update legal archive status');
}

const ANNUAL_ARTIFACTS = [
  'orders.csv', 'order_items.csv', 'order_revisions.csv', 'database.dump.gz', 'manifest.json',
] as const;

export async function finalizeAnnualArchive(input: {
  targets: ArchiveStorage[];
  year: number;
  runId: string;
}) {
  const sourcePrefix = `legal-archive/${input.year}/daily/${input.year}-12-31`;
  const finalPrefix = `legal-archive/${input.year}/annual/final`;
  const stagingPrefix = `_staging/${input.runId}-annual`;
  try {
    for (const target of input.targets) {
      for (const name of ANNUAL_ARTIFACTS) {
        const finalKey = `${finalPrefix}/${name}`;
        if (await target.exists(finalKey)) throw new Error(`Annual archive already exists: ${target.name}`);
        const body = await target.read(`${sourcePrefix}/${name}`);
        const temporaryKey = `${stagingPrefix}/${name}`;
        await target.putTemporary(temporaryKey, body, name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/octet-stream');
        if (sha256(await target.read(temporaryKey)) !== sha256(body)) throw new Error('Annual archive verification failed');
      }
    }
    for (const target of input.targets) {
      for (const name of ANNUAL_ARTIFACTS) {
        await target.promote(`${stagingPrefix}/${name}`, `${finalPrefix}/${name}`, true);
      }
    }
    return { manifestPath: `${finalPrefix}/manifest.json` };
  } finally {
    await Promise.allSettled(input.targets.map((target) => target.removeTemporary(stagingPrefix)));
  }
}

export async function runDailyArchive(input: {
  environment?: Environment;
  now?: Date;
  fetchPage?: (year: number, cursor: string | null) => Promise<LegalArchivePage>;
  targets?: ArchiveStorage[];
  databaseDump?: Uint8Array;
  updateStatus?: (body: Record<string, unknown>) => Promise<void>;
}) {
  const environment = input.environment ?? process.env;
  const baseUrl = required(environment, 'APP_BASE_URL').replace(/\/$/, '');
  const secret = required(environment, 'LEGAL_ARCHIVE_CRON_SECRET');
  const dumpPath = input.databaseDump ? null : required(environment, 'LEGAL_ARCHIVE_DATABASE_DUMP');
  const { date, year } = jstParts(input.now ?? new Date());
  const runId = randomUUID();
  const fetchPage = input.fetchPage ?? (async (archiveYear, cursor) => {
    const query = new URLSearchParams({ year: String(archiveYear) });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`${baseUrl}/api/cron/legal-archive/export?${query}`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!response.ok) throw new Error('Legal archive export failed');
    return response.json() as Promise<LegalArchivePage>;
  });
  const targets = input.targets ?? (() => {
    const client = createClient(
      required(environment, 'NEXT_PUBLIC_SUPABASE_URL'),
      required(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const configured: ArchiveStorage[] = [new SupabaseArchiveStorage(client)];
    const external = createS3ArchiveStorageFromEnv(environment);
    if (external) configured.push(external);
    return configured;
  })();

  const updateStatus = input.updateStatus ?? ((body: Record<string, unknown>) =>
    postStatus(baseUrl, secret, body));
  await updateStatus({
    archiveDate: date, fiscalYear: year, runKind: 'daily', status: 'running',
    storageTargets: targets.map((target) => target.name),
  });

  try {
    const pages: LegalArchivePage[] = [];
    let cursor: string | null = null;
    do {
      const page = await fetchPage(year, cursor);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    const snapshot = buildArchiveCsv(pages);
    const artifacts = {
      'orders.csv': new TextEncoder().encode(snapshot.ordersCsv),
      'order_items.csv': new TextEncoder().encode(snapshot.itemsCsv),
      'order_revisions.csv': new TextEncoder().encode(snapshot.revisionsCsv),
      'database.dump.gz': input.databaseDump ?? new Uint8Array(await readFile(dumpPath!)),
    };
    const finalPrefix = `legal-archive/${year}/daily/${date}`;
    const configuredRetention = Number(environment[`LEGAL_ARCHIVE_RETENTION_YEARS_${year}`] ?? 7);
    const retentionYears = configuredRetention === 10 ? 10 : 7;
    let manifestPath = `${finalPrefix}/manifest.json`;
    const stored = await storeArchiveAtomically({
      artifacts, targets, finalPrefix, runId, immutable: true,
      buildManifest: (storageTargets) => new TextEncoder().encode(serializeManifest(buildManifest({
        fiscalYear: year,
        retentionYears,
        generatedAt: (input.now ?? new Date()).toISOString(),
        gitCommit: environment.GITHUB_SHA ?? 'local',
        previousManifestSha256: environment.LEGAL_ARCHIVE_PREVIOUS_MANIFEST_SHA256 ?? null,
        artifacts,
        rowCounts: snapshot.rowCounts,
        totals: snapshot.totals,
        storageTargets,
      }))),
    });
    await updateStatus({
      archiveDate: date, fiscalYear: year, runKind: 'daily', status: 'completed',
      storageTargets: targets.map((target) => target.name),
      manifestPath, manifestSha256: stored.manifestSha256,
    });
    if (date.endsWith('-01-02')) {
      const annualYear = year - 1;
      await updateStatus({
        archiveDate: date, fiscalYear: annualYear, runKind: 'annual', status: 'running',
        storageTargets: targets.map((target) => target.name),
      });
      const annual = await finalizeAnnualArchive({ targets, year: annualYear, runId });
      const annualManifest = await targets[0].read(annual.manifestPath);
      await updateStatus({
        archiveDate: date, fiscalYear: annualYear, runKind: 'annual', status: 'completed',
        storageTargets: targets.map((target) => target.name),
        manifestPath: annual.manifestPath, manifestSha256: sha256(annualManifest),
      });
    }
    return { date, year, manifestPath, ...stored };
  } catch (error) {
    await updateStatus({
      archiveDate: date, fiscalYear: year, runKind: 'daily', status: 'failed',
      storageTargets: targets.map((target) => target.name), errorCode: 'ARCHIVE_RUN_FAILED',
    }).catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  runDailyArchive({}).catch(() => {
    console.error('Legal archive daily run failed');
    process.exitCode = 1;
  });
}
