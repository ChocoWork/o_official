/**
 * 横断検索の窓口（src/app/api/search/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-SEARCH-121
 * @design DD-SEARCH-004
 * @remarks 窓口は外から来る値が取り出しの関数へ渡る境目なので、取り出しの前に引数の形を確かめ、
 * 外れたら 400 で断る。語の決まりは候補の窓口と同じ物を使う（SEC-SEARCH-004）。
 * 外のサイトの頁から読み込まれた要求は検査・回数の制限より前に 403 にし、断った要求は枠に数えない（SEC-SEARCH-020）。
 * 1回の検索で3つの DB の関数・人気商品・画像の署名を呼ぶため、
 * 取り出しの前に送り元ごとの回数の制限を通し、プレビューは別の枠と少ない件数で数える。
 * 検索語に紐づく応答を共有のキャッシュに残さないよう、全ての応答を private, no-store にする（SEC-SEARCH-010）。
 * 処理時間の見出しは内部の負荷を外へ見せるので付けない（SEC-SEARCH-019）。
 * 3つの検索関数のどれかが失敗したら、見つからない結果と区別がつくよう全体を 500 にする（SEC-SEARCH-017）。
 * 例外の中身（接続先や SQL の断片）を応答にも記録にも出さず、固定の文と名前・符号だけを返す（SEC-SEARCH-018）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { rejectCrossSiteFetch } from '@/features/search/lib/cross-site';
import { searchQuerySchema } from '@/features/search/lib/query-schema';
import { executeSearch } from '@/features/search/services/search.service';
import type { SearchTab } from '@/features/search/types/search.types';
import { withNoStore } from '@/lib/http/no-store';
import { describeErrorForLog } from '@/lib/logging/safe-error';

const searchSchema = z.object({
  q: searchQuerySchema(),
  tab: z.enum(['all', 'item', 'look', 'news']).optional().default('all'),
  // z.coerce.boolean() は Boolean(value) なので 'false' も true になる。
  // preview 未指定時に 'false' を渡すと常に preview 扱いとなり、レート上限が
  // search:public(120) ではなく search:preview(20)、件数も 8 ではなく 3 に
  // 落ちてしまうため、明示的に 'true' のときだけ true とする。
  preview: z.string().optional().default('false').transform((value) => value === 'true'),
});

async function handleSearch(request: NextRequest): Promise<Response> {
  const crossSite = rejectCrossSiteFetch(request);
  if (crossSite) {
    return crossSite;
  }

  try {
    const parsed = searchSchema.safeParse({
      q: request.nextUrl.searchParams.get('q') ?? '',
      tab: request.nextUrl.searchParams.get('tab') ?? 'all',
      preview: request.nextUrl.searchParams.get('preview') ?? 'false',
    });

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid search query' }, { status: 400 });
    }

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitResponse = await enforceRateLimit({
      request,
      endpoint: parsed.data.preview ? 'search:preview' : 'search:public',
      limit: parsed.data.preview ? 20 : 120,
      windowSeconds: 600,
    });

    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const result = await executeSearch({
      query: parsed.data.q,
      tab: parsed.data.tab as SearchTab,
      limitPerType: parsed.data.preview ? 3 : 8,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('GET /api/search error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Failed to search content' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return withNoStore(await handleSearch(request));
}
