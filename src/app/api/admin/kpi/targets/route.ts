import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

type KpiPriority = '◎' | '○' | '△';

type KpiDefinition = {
  key: string;
  label: string;
  definition: string;
  priority: KpiPriority;
};

type KpiTargetRow = {
  season_key: string;
  kpi_key: string;
  target_value: string;
};

type SupabaseLikeError = {
  code?: string;
  message?: string;
};

const KPI_DEFINITIONS: KpiDefinition[] = [
  { key: 'reach', label: 'リーチ数', definition: '投稿・広告での到達人数', priority: '◎' },
  { key: 'save_rate', label: '保存率', definition: '保存 ÷ リーチ', priority: '◎' },
  { key: 'profile_transition_rate', label: 'プロフ遷移率', definition: 'プロフクリック ÷ リーチ', priority: '◎' },
  { key: 'story_views', label: 'ストーリー視聴数', definition: 'ストーリー閲覧人数', priority: '◎' },
  { key: 'story_reach_rate', label: 'ストーリー到達率', definition: 'ストーリー閲覧 ÷ プロフ遷移', priority: '○' },
  { key: 'link_click_rate', label: 'リンククリック率', definition: 'リンククリック ÷ 視聴', priority: '◎' },
  { key: 'cvr', label: 'CVR', definition: '購入 ÷ 訪問', priority: '◎' },
  { key: 'aov', label: '客単価（AOV）', definition: '売上 ÷ 注文数', priority: '◎' },
  { key: 'set_purchase_rate', label: 'セット購入率', definition: 'セット購入 ÷ 全購入', priority: '◎' },
  { key: 'sales', label: '売上', definition: '総売上', priority: '◎' },
  { key: 'inventory_turnover', label: '在庫消化率', definition: '販売 ÷ 在庫', priority: '◎' },
  { key: 'cpa', label: 'CPA', definition: '顧客獲得単価', priority: '◎' },
  { key: 'roas', label: 'ROAS', definition: '売上 ÷ 広告費', priority: '◎' },
  { key: 'cpc', label: 'CPC', definition: 'クリック単価', priority: '○' },
  { key: 'cpm', label: 'CPM', definition: '表示単価', priority: '○' },
  { key: 'ltv', label: 'LTV', definition: '顧客生涯価値', priority: '△' },
  { key: 'repeat_rate', label: 'リピート率', definition: '再購入率', priority: '△' },
  { key: 'return_rate', label: '返品率', definition: '返品 ÷ 購入', priority: '○' },
  { key: 'dropoff_rate', label: '離脱率', definition: 'LP離脱率', priority: '○' },
];

const DEFAULT_TARGETS: Record<string, Partial<Record<string, string>>> = {
  '2026SS': {
    reach: '3,000〜6,000',
    save_rate: '12〜15%',
    profile_transition_rate: '15〜25%',
    story_views: '150〜250',
    story_reach_rate: '70〜90%',
    link_click_rate: '20〜35%',
    cvr: '12〜15%',
    aov: '59,600円',
    set_purchase_rate: '80%以上',
    sales: '約130万円',
    inventory_turnover: '100%',
    cpa: '不要',
    roas: '不要',
    cpc: '不要',
    cpm: '不要',
    ltv: '未設定',
    repeat_rate: 'なし',
    return_rate: '5%以下',
    dropoff_rate: '50%以下',
  },
  '2026AW': {
    reach: '50,000〜120,000',
    save_rate: '8〜12%',
    profile_transition_rate: '10〜18%',
    story_views: '2,000〜4,000',
    story_reach_rate: '60〜80%',
    link_click_rate: '15〜25%',
    cvr: '5〜8%',
    aov: '62,000円',
    set_purchase_rate: '70〜85%',
    sales: '600万〜1,000万円',
    inventory_turnover: '95〜100%',
    cpa: '3,000〜8,000円',
    roas: '300〜500%',
    cpc: '50〜120円',
    cpm: '500〜1,200円',
    ltv: '80,000〜150,000円',
    repeat_rate: '20〜30%',
    return_rate: '5%以下',
    dropoff_rate: '40〜55%',
  },
};

