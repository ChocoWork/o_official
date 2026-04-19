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
