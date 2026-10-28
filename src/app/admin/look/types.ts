export type ItemSummary = {
  id: number;
  name: string;
  price: number;
  /** 署名できない画像は null（元の値を返さない）。商品の選択欄は /placeholder.png を出す */
  image_url: string | null;
  status: 'private' | 'published';
};

export type LookStatus = 'private' | 'published';
export type SeasonType = 'SS' | 'AW';

export type LookFormValues = {
  seasonYear: number;
  seasonType: SeasonType;
  theme: string;
  themeDescription: string;
  status: LookStatus;
  linkedItemIds: number[];
  previewUrls: string[];
};

export type LookDetailResponse = {
  id: number;
  season_year: number;
  season_type: SeasonType;
  theme: string;
  theme_description: string;
  image_urls: string[];
  status: LookStatus;
  linkedItemIds: number[];
};
