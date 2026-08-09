import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeCronBearer } from '@/lib/legal-archive/cron-auth';
import { createServiceRoleClient } from '@/lib/supabase/server';

const bodySchema = z.object({
  archiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fiscalYear: z.number().int().min(2000).max(9999),
  runKind: z.enum(['daily', 'annual', 'restore_check']),
  status: z.enum(['running', 'completed', 'failed']),
  storageTargets: z.array(z.string().min(1).max(100)).max(10),
  manifestPath: z.string().max(1000).optional(),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  errorCode: z.string().max(100).optional(),
}).superRefine((value, context) => {
  if (
    value.status === 'completed' &&
    value.runKind !== 'restore_check' &&
    (!value.manifestPath || !value.manifestSha256)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'completed requires manifest', path: ['status'] });
  }
});

export async function POST(request: Request) {
  if (!authorizeCronBearer(request.headers.get('authorization'), process.env.LEGAL_ARCHIVE_CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  try {
    const client = await createServiceRoleClient();
    const key = parsed.data;
    const { data: existing, error: readError } = await client.from('legal_archive_runs')
      .select('id,status').eq('archive_date', key.archiveDate).eq('run_kind', key.runKind).maybeSingle();
    if (readError) throw readError;
    if (existing?.status === 'completed' && key.status !== 'completed') {
      return NextResponse.json({ error: 'Invalid state transition' }, { status: 409 });
    }
    const record = {
      archive_date: key.archiveDate, fiscal_year: key.fiscalYear, run_kind: key.runKind,
      status: key.status, storage_targets: key.storageTargets,
      manifest_path: key.status === 'completed' ? key.manifestPath : null,
      manifest_sha256: key.status === 'completed' ? key.manifestSha256 : null,
      completed_at: key.status === 'running' ? null : new Date().toISOString(),
      error_code: key.status === 'failed' ? key.errorCode ?? 'UNKNOWN' : null,
    };
    const operation = existing
      ? client.from('legal_archive_runs').update(record).eq('id', existing.id)
      : client.from('legal_archive_runs').insert(record);
    const { error } = await operation;
    if (error) throw error;
    console.info('[legal-archive.status]', {
      runId: existing?.id ?? null, year: key.fiscalYear,
      targets: key.storageTargets, errorCode: record.error_code,
    });
    return NextResponse.json({ ok: true });
  } catch {
    console.error('[legal-archive.status] update failed');
    return NextResponse.json({ error: 'Archive status unavailable' }, { status: 502 });
  }
}
