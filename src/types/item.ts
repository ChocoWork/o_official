export type Item = {
  id: number;
  name: string;
  description?: string;
  price: number;
  image_url: string;
  image_urls?: string[];
  category: string;
  size?: string;
  colors?: Array<{ hex: string; name: string }> | string[];
  sizes?: string[];
  product_details?: string | Record<string, string> | string[];
  status?: 'private' | 'published';
  /** NULL = 在庫情報なし, 0 = SOLD OUT, 1-4 = 残りわずか, 5以上 = 在庫あり */
  stock_quantity?: number | null;
  created_at?: string;
  updated_at?: string;
};