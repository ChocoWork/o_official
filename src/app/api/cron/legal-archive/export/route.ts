import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeCronBearer } from '@/lib/legal-archive/cron-auth';
import {
  fetchLegalArchivePage,
  type LegalArchiveClient,
} from '@/lib/legal-archive/export-query';
import { createServiceRoleClient } from '@/lib/supabase/server';

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(9999),
  cursor: z.string().trim().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).default(500),
});

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  if (
    !authorizeCronBearer(
      request.headers.get('authorization'),
      process.env.LEGAL_ARCHIVE_CRON_SECRET,
    )
  ) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const url = new URL(request.url);
  const query = querySchema.safeParse({
    year: url.searchParams.get('year') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    pageSize: url.searchParams.get('pageSize') ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json(
      { error: 'Invalid query', details: query.error.flatten() },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const client = (await createServiceRoleClient()) as unknown as LegalArchiveClient;
    const page = await fetchLegalArchivePage({
      client,
      year: query.data.year,
      cursor: query.data.cursor ?? null,
      pageSize: query.data.pageSize,
    });
    console.info('[legal-archive.export]', {
      year: query.data.year,
      hasCursor: Boolean(query.data.cursor),
      orderCount: page.orders.length,
    });
    return NextResponse.json(page, { status: 200, headers: NO_STORE_HEADERS });
  } catch {
    console.error('[legal-archive.export] export failed');
    return NextResponse.json(
      { error: 'Archive export unavailable' },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
