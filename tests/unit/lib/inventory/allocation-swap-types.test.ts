import { readFileSync } from 'node:fs';
import { ALLOCATION_SWAP_ERRORS, ALLOCATION_SWAP_TEXT } from '@/lib/inventory/allocation-swap-types';

const errors = {
  GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
  GROUP_G_FORBIDDEN: ['42501', 403, '割り当てを入れ替える権限がありません。'],
  GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
  GROUP_G_SWAP_REASON_REQUIRED: ['22023', 400, '理由を入力してください。'],
  GROUP_G_SWAP_ITEM_NOT_FOUND: ['P0002', 404, '品物が見つかりません。'],
  GROUP_G_SWAP_SAME_ORDER: ['22023', 409, '同じ注文の品物どうしでは入れ替えられません。'],
  GROUP_G_SWAP_VARIANT_MISMATCH: ['22023', 409, '色・サイズが同じ品物どうしだけ入れ替えられます。'],
  GROUP_G_SWAP_ORDER_NOT_PAID: ['22023', 409, '入金が確認できていない注文は入れ替えられません。'],
  GROUP_G_SWAP_TAKER_ON_HOLD: ['22023', 409, '支払額の確認または交換手数料のお支払いを待っている品物には割り当てられません。'],
  GROUP_G_SWAP_DONOR_PENDING_REQUEST: ['22023', 409, 'キャンセルの申し込みか返金の処理中の数がある品物の割当は入れ替えられません。'],
  GROUP_G_SWAP_DONOR_ON_HOLD: ['22023', 409, '支払額の確認などで止まっている割当は入れ替えられません。'],
  GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER: ['22023', 409, '割り当てを受ける品物の、受注生産中の数を超えています。'],
  GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR: ['22023', 409, '割当元の、発送準備中の数を超えています。'],
};
test('FREQ-523-AC-02: 全13件のSQLSTATE・HTTP・本文を固定し、内部エラーを公開しない', () => {
  expect(ALLOCATION_SWAP_ERRORS).toEqual(errors);
  const sql = readFileSync('supabase/migrations/20261026101624_group_g4_orders_swap.sql', 'utf8');
  for (const [code, [state]] of Object.entries(errors)) {
    expect(sql).toContain(`RAISE EXCEPTION '${code}' USING ERRCODE = '${state}'`);
  }
});
test('FREQ-523-AC-05: dialog・候補・結果不明の共通文を固定する', () => {
  expect(ALLOCATION_SWAP_TEXT.title('ORD-12345678')).toBe('割り当てを入れ替える（注文 ORD-12345678）');
  expect(ALLOCATION_SWAP_TEXT.description).toBe('他の注文の発送準備中の割当を、この注文の受注生産中の品物へ移します。在庫の総数は変わりません。');
  expect(ALLOCATION_SWAP_TEXT).toMatchObject({ donorLabel: '割当元の注文', quantityLabel: '数量', reasonLabel: '理由',
    reasonHelp: 'この理由は両方の注文の履歴に残ります。', submit: '入れ替える', back: '戻る',
    candidatesEmpty: '入れ替えられる割当がありません。', candidatesLoading: '候補を読み込み中です...', candidatesFailed: '候補を読み込めませんでした。',
    success: '割当を入れ替えました。', failed: '割当の入替に失敗しました。', checkAgain: 'もう一度確かめる',
    unknown: '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。' });
});
