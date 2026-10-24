/**
 * 公開済みのニュースを JSON で返す窓口 /api/news（src/app/api/news/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-NEWS-103
 * @design DD-NEWS-004
 * @remarks 認証の無い窓口なので、続けて叩かれても DB と署名の負荷が増えないよう、回数の制限（10分に60回）と件数の上限（20件）をここで掛ける（SEC-NEWS-009）。
 * 数え場所が落ちた時の応答もそのまま返し、制限が外れた状態で開けない。
 * 失敗の応答は固定の文にして内部の情報を出さない。
 * 返す記事を公開済みだけに絞るのは取り出しの関数に任せる（SEC-NEWS-001）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getPublishedNews } from '@/features/news/services/public';

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 20;

export async function GET(request: NextRequest) {
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
    const category = searchParams.get('category') ?? undefined;
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
    console.error('GET /api/news error:', error);
    return NextResponse.json({ error: 'Failed to fetch news' }, { status: 500 });
  }
}
