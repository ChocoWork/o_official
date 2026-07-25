import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { isValidStorageKey, seasonMonthKeys, currentSeasonKey } from '@/lib/kpi/monthly-metrics';

type MonthlyRecordRow = {
  month_key: string;
  metric_key: string;
  value: number;
};

type SupabaseLikeError = {
  code?: string;
  message?: string;
};

const TABLE_MISSING_DETAIL =
  'migrations/063_create_admin_kpi_monthly_records.sql をSupabaseダッシュボード > SQL Editor で実行してください。';

const updateRequestSchema = z.object({
  season: z.string().regex(/^\d{4}(SS|AW)$/),
  updates: z.array(
    z.object({
      monthKey: z.string().regex(/^\d{4}-\d{2}$/),
      metricKey: z.string().min(1),
      // 空文字は削除（未入力に戻す）、数値は upsert。
      value: z.union([z.number().finite(), z.literal('')]),
    }),
  ),
});

async function authorizeAsAdmin(request: Request) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return { ok: false as const, response: authz.response };
  }

  if (authz.role !== 'admin') {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { ok: true as const };
}

// season の6ヶ月分の値を { monthKey: { metricKey: value } } で返す。
async function getRecordPayload(season: string) {
  const monthKeys = seasonMonthKeys(season);
  const values: Record<string, Record<string, number>> = {};
  for (const monthKey of monthKeys) {
    values[monthKey] = {};
  }

  const supabase = await createServiceRoleClient();
  const { data, error } = await supabase
    .from('admin_kpi_monthly_records')
    .select('month_key, metric_key, value')
    .in('month_key', monthKeys);

  if (error) {
    const typedError = error as SupabaseLikeError;
    if (typedError.code === '42P01' || typedError.message?.includes('admin_kpi_monthly_records')) {
      console.warn('admin_kpi_monthly_records table not found, returning empty values:', typedError);
      return { season, monthKeys, values };
    }
    console.warn('Error fetching monthly records, using empty values:', error);
    return { season, monthKeys, values };
  }

  for (const row of (data ?? []) as MonthlyRecordRow[]) {
    if (values[row.month_key] && isValidStorageKey(row.metric_key)) {
      values[row.month_key][row.metric_key] = Number(row.value);
    }
  }

  return { season, monthKeys, values };
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAsAdmin(request);
    if (!authz.ok) {
      return authz.response;
    }

    const url = new URL(request.url);
    const requestedSeason = url.searchParams.get('season');
    const season = requestedSeason && seasonMonthKeys(requestedSeason).length > 0 ? requestedSeason : currentSeasonKey();

    const data = await getRecordPayload(season);
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/kpi/monthly-record error:', error);
    const season = currentSeasonKey();
    return NextResponse.json({ data: { season, monthKeys: seasonMonthKeys(season), values: {} } }, { status: 200 });
  }
}

export async function PUT(request: Request) {
  try {
    const authz = await authorizeAsAdmin(request);
    if (!authz.ok) {
      return authz.response;
    }

    let requestBody;
    try {
      requestBody = await request.json();
    } catch (parseError) {
      console.error('Failed to parse request body:', parseError);
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
    }

    const parsed = updateRequestSchema.safeParse(requestBody);
    if (!parsed.success) {
      console.error('Schema validation failed:', parsed.error.issues);
      return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });
    }

    const { season } = parsed.data;
    const allowedMonths = new Set(seasonMonthKeys(season));
    // シーズン内の月・既知の metric_key のみ受け付ける。
    const safeUpdates = parsed.data.updates.filter(
      (update) => allowedMonths.has(update.monthKey) && isValidStorageKey(update.metricKey),
    );

    const deleteTargets = safeUpdates.filter((update) => update.value === '');
    const upsertRows = safeUpdates
      .filter((update): update is { monthKey: string; metricKey: string; value: number } => typeof update.value === 'number')
      .map((update) => ({ month_key: update.monthKey, metric_key: update.metricKey, value: update.value }));

    const supabase = await createServiceRoleClient();

    for (const target of deleteTargets) {
      const { error } = await supabase
        .from('admin_kpi_monthly_records')
        .delete()
        .eq('month_key', target.monthKey)
        .eq('metric_key', target.metricKey);

      if (error) {
        const typedError = error as SupabaseLikeError;
        if (typedError.code === '42P01') {
          return NextResponse.json({ error: '月次記録テーブルが未作成です', details: TABLE_MISSING_DETAIL }, { status: 503 });
        }
        throw new Error(typedError.message || JSON.stringify(error));
      }
    }

    if (upsertRows.length > 0) {
      const { error } = await supabase
        .from('admin_kpi_monthly_records')
        .upsert(upsertRows, { onConflict: 'month_key,metric_key' });

      if (error) {
        const typedError = error as SupabaseLikeError;
        if (typedError.code === '42P01') {
          return NextResponse.json({ error: '月次記録テーブルが未作成です', details: TABLE_MISSING_DETAIL }, { status: 503 });
        }
        throw new Error(typedError.message || JSON.stringify(error));
      }
    }

    const data = await getRecordPayload(season);
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    console.error('PUT /api/admin/kpi/monthly-record error:', errorMessage);
    return NextResponse.json({ error: 'Failed to update monthly record', details: errorMessage }, { status: 500 });
  }
}
