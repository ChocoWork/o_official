/**
 * 検索候補の窓口（src/app/api/suggest/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-SEARCH-122
 * @design DD-SEARCH-005
 * @remarks 候補は入力のたびに呼ばれるので、取り出しの前に送り元ごとの回数の制限を通す。
 * 制御文字を含む語は検索の窓口と同じ決まりで DB の関数へ渡す前に断ち、不正な値を DB に届けない（SEC-SEARCH-004）。
 * 外のサイトの頁から読み込まれた要求は検査・回数の制限より前に 403 にし、断った要求は枠に数えない（SEC-SEARCH-020）。
 * 入力した語に紐づく応答を共有のキャッシュに残さないよう、全ての応答を private, no-store にする（SEC-SEARCH-010）。
 * 例外の中身（接続先や SQL の断片）を応答にも記録にも出さず、固定の文と名前・符号だけを返す（SEC-SEARCH-018）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { rejectCrossSiteFetch } from '@/features/search/lib/cross-site';
import { searchQuerySchema } from '@/features/search/lib/query-schema';
import { getSearchSuggestions } from '@/features/search/services/search.service';
import { withNoStore } from '@/lib/http/no-store';
import { describeErrorForLog } from '@/lib/logging/safe-error';

const suggestSchema = z.object({
  q: searchQuerySchema(),
});

async function handleSuggest(request: NextRequest): Promise<Response> {
  const crossSite = rejectCrossSiteFetch(request);
  if (crossSite) {
    return crossSite;
  }

  try {
    const parsed = suggestSchema.safeParse({
      q: request.nextUrl.searchParams.get('q') ?? '',
    });

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid suggest query' }, { status: 400 });
    }

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitResponse = await enforceRateLimit({
      request,
      endpoint: 'suggest:public',
      limit: 200,
      windowSeconds: 600,
    });

    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const suggestions = await getSearchSuggestions(parsed.data.q, 8);
    return NextResponse.json({ suggestions }, { status: 200 });
  } catch (error) {
    console.error('GET /api/suggest error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Failed to load suggestions' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return withNoStore(await handleSuggest(request));
}
