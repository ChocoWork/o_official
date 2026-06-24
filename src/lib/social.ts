export type SocialLink = {
  key: string;
  label: string;
  iconClass: string;
  href: string;
};

// SNS リンクの一元管理。Header（ドロワー）と Footer の両方がこれを参照する。
// href を空文字にしておくと未表示（アカウント開設後に URL を入れると自動表示）。
export const SOCIAL_LINKS: SocialLink[] = [
  {
    key: "instagram",
    label: "Instagram",
    iconClass: "ri-instagram-line",
    href: "https://www.instagram.com/le_fil_des_heures_official/",
  },
  {
    key: "tiktok",
    label: "TikTok",
    iconClass: "ri-tiktok-line",
    href: "https://www.instagram.com/le_fil_des_heures_official/", // TODO: TikTok アカウント開設後に URL を設定
  },
  {
    key: "x",
    label: "X",
    iconClass: "ri-twitter-x-line",
    href: "https://www.instagram.com/le_fil_des_heures_official/", // TODO: X アカウント開設後に URL を設定
  },
];

// href が設定されているものだけを表示する（死にリンクを出さない）
export const VISIBLE_SOCIAL_LINKS = SOCIAL_LINKS.filter(
  (link) => link.href.trim().length > 0,
);
