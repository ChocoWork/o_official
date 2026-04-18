import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { executeSearch } from '@/features/search/services/search.service';
import type { SearchTab } from '@/features/search/types/search.types';

const searchSchema = z.object({
  q: z.string().trim().max(100).optional().default(''),
  tab: z.enum(['all', 'item', 'look', 'news']).optional().default('all'),
  preview: z.coerce.boolean().optional().default(false),
});

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const parsed = searchSchema.safeParse({
      q: request.nextUrl.searchParams.get('q') ?? '',
      tab: request.nextUrl.searchParams.get('tab') ?? 'all',
      preview: request.nextUrl.searchParams.get('preview') ?? 'false',
    });

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid search query' }, { status: 400 });
    }

    const result = await executeSearch({
      query: parsed.data.q,
      tab: parsed.data.tab as SearchTab,
      limitPerType: parsed.data.preview ? 3 : 8,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: {
        'x-search-duration-ms': String(Date.now() - startedAt),
      },
    });
  } catch (error) {
    console.error('GET /api/search error:', error);
    return NextResponse.json({ error: 'Failed to search content' }, { status: 500 });
  }
}