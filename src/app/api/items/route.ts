import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPublishedItemsPage, ItemSort } from '@/lib/items/public';
import { parseItemCollectionMeta } from '@/lib/items/collection-utils';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';

const sortSchema = z.enum(['newest', 'price_asc', 'price_desc', 'popular']);

// 許可文字: 英数字、ハイフン、アンダースコア、スペース、日本語（カテゴリ名等に対応）
const SAFE_STRING_REGEX = /^[\w\- ぁ-んァ-ン一-龥々ー]*$/u;
const ITEMS_LIST_CACHE_TTL_MS = 30_000;

const itemsListResponseCache = new Map<string, { expiresAtMs: number; body: Record<string, unknown> }>();

const stringFilterSchema = z.object({
  // category は DB enum に対応した値のみ許可（'ALL' はフロント正規化用として許容）
  category: z
    .enum(['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES', 'ALL'])
    .optional(),
  size: z.string().max(50).regex(SAFE_STRING_REGEX).optional(),
  color: z.string().max(50).regex(SAFE_STRING_REGEX).optional(),
  collection: z.string().max(100).regex(SAFE_STRING_REGEX).optional(),
  // collectionSeasons はカンマ区切り文字列として受け取り、形式のみ検証（AW/SS への絞り込みは後段で実施）
  collectionSeasons: z
    .string()
    .max(20)
    .regex(/^[A-Za-z,]*$/)
    .optional(),
});

function parseOptionalIntParam(
  searchParams: URLSearchParams,
  key: string,
  schema: z.ZodType<number>,
): { success: true; data: number } | { success: false } {
  const rawValue = searchParams.get(key);
  if (rawValue === null || rawValue.trim().length === 0) {
    return { success: false };
  }

  const parsed = schema.safeParse(rawValue);
  if (!parsed.success) {
    return { success: false };
  }

  return { success: true, data: parsed.data };
}

