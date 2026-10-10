import fs from 'node:fs';
import path from 'node:path';
import {
  FULFILLMENT_ERROR_MESSAGES,
  FULFILLMENT_FAILURE_MESSAGES,
  INVALID_REQUEST_BODY,
  INVALID_REQUEST_MESSAGE,
  UNKNOWN_OUTCOME_MESSAGE,
  fulfillmentErrorBody,
  fulfillmentFailureBody,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import { FULFILLMENT_ERROR_CODES } from '@/lib/orders/fulfillment/fulfillment-types';

// 共通の約束 C-2 の表。言葉を直す時は、画面と文書の言葉も一緒に直すため、ここは1字も変えずに写す
const EXPECTED = [
  ['order_not_found', 404, '注文が見つかりません。'],
  ['not_shippable', 409, '発送できる状態ではありません。一覧を更新してください。'],
  ['address_incomplete', 409, '配送先の必須項目が足りないため発送できません。'],
  ['payment_review_required', 409, '支払額の確認（要対応）が済むまで発送できません。'],
  ['quantity_exceeds_ready', 409, '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。'],
  ['fulfillment_request_mismatch', 409, '前の発送と内容が違います。画面を開き直してください。'],
  ['invalid_argument', 400, '入力を確かめてください。'],
  ['fulfillment_not_found', 404, '発送の記録が見つかりません。'],
  ['fulfillment_cancel_not_allowed', 409, 'この発送は取り消せません。注文の状態を確かめてください。'],
  ['not_in_production', 409, '仕上がりを記録できる状態ではありません。一覧を更新してください。'],
  ['quantity_exceeds_in_production', 409, '仕上がった数が受注生産中の数を超えています。一覧を更新してください。'],
  ['completion_request_mismatch', 409, '前の記録と内容が違います。画面を開き直してください。'],
  ['completion_not_found', 404, '仕上がりの記録が見つかりません。'],
  ['completion_already_shipped', 409, 'もう発送した数があるため、取り消せません。'],
] as const;

describe('誤りの記号ごとの HTTP と言葉', () => {
  it.each(EXPECTED)('%s は %i、言葉は「%s」', (code, status, message) => {
    expect(FULFILLMENT_ERROR_MESSAGES[code]).toEqual({ status, message });
    expect(fulfillmentErrorBody(code)).toEqual({ error: message, code });
  });

  it('表は誤りの記号を過不足なく持つ（記号を足したら言葉と HTTP も要る）', () => {
    const codes = [...FULFILLMENT_ERROR_CODES].sort();

    expect(EXPECTED.map(([code]) => code).sort()).toEqual(codes);
    expect(Object.keys(FULFILLMENT_ERROR_MESSAGES).sort()).toEqual(codes);
  });
});

describe('入力の誤り・失敗・答えが分からない時の言葉', () => {
  it('入力の誤りは 400 の窓口で、記号は invalid_request', () => {
    expect(INVALID_REQUEST_MESSAGE).toBe('入力を確かめてください。');
    expect(INVALID_REQUEST_BODY).toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
  });

  it('失敗（500）の言葉は窓口ごとに違い、記号は failed', () => {
    expect(FULFILLMENT_FAILURE_MESSAGES).toEqual({
      create: '発送の記録に失敗しました。',
      cancel: '発送の取消に失敗しました。',
      completion: '仕上がりの記録に失敗しました。',
      completion_cancel: '仕上がりの取消に失敗しました。',
      materials: '発送の材料を読み込めませんでした。',
    });
    expect(fulfillmentFailureBody('cancel')).toEqual({ error: '発送の取消に失敗しました。', code: 'failed' });
  });

  it('答えが分からない時の言葉は Global Constraints のとおり', () => {
    expect(UNKNOWN_OUTCOME_MESSAGE).toBe('結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。');
  });
});

describe('画面からも読めること', () => {
  it('サーバーだけの物を import しない（型だけの import に限る）', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/orders/fulfillment/fulfillment-messages.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(specifiers).toEqual(['@/lib/orders/fulfillment/fulfillment-types']);
    expect(source.match(/^import /gm)).toHaveLength(source.match(/^import type /gm)?.length ?? -1);
  });
});
