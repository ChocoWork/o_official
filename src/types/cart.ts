import { Item } from './item';

// Supabaseのcartテーブルに対応する型
export interface CartItem {
  id: number;           // Supabaseではnumber型
  user_id: string;      // ユーザーIDを追加
  item_id: number;      // アイテムIDを追加
  name: string;
  price: number;
  image: string;
  quantity: number;
  category: string;
  color: string;
  size: string;
  inStock: boolean;
  created_at: string;   // 作成日時を追加
  items?: Item;         // 関連するアイテム情報を追加（オプション）
}

// カートサマリー型（このまま活用）
export interface CartSummary {
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
}