// GET: 商品一覧取得（公開済みのみ、フィルタ/ソート/ページング対応）
export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const rateLimited = await enforceRateLimit({
      request,
      endpoint: 'items:list',
      limit: 120,
      windowSeconds: 60,
    });

    if (rateLimited) {
      await logAudit({
        action: 'items.list',
        outcome: 'rate_limited',
        detail: 'Rate limit exceeded for items list endpoint',
        ip:
          (request.headers as Headers).get('x-forwarded-for')?.split(',')[0]?.trim() ??
          (request.headers as Headers).get('x-real-ip') ??
          null,
        user_agent: (request.headers as Headers).get('user-agent'),
      });
      return rateLimited;
    }

    const { searchParams } = new URL(request.url);

    // 文字列パラメータを Zod で一括検証し、不正入力は 400 で拒否
    const parsedStringFilters = stringFilterSchema.safeParse({
      category: searchParams.get('category') ?? undefined,
      size: searchParams.get('size') ?? undefined,
      color: searchParams.get('color') ?? undefined,
      collection: searchParams.get('collection') ?? undefined,
      collectionSeasons: searchParams.get('collectionSeasons') ?? undefined,
    });

    if (!parsedStringFilters.success) {
      return NextResponse.json(
        { error: 'Invalid filter parameter', details: parsedStringFilters.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const {
      category: rawCategory,
      size,
      color,
      collection,
      collectionSeasons: collectionSeasonsRaw,
    } = parsedStringFilters.data;

    // 'ALL' はフロントの全カテゴリ選択用エイリアスなので undefined に正規化
    const category = rawCategory === 'ALL' ? undefined : rawCategory;

    const parsedPage = parseOptionalIntParam(searchParams, 'page', z.coerce.number().int().positive());
    const parsedPageSize = parseOptionalIntParam(searchParams, 'pageSize', z.coerce.number().int().positive().max(60));
    const parsedLimit = parseOptionalIntParam(searchParams, 'limit', z.coerce.number().int().positive().max(60));
    const parsedPriceMin = parseOptionalIntParam(searchParams, 'priceMin', z.coerce.number().int().nonnegative());
    const parsedPriceMax = parseOptionalIntParam(searchParams, 'priceMax', z.coerce.number().int().nonnegative());
    const parsedCollectionYearMin = parseOptionalIntParam(searchParams, 'collectionYearMin', z.coerce.number().int().nonnegative());
    const parsedCollectionYearMax = parseOptionalIntParam(searchParams, 'collectionYearMax', z.coerce.number().int().nonnegative());
    const parsedSort = sortSchema.safeParse(searchParams.get('sort'));

    const selectedSeasons = (collectionSeasonsRaw ?? '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter((value): value is 'AW' | 'SS' => value === 'AW' || value === 'SS');

    const page = parsedPage.success ? parsedPage.data : 1;
    const pageSize = parsedPageSize.success
      ? parsedPageSize.data
      : parsedLimit.success
        ? parsedLimit.data
        : 12;
    const sort: ItemSort = parsedSort.success ? parsedSort.data : 'newest';

    const cacheKey = JSON.stringify({
      category: category ?? null,
      size: size ?? null,
      color: color ?? null,
      collection: collection ?? null,
      collectionSeasons: selectedSeasons,
      collectionYearMin: parsedCollectionYearMin.success ? parsedCollectionYearMin.data : null,
      collectionYearMax: parsedCollectionYearMax.success ? parsedCollectionYearMax.data : null,
      priceMin: parsedPriceMin.success ? parsedPriceMin.data : null,
      priceMax: parsedPriceMax.success ? parsedPriceMax.data : null,
      page,
      pageSize,
      sort,
    });

    const cachedResponse = itemsListResponseCache.get(cacheKey);
    if (cachedResponse && cachedResponse.expiresAtMs > Date.now()) {
      return NextResponse.json(cachedResponse.body, {
        headers: {
          'x-response-time-ms': String(Date.now() - startedAt),
        },
      });
    }

    const result = await getPublishedItemsPage({
      category,
      size,
      priceMin: parsedPriceMin.success ? parsedPriceMin.data : undefined,
      priceMax: parsedPriceMax.success ? parsedPriceMax.data : undefined,
      sort,
      page,
      pageSize,
    });

    // 컬렉션/カラーは現行データ構造差異に備えてAPI層で後段フィルタ
    const filteredItems = result.items.filter((item) => {
      const collectionOk =
        !collection ||
        (typeof item.product_details === 'object' &&
          item.product_details !== null &&
          'collection' in item.product_details &&
          String((item.product_details as Record<string, unknown>).collection).toLowerCase() ===
            collection.toLowerCase());

      const colorOk =
        !color ||
        (Array.isArray(item.colors) &&
          item.colors.some((entry) => {
            if (typeof entry === 'string') {
              return entry.toLowerCase() === color.toLowerCase();
            }
            return entry && typeof entry === 'object' && 'name' in entry
              ? String((entry as { name: string }).name).toLowerCase() === color.toLowerCase()
              : false;
          }));

      const collectionMeta = parseItemCollectionMeta(item);
      const collectionYearMinOk =
        !parsedCollectionYearMin.success ||
        (typeof collectionMeta.year === 'number' && collectionMeta.year >= parsedCollectionYearMin.data);
      const collectionYearMaxOk =
        !parsedCollectionYearMax.success ||
        (typeof collectionMeta.year === 'number' && collectionMeta.year <= parsedCollectionYearMax.data);
      const collectionSeasonOk =
        selectedSeasons.length === 0 ||
        (collectionMeta.season !== null && selectedSeasons.includes(collectionMeta.season));

      return collectionOk && colorOk && collectionYearMinOk && collectionYearMaxOk && collectionSeasonOk;
    });

    const responseTimeMs = Date.now() - startedAt;

    const responseBody = {
      items: filteredItems,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      hasMore: result.hasMore,
      sort,
      filters: {
        category: category ?? null,
        collection: collection ?? null,
        size: size ?? null,
        color: color ?? null,
        collectionYearMin: parsedCollectionYearMin.success ? parsedCollectionYearMin.data : null,
        collectionYearMax: parsedCollectionYearMax.success ? parsedCollectionYearMax.data : null,
        collectionSeasons: selectedSeasons.length > 0 ? selectedSeasons : null,
        priceMin: parsedPriceMin.success ? parsedPriceMin.data : null,
        priceMax: parsedPriceMax.success ? parsedPriceMax.data : null,
      },
    } satisfies Record<string, unknown>;

    itemsListResponseCache.set(cacheKey, {
      expiresAtMs: Date.now() + ITEMS_LIST_CACHE_TTL_MS,
      body: responseBody,
    });

    return NextResponse.json(responseBody, {
      headers: {
        'x-response-time-ms': String(responseTimeMs),
      },
    });
  } catch (error) {
    console.error('Server Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}