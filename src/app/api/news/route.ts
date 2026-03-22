import { NextRequest, NextResponse } from 'next/server';
import { getPublishedNews } from '@/features/news/services/public';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const category = searchParams.get('category') ?? undefined;
    const limitParam = searchParams.get('limit');

    const limit =
      typeof limitParam === 'string' && /^\d+$/.test(limitParam)
        ? Number.parseInt(limitParam, 10)
        : undefined;

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
