import { formatItemLines } from '@/lib/orders/order-confirmation-email';

describe('明細ごとのお届けの目安（グループ F 設計書 5-3）', () => {
  test('目安を出す指定のときだけ、明細の次の行に在庫あり・受注生産の目安を添える', () => {
    const items = [
      { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 28000, fulfillment_type: 'stock' },
      { item_name: 'ウールパンツ', color: null, size: 'L', quantity: 2, line_total: 36000, fulfillment_type: 'backorder' },
      { item_name: '目安の無い明細', quantity: 1, line_total: 1000, fulfillment_type: null },
    ];

    expect(formatItemLines(items, 'jpy', { withFulfillment: true })).toEqual([
      '・シルクブラウス（WHITE / M） x1　￥28,000\n　在庫あり・ご注文（コンビニはご入金）の確認後、3〜7営業日で発送',
      '・ウールパンツ（L） x2　￥36,000\n　受注生産・発送まで数週間〜2か月以上（目安）',
      '・目安の無い明細 x1　￥1,000',
    ]);
    expect(formatItemLines(items, 'jpy')).toEqual([
      '・シルクブラウス（WHITE / M） x1　￥28,000',
      '・ウールパンツ（L） x2　￥36,000',
      '・目安の無い明細 x1　￥1,000',
    ]);
  });
});
