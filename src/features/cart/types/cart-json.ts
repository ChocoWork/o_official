export const CART_OPTION_NAMES = { color: 'カラー', size: 'サイズ' } as const;

/** 画像の署名ができない明細の代わりの絵。next/image は空の src で落ちるので、'' や元の URL は入れない */
export const CART_PLACEHOLDER_IMAGE = '/placeholder.png';

export type CartJsonLine = {
  key: string;
  id: number;
  variant_id: number;
  product_id: number;
  quantity: number;
  title: string;
  product_title: string;
  variant_title: string | null;
  options_with_values: Array<{ name: string; value: string }>;
  price: number;
  line_price: number;
  image: string | null;
  url: string;
  fulfillment: 'stock' | 'backorder' | null;
};

/** カートに出す自動割引の内訳（コードは入れない。入力したコードの割引は決済の画面だけ） */
export type CartJsonDiscount = { name: string; amount: number };

export type CartJson = {
  item_count: number;
  currency: 'JPY';
  /** 割引前の小計（単価 × 数量の和） */
  items_subtotal_price: number;
  /** 割引後の正味額（送料は 0 円） */
  total_price: number;
  items: CartJsonLine[];
  discounts: CartJsonDiscount[];
  total_discount: number;
  /** ゲストの初回・１人１回など、確定前の見込みの額を含むとき true */
  discount_provisional: boolean;
};

export const EMPTY_CART_JSON: CartJson = {
  item_count: 0,
  currency: 'JPY',
  items_subtotal_price: 0,
  total_price: 0,
  items: [],
  discounts: [],
  total_discount: 0,
  discount_provisional: false,
};
