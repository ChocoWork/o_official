/**
 * 管理の取扱店の窓口が使う入力の形と、検証の誤りの固定の本文（src/features/stockist/schemas.ts）。
 *
 * @packageDocumentation
 * @remarks 店名・住所・営業時間・休業日は 1 行の文字だけを許し、改行・制御文字・書式文字・行区切りを拒む（SEC-STOCKIST-011）。
 * 電話は数字と記号だけを許す。半角・全角の空白は明示し、改行を含む \s は使わない。
 * 検証の誤りの本文は、誤りのあった項目の名前だけを返し、入力の値や zod の誤りの内訳を外へ出さない（SEC-STOCKIST-014）。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

/** 管理の一覧・1 件の読みで返す列。作成日などの内部の列は返さない（SEC-STOCKIST-009）。 */
export const ADMIN_STOCKIST_COLUMNS =
  'id, name, address, phone, time, holiday, status, updated_at';

export const stockistStatusSchema = z.enum(['private', 'published']);

const SINGLE_LINE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const PHONE_PATTERN = /^[0-9+\-() \u3000（）]+$/;

function singleLine(max: number) {
  return z.string().trim().min(1).max(max).regex(SINGLE_LINE_PATTERN);
}

export const stockistWriteSchema = z.object({
  name: singleLine(255),
  address: singleLine(500),
  phone: z.string().trim().min(1).max(50).regex(PHONE_PATTERN),
  time: singleLine(120),
  holiday: singleLine(120),
  status: stockistStatusSchema,
});

/**
 * 検証の誤りを、項目の名前だけの固定の本文（400）にする。
 *
 * @impl IMPL-STOCKIST-149
 * @design DD-STOCKIST-034
 * @remarks zod の誤りの内訳（制約の中身・入力の値）を応答に出すと、項目ごとの上限や入力の一部が外へ漏れる。誤りのあった項目の名前だけを重複なしで返す（SEC-STOCKIST-014）。
 */
export function toInvalidStockistResponse(error: z.ZodError): NextResponse {
  const fields = Array.from(
    new Set(
      error.issues
        .map((issue) => issue.path[0])
        .filter((name): name is string => typeof name === 'string'),
    ),
  );

  return NextResponse.json({ error: 'Invalid request', fields }, { status: 400 });
}
