import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSearchSuggestions } from '@/features/search/services/search.service';

// Reject control characters (0x00-0x1F, 0x7F) and PostgREST filter-string
// syntax characters (,().) at the API boundary per OWASP A03.
// Allowed: printable Unicode excluding the above sets.
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

const suggestSchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .refine((v) => !CONTROL_CHAR_RE.test(v), {
      message: 'Control characters are not allowed',
    })
    .optional()
    .default(''),
});

export async function GET(request: NextRequest) {
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
    console.error('GET /api/suggest error:', error);
    return NextResponse.json({ error: 'Failed to load suggestions' }, { status: 500 });
  }
}