import { NextResponse } from 'next/server';

// 起動時の環境変数を毎回読む（ビルド時に固めない）。
export const dynamic = 'force-dynamic';

/**
 * E2E の見張りが、3000番のアプリが E2E 用の設定で起動したものかを確かめる（設計書 2026-10-05 グループ B の 7-3）。
 * E2E_SERVER_FINGERPRINT が無い起動（本番・普段の開発）では 404 を返し、何も明かさない。
 * 印は設定から作ったハッシュで、秘密は含まない。
 */
export function GET() {
  const fingerprint = process.env.E2E_SERVER_FINGERPRINT;
  if (!fingerprint) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ fingerprint }, { headers: { 'Cache-Control': 'no-store' } });
}
