// STOCKIST の地方（地域）→都道府県マッピングと、店舗住所からの都道府県判定。
// 住所は日本の慣習どおり先頭に都道府県名（◯◯都/道/府/県）が来る前提で判定する。

export const STOCKIST_REGIONS = [
  { region: '北海道', prefectures: ['北海道'] },
  {
    region: '東北',
    prefectures: ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'],
  },
  {
    region: '関東',
    prefectures: ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県'],
  },
  {
    region: '中部',
    prefectures: [
      '新潟県',
      '富山県',
      '石川県',
      '福井県',
      '山梨県',
      '長野県',
      '岐阜県',
      '静岡県',
      '愛知県',
    ],
  },
  {
    region: '近畿',
    prefectures: ['三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'],
  },
  {
    region: '中国',
    prefectures: ['鳥取県', '島根県', '岡山県', '広島県', '山口県'],
  },
  {
    region: '四国',
    prefectures: ['徳島県', '香川県', '愛媛県', '高知県'],
  },
  {
    region: '九州・沖縄',
    prefectures: [
      '福岡県',
      '佐賀県',
      '長崎県',
      '熊本県',
      '大分県',
      '宮崎県',
      '鹿児島県',
      '沖縄県',
    ],
  },
] as const;

export type StockistRegion = (typeof STOCKIST_REGIONS)[number]['region'];

const ALL_PREFECTURES: string[] = STOCKIST_REGIONS.flatMap((entry) => [
  ...entry.prefectures,
]);

// 住所の先頭から都道府県名を判定する。該当しなければ null。
export function getPrefectureFromAddress(address: string): string | null {
  const trimmed = address.trim();
  return ALL_PREFECTURES.find((prefecture) => trimmed.startsWith(prefecture)) ?? null;
}

// 表示用の短縮ラベル（青森県→青森 / 東京都→東京 / 大阪府→大阪）。北海道はそのまま。
export function getPrefectureShortLabel(prefecture: string): string {
  if (prefecture === '北海道') {
    return prefecture;
  }
  return prefecture.replace(/[都府県]$/, '');
}
