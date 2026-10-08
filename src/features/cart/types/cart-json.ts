export const CART_OPTION_NAMES = { color: 'カラー', size: 'サイズ' } as const;

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

export type CartJson = {
  item_count: number;
  currency: 'JPY';
  items_subtotal_price: number;
  total_price: number;
  items: CartJsonLine[];
};

export const EMPTY_CART_JSON: CartJson = {
  item_count: 0,
  currency: 'JPY',
  items_subtotal_price: 0,
  total_price: 0,
  items: [],
};
