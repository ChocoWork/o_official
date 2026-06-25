export type ItemStockStatus = 'in_stock' | 'low_stock' | 'sold_out' | 'unknown';

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
  /** 素材名（構造化。例: コットン100%） */
  material?: string | null;
  /** 原産国（素材の生産国） */
  origin?: string | null;
  /** 縫製地域 */
  sewing_region?: string | null;
  /** ケア方法 */
  care?: string | null;
  /** コレクション。SS / AW のみ（年は持たない） */
  season?: 'SS' | 'AW' | null;
  status?: 'private' | 'published';
  stockStatus?: ItemStockStatus;
  /** NULL = 在庫情報なし, 0 = SOLD OUT, 1-4 = 残りわずか, 5以上 = 在庫あり */
  stock_quantity?: number | null;
  created_at?: string;
  updated_at?: string;
};