const updateRequestSchema = z.object({
  updates: z.array(
    z.object({
      season: z.string().regex(/^\d{4}(SS|AW)$/),
      kpiKey: z.string().min(1),
      value: z.string(),
    }),
  ),
});

function getJstYearMonth(dateInput: Date): { year: number; month: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  });

  const parts = formatter.formatToParts(dateInput);
  const year = Number.parseInt(parts.find((part) => part.type === 'year')?.value ?? '1970', 10);
  const month = Number.parseInt(parts.find((part) => part.type === 'month')?.value ?? '1', 10);
  return { year, month };
}

function getSeasonFromDate(dateInput: Date): string {
  const { year, month } = getJstYearMonth(dateInput);
  if (month >= 4 && month <= 9) {
    return `${year}SS`;
  }

  if (month >= 10) {
    return `${year}AW`;
  }

  return `${year - 1}AW`;
}

function parseSeasonKey(season: string): { year: number; type: 'SS' | 'AW' } {
  const matched = season.match(/^(\d{4})(SS|AW)$/);
  if (!matched) {
    return { year: 1970, type: 'SS' };
  }

  return {
    year: Number.parseInt(matched[1], 10),
    type: matched[2] as 'SS' | 'AW',
  };
}

function getPrevSeasonKey(season: string): string {
  const parsed = parseSeasonKey(season);
  if (parsed.type === 'SS') {
    return `${parsed.year - 1}AW`;
  }
  return `${parsed.year}SS`;
}

function getNextSeasonKey(season: string): string {
  const parsed = parseSeasonKey(season);
  if (parsed.type === 'SS') {
    return `${parsed.year}AW`;
  }
  return `${parsed.year + 1}SS`;
}

function buildEditableSeasons(currentSeason: string): string[] {
  const seasons: string[] = [currentSeason];

  let prevCursor = currentSeason;
  for (let index = 0; index < 3; index += 1) {
    prevCursor = getPrevSeasonKey(prevCursor);
    seasons.unshift(prevCursor);
  }

  let nextCursor = currentSeason;
  for (let index = 0; index < 2; index += 1) {
    nextCursor = getNextSeasonKey(nextCursor);
    seasons.push(nextCursor);
  }

  return seasons;
}

function buildValuesMatrix(seasons: string[], rows: KpiTargetRow[]): Record<string, Record<string, string>> {
  const values: Record<string, Record<string, string>> = {};

  for (const definition of KPI_DEFINITIONS) {
    values[definition.key] = {};

    for (const season of seasons) {
      const defaultValue = DEFAULT_TARGETS[season]?.[definition.key] ?? '';
      values[definition.key][season] = defaultValue;
    }
  }

  for (const row of rows) {
    if (!(row.kpi_key in values)) {
      continue;
    }

    if (!seasons.includes(row.season_key)) {
      continue;
    }

    values[row.kpi_key][row.season_key] = row.target_value;
  }

  return values;
}

function buildDefaultTargetPayload(currentSeason: string) {
  const seasons = buildEditableSeasons(currentSeason);
  return {
    currentSeason,
    seasons,
    definitions: KPI_DEFINITIONS,
    values: buildValuesMatrix(seasons, []),
  };
}

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

