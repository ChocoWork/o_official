import type { Fulfillment } from '@/features/checkout/services/checkout-fulfillment.service';

/** カートの明細ごとのお届けの目安（グループ F 設計書 5-2） */
export const CART_FULFILLMENT_LABELS: Record<Fulfillment, string> = {
  stock: '在庫あり・3〜7営業日で発送',
  backorder: '受注生産・数週間〜2か月以上',
};

/** 最終確認画面の引渡しの時期の見出し（グループ F 設計書 第4章） */
export const FULFILLMENT_HEADINGS: Record<Fulfillment, string> = {
  stock: '在庫あり',
  backorder: '受注生産',
};

/** 最終確認画面の引渡しの時期（グループ F 設計書 第4章）。見出しは FULFILLMENT_HEADINGS */
export const FINAL_FULFILLMENT_LABELS: Record<Fulfillment, string> = {
  stock: 'ご注文（コンビニはご入金）の確認後、3〜7営業日で発送',
  backorder: '発送まで数週間〜2か月以上（目安）',
};
