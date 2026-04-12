import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getPublishedItemsPage, ItemSort } from '@/lib/items/public';
import { parseItemCollectionMeta } from '@/lib/items/collection-utils';

const sortSchema = z.enum(['newest', 'price_asc', 'price_desc', 'popular']);

// GET: 商品一覧取得（公開済みのみ、フィルタ/ソート/ページング対応）
export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);

    const category = searchParams.get('category') ?? undefined;
    const size = searchParams.get('size') ?? undefined;
    const color = searchParams.get('color') ?? undefined;
    const collection = searchParams.get('collection') ?? undefined;
    const collectionSeasons = searchParams.get('collectionSeasons');

    const parsedPage = z.coerce.number().int().positive().safeParse(searchParams.get('page'));
    const parsedPageSize = z.coerce.number().int().positive().max(60).safeParse(searchParams.get('pageSize'));
    const parsedLimit = z.coerce.number().int().positive().max(60).safeParse(searchParams.get('limit'));
    const parsedPriceMin = z.coerce.number().int().nonnegative().safeParse(searchParams.get('priceMin'));
    const parsedPriceMax = z.coerce.number().int().nonnegative().safeParse(searchParams.get('priceMax'));
    const parsedCollectionYearMin = z.coerce.number().int().nonnegative().safeParse(searchParams.get('collectionYearMin'));
    const parsedCollectionYearMax = z.coerce.number().int().nonnegative().safeParse(searchParams.get('collectionYearMax'));
    const parsedSort = sortSchema.safeParse(searchParams.get('sort'));

    const selectedSeasons = (collectionSeasons ?? '')
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

    return NextResponse.json(
      {
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
      },
      {
        headers: {
          'x-response-time-ms': String(responseTimeMs),
        },
      },
    );
  } catch (error) {
    console.error('Server Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}