async function getTargetPayload() {
  const supabase = await createServiceRoleClient();
  const currentSeason = getSeasonFromDate(new Date());
  const seasons = buildEditableSeasons(currentSeason);

  const { data, error } = await supabase
    .from('admin_kpi_targets')
    .select('season_key, kpi_key, target_value')
    .in('season_key', seasons);

  if (error) {
    const typedError = error as SupabaseLikeError;

    // Table might not exist yet - return defaults
    if (typedError.code === '42P01' || typedError.message?.includes('admin_kpi_targets')) {
      console.warn('admin_kpi_targets table not found, returning defaults:', typedError);
      return buildDefaultTargetPayload(currentSeason);
    }

    // Other errors - still return defaults to keep UI functional
    console.warn('Error fetching KPI targets, using defaults:', error);
    return buildDefaultTargetPayload(currentSeason);
  }

  const rows = (data ?? []) as KpiTargetRow[];
  return {
    currentSeason,
    seasons,
    definitions: KPI_DEFINITIONS,
    values: buildValuesMatrix(seasons, rows),
  };
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAsAdmin(request);
    if (!authz.ok) {
      return authz.response;
    }

    const data = await getTargetPayload();
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/kpi/targets error:', error);
    const currentSeason = getSeasonFromDate(new Date());
    return NextResponse.json({ data: buildDefaultTargetPayload(currentSeason) }, { status: 200 });
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
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const validKpiKeys = new Set(KPI_DEFINITIONS.map((item) => item.key));
    const safeUpdates = parsed.data.updates.filter((update) => validKpiKeys.has(update.kpiKey));

    const deleteTargets = safeUpdates.filter((update) => update.value.trim() === '');
    const upsertTargets = safeUpdates
      .filter((update) => update.value.trim() !== '')
      .map((update) => ({
        season_key: update.season,
        kpi_key: update.kpiKey,
        target_value: update.value.trim(),
      }));

    const supabase = await createServiceRoleClient();

    for (const target of deleteTargets) {
      const { error } = await supabase
        .from('admin_kpi_targets')
        .delete()
        .eq('season_key', target.season)
        .eq('kpi_key', target.kpiKey);

      if (error) {
        const typedError = error as SupabaseLikeError;
        console.error('Delete error details:', {
          code: typedError.code,
          message: typedError.message,
          error: JSON.stringify(error),
        });

        if (typedError.code === '42P01') {
          return NextResponse.json(
            {
              error: 'KPI目標テーブルが未作成です',
              details: 'migrations/026_create_admin_kpi_targets.sql をSupabaseダッシュボード > SQL Editor で実行してください。',
            },
            { status: 503 },
          );
        }

        // Convert error to string for safe throwing
        const errorStr = typedError.message || JSON.stringify(error);
        console.error('Delete operation failed, throwing error:', errorStr);
        throw new Error(`Delete operation failed: ${errorStr}`);
      }
    }

    if (upsertTargets.length > 0) {
      console.log('Upserting targets:', upsertTargets);
      const { error } = await supabase
        .from('admin_kpi_targets')
        .upsert(upsertTargets, { onConflict: 'season_key,kpi_key' });

      if (error) {
        const typedError = error as SupabaseLikeError;
        console.error('Upsert error details:', {
          code: typedError.code,
          message: typedError.message,
          error: JSON.stringify(error),
        });

        if (typedError.code === '42P01') {
          return NextResponse.json(
            {
              error: 'KPI目標テーブルが未作成です',
              details: 'migrations/026_create_admin_kpi_targets.sql をSupabaseダッシュボード > SQL Editor で実行してください。',
            },
            { status: 503 },
          );
        }

        // Convert error to string for safe throwing
        const errorStr = typedError.message || JSON.stringify(error);
        console.error('Upsert operation failed, throwing error:', errorStr);
        throw new Error(`Upsert operation failed: ${errorStr}`);
      }
    }

    const data = await getTargetPayload();
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    // Safely convert error to string
    let errorMessage = 'Failed to update KPI targets';
    
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      // Try to extract message from error object
      const errorObj = error as Record<string, unknown>;
      if (typeof errorObj.message === 'string') {
        errorMessage = errorObj.message;
      } else {
        errorMessage = JSON.stringify(error);
      }
    }
    
    console.error('PUT /api/admin/kpi/targets error:', {
      errorType: error instanceof Error ? 'Error' : typeof error,
      errorMessage,
      fullError: error,
    });
    
    return NextResponse.json(
      { error: 'Failed to update KPI targets', details: errorMessage },
      { status: 500 },
    );
  }
}
