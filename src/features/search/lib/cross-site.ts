/**
 * 外のサイトの頁から読み込まれた検索の要求を断る。
 *
 * @packageDocumentation
 */
import { NextResponse } from 'next/server';
import { withNoStore } from '@/lib/http/no-store';

const SAME_ORIGIN_VALUES = new Set(['', 'same-origin', 'none']);

/**
 * sec-fetch-site が無い・'same-origin'・'none' なら null（通す）。それ以外は 403 { error: 'Forbidden' } を返す。
 *
 * @impl IMPL-SEARCH-127
 * @design DD-SEARCH-010
 * @remarks 外のサイトの頁に隠した読み込みで閲覧者の送り元の回数の枠を使い切らせ、その人の検索を止められるので、
 * ブラウザが付ける Sec-Fetch-Site が同じオリジンでない要求は検査・回数の制限より前に 403 にする（SEC-SEARCH-020）。
 * 見出しが無い要求（curl・古いブラウザ・サーバー間）は通す。同じサイトの別オリジン（same-site）は断る。
 */
export function rejectCrossSiteFetch(request: Request): NextResponse | null {
  const site = (request.headers.get('sec-fetch-site') ?? '').trim().toLowerCase();
  if (SAME_ORIGIN_VALUES.has(site)) {
    return null;
  }
  return withNoStore(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
}
