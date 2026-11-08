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

// admin_set_kpi_monthly_records が 1 回で受ける最大件数（DB 側の上限と同じ）。
const MAX_UPDATES_PER_CALL = 200;

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

  return { ok: true as const, userId: authz.userId };
}

// season の6ヶ月分の値を { monthKey: { metricKey: value } } で返す。
async function getRecordPayload(season: string) {
  const monthKeys = seasonMonthKeys(season);
  const values: Record<string, Record<string, number>> = {};
  for (const monthKey of monthKeys) {
    values[monthKey] = {};
  }

  const supabase = await createServiceRoleClient();
  const { data, error } = await supabase.rpc('list_kpi_monthly_records', { _month_keys: monthKeys });

  if (error) {
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

// DB の拒否は意味を保って返す。それ以外は固定の本文にし、DB の文（表の名前など）を応答へ出さない。
function saveFailureResponse(error: SupabaseLikeError) {
  console.error('PUT /api/admin/kpi/monthly-record error:', error.code, error.message);
  if (error.code === '42501') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (error.code === '22023') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  return NextResponse.json({ error: 'Failed to update monthly record' }, { status: 500 });
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

    // 空値は削除（value: null）、数値は upsert。書き込みは DB の関数だけが行う。
    const dbUpdates = safeUpdates.map((update) => ({
      month_key: update.monthKey,
      metric_key: update.metricKey,
      value: update.value === '' ? null : update.value,
    }));

    const supabase = await createServiceRoleClient();

    for (let offset = 0; offset < dbUpdates.length; offset += MAX_UPDATES_PER_CALL) {
      const { error } = await supabase.rpc('admin_set_kpi_monthly_records', {
        _actor_id: authz.userId,
        _updates: dbUpdates.slice(offset, offset + MAX_UPDATES_PER_CALL),
      });

      if (error) {
        return saveFailureResponse(error as SupabaseLikeError);
      }
    }

    const data = await getRecordPayload(season);
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    console.error('PUT /api/admin/kpi/monthly-record error:', errorMessage);
    return NextResponse.json({ error: 'Failed to update monthly record' }, { status: 500 });
  }
}
