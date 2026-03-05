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
  status: ItemStatus;
};

export interface ItemFormValues {
  name: string;
  description: string;
  price: number;
  category: Category;
  colors: Array<{ name: string; hex: string }>;
  sizes: string[];
  productDetails: string;
  status: ItemStatus;
  previewUrls?: string[];
}
