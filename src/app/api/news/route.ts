/**
 * 公開済みのニュースを JSON で返す窓口 /api/news（src/app/api/news/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-NEWS-103
 * @design DD-NEWS-004
 * @remarks 認証の無い窓口なので、続けて叩かれても DB と署名の負荷が増えないよう、回数の制限（10分に60回）と件数の上限（20件）をここで掛ける（SEC-NEWS-009）。
 * 数え場所が落ちた時の応答もそのまま返し、制限が外れた状態で開けない。
 * 失敗の応答は固定の文にして内部の情報を出さず、記録は誤りの名前と符号だけにする。
 * 返す記事を公開済みだけに絞るのは取り出しの関数に任せる（SEC-NEWS-001）。
 * 全ての応答（200・429・503・500）を Cache-Control: private, no-store で返すのは、送り元単位の回数制限を共有キャッシュに飛ばされないため（SEC-NEWS-006）。
 * 分類は許可の一覧の値だけを取り出しに渡し、外れた値は ALL と同じ扱いにする（SEC-NEWS-012）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getPublishedNews } from '@/features/news/services/public';
import { resolveNewsCategory } from '@/features/news/lib/news-input';
import { withNoStore } from '@/lib/http/no-store';
import { describeErrorForLog } from '@/lib/logging/safe-error';

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 20;

async function handleGet(request: NextRequest) {
  try {
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitResponse = await enforceRateLimit({
      request,
      endpoint: 'news:list',
      limit: 60,
      windowSeconds: 600,
    });

    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const searchParams = request.nextUrl.searchParams;
    const category = resolveNewsCategory(searchParams.get('category'));
    const limitParam = searchParams.get('limit');

    const parsedLimit =
      typeof limitParam === 'string' && /^\d+$/.test(limitParam)
        ? Number.parseInt(limitParam, 10)
        : undefined;

    const limit = parsedLimit && Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

    const articles = await getPublishedNews({
      category,
      limit,
    });

    return NextResponse.json(articles, { status: 200 });
  } catch (error) {
    console.error('GET /api/news error:', describeErrorForLog(error));
    return NextResponse.json({ error: 'Failed to fetch news' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return withNoStore(await handleGet(request));
}
