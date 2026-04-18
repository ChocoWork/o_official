import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSearchSuggestions } from '@/features/search/services/search.service';

const suggestSchema = z.object({
  q: z.string().trim().max(100).optional().default(''),
});

export async function GET(request: NextRequest) {
  try {
    const parsed = suggestSchema.safeParse({
      q: request.nextUrl.searchParams.get('q') ?? '',
    });

    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid suggest query' }, { status: 400 });
    }

    const suggestions = await getSearchSuggestions(parsed.data.q, 8);
    return NextResponse.json({ suggestions }, { status: 200 });
  } catch (error) {
    console.error('GET /api/suggest error:', error);
    return NextResponse.json({ error: 'Failed to load suggestions' }, { status: 500 });
  }
}