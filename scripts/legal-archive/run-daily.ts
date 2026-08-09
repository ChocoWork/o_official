import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { buildArchiveCsv } from '../../src/lib/legal-archive/csv';
import { buildManifest, serializeManifest } from '../../src/lib/legal-archive/manifest';
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
    let manifestPath = `${finalPrefix}/manifest.json`;
    const stored = await storeArchiveAtomically({
      artifacts, targets, finalPrefix, runId, immutable: true,
      buildManifest: (storageTargets) => new TextEncoder().encode(serializeManifest(buildManifest({
        fiscalYear: year,
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
