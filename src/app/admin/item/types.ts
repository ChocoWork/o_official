export const CATEGORIES = ['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;
export type Category = (typeof CATEGORIES)[number];

export const SIZES = ['S', 'M', 'L', 'FREE'] as const;
export type Size = (typeof SIZES)[number];

export interface ColorInput {
  id: string;
  name: string;
  hex: string;
}

export type ColorPresetResponse = {
  id: number;
  name: string;
  hex: string;
  created_at: string;
};

export type ItemStatus = 'private' | 'published';

// this mirrors the data we send/receive from the admin API
export type ItemResponse = {
  id: number;
  name: string;
  description: string;
  price: number;
  category: Category;
  image_url: string;
  image_urls?: string[];
  colors: Array<{ name: string; hex: string }>;
  sizes: string[];
  product_details: string;
  material?: string | null;
  origin?: string | null;
  sewing_region?: string | null;
  care?: string | null;
  season?: 'SS' | 'AW' | null;
  status: ItemStatus;
  stock_quantity?: number | null;
};

export type SeasonValue = '' | 'SS' | 'AW';

export interface ItemFormValues {
  name: string;
  description: string;
  price: number;
  category: Category;
  colors: Array<{ name: string; hex: string }>;
  sizes: string[];
  productDetails: string;
  material: string;
  origin: string;
  sewingRegion?: string;
  care: string;
  season?: SeasonValue;
  status: ItemStatus;
  stockQuantity?: number | null;
  previewUrls?: string[];
}
