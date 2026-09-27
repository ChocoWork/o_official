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
  /** 商品ごとの注意書き（PRODUCT NOTE） */
  product_note?: string | null;
  /** コレクション。SS / AW のみ（年は持たない） */
  season?: 'SS' | 'AW' | null;
  status?: 'private' | 'published';
  stockStatus?: ItemStockStatus;
  /**
   * すぐ出せる在庫がある組み合わせが1つも無い（FREQ-400）。
   * 「買えない」ではなく「受注生産になる」。在庫を理由に注文は止めない。
   */
  madeToOrder?: boolean;
  /** 色 × サイズごとの在庫の有無。残数は出さない（FREQ-400） */
  variantAvailability?: Array<{
    colorName: string | null;
    sizeLabel: string | null;
    inStock: boolean;
  }>;
  created_at?: string;
  updated_at?: string;
};