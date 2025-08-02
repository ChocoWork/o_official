export interface CartItem {
  id: string;
  name: string;
  price: number;
  image: string;
  quantity: number;
  category: string;
  color: string; // 色を追加
  size: string; // サイズを追加
  inStock: boolean;
}

export interface CartSummary {
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
}