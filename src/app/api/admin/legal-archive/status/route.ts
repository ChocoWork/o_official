import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient } from '@/lib/supabase/server';

const schema = z.object({ year: z.coerce.number().int().min(2000).max(9999) });
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const authorization = await authorizeAdminPermission('admin.finance.read', request);
  if (!authorization.ok) return authorization.response;
  const parsed = schema.safeParse({ year: new URL(request.url).searchParams.get('year') });
  if (!parsed.success) return NextResponse.json({ error: 'Invalid query' }, { status: 400, headers: NO_STORE });
  try {
    const client = await createClient(request);
    const latest = async (runKind: 'daily' | 'restore_check') => client
      .from('legal_archive_runs')
      .select('completed_at,storage_targets')
      .eq('fiscal_year', parsed.data.year)
      .eq('run_kind', runKind)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const [dailyResult, restoreResult] = await Promise.all([latest('daily'), latest('restore_check')]);
    if (dailyResult.error || restoreResult.error) throw new Error('status query failed');
    const daily = dailyResult.data;
    const restore = restoreResult.data;
    const lastArchiveAt = daily?.completed_at ?? null;
    const targets: string[] = daily?.storage_targets ?? [];
    const delayed = !lastArchiveAt || Date.now() - new Date(lastArchiveAt).getTime() > 24 * 60 * 60 * 1000;
    return NextResponse.json({ data: {
      fiscalYear: parsed.data.year,
      lastArchiveAt,
      lastRestoreCheckAt: restore?.completed_at ?? null,
      storageTargets: targets,
      externalStorageConfigured: targets.some((target) => target !== 'supabase'),
      delayed,
    } }, { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: 'Archive status unavailable' }, { status: 502, headers: NO_STORE });
  }
}
