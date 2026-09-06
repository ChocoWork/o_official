import "./look-detail.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { formatLookSeason } from "@/lib/look/public";
import { getPublishedLookById, getPublishedLooks } from "@/lib/look/server";
import { List } from "@/components/ui/List/List";
import { BottomNavigation } from "@/components/ui/BottomNavigation/BottomNavigation";
import { LookImageGallery } from "@/features/look/components/LookImageGallery";

type Props = {
  params: Promise<{ id: string }>;
};

/* FREQ-182: ナビアイコンはアイコンフォント（フォントラスタライズによる
   にじみ・線幅固定）ではなく、細線ストロークのインライン SVG で描画する。 */
const NAV_ICON_ARROW_LEFT = <path d="M20 12H4M10 6l-6 6 6 6" />;
const NAV_ICON_ARROW_RIGHT = <path d="M4 12h16M14 6l6 6-6 6" />;
const NAV_ICON_GRID = (
  <>
    <rect x="4" y="4" width="6.5" height="6.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" />
  </>
);

function NavIcon({
  children,
  className,
  fontSize = "var(--lk-size-7xl)",
}: {
  children: ReactNode;
  className?: string;
  /* 固定ボトムナビ側は BottomNavigation のアイコン径に合わせる（FREQ-343）。 */
  fontSize?: string;
}) {
  return (
    <svg
      data-testid="look-detail-nav-icon"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className={`block ${className ?? ""}`}
      style={{ fontSize }}
    >
      {children}
    </svg>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const lookId = Number(id);
  const look = Number.isNaN(lookId) ? null : await getPublishedLookById(lookId);

  if (!look) {
    return {
      title: "Look not found | Le Fil des Heures",
      description: "指定されたルックは見つかりませんでした。",
    };
  }

  const title = `${look.theme} | LOOK | Le Fil des Heures`;
  const description =
    look.themeDescription || `${look.theme} のスタイリング詳細ページ`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: look.imageUrls.length > 0 ? [{ url: look.imageUrls[0] }] : [],
    },
  };
}

export default async function LookDetailPage({ params }: Props) {
  const { id } = await params;
  const lookId = Number(id);
  const looks = await getPublishedLooks();
  const currentIndex = looks.findIndex((look) => look.id === lookId);

  if (currentIndex < 0) {
    return (
      <div>
        <div className="element-width text-center">
          <h1>Look not found</h1>
        </div>
      </div>
    );
  }

  const currentLook = looks[currentIndex];
  const prevLook = currentIndex > 0 ? looks[currentIndex - 1] : null;
  const nextLook =
    currentIndex < looks.length - 1 ? looks[currentIndex + 1] : null;
  const seasonLabel = formatLookSeason(
    currentLook.seasonYear,
    currentLook.seasonType,
  );
  const currencyFormatter = new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  });

  return (
    <div>
      <div className="element-width">
        {/* ITEM 詳細ページと同じ列構成。md〜lg 未満は画像列を幅基準（w-full + aspect-2/3）で
            組むため、viewport 高を超えないよう幅側に上限を置く（32rem=48rem*2/3）。
            画像列は -ml-5 で 20px 左にはみ出すので、見た目の間隔は gap-x-3(12px)+20px=32px、
            右端も pr-3(12px)+ページの px-5(20px) で 32px に揃う。lg 以上は情報列の上限を
            画像の幅（高さ min(48rem,100svh-7rem) の 2:3 から逆算）に合わせる。 */}
        <div
          data-testid="look-detail-layout"
          className="grid grid-cols-1 gap-y-8.5 md:-ml-5 md:grid-cols-[min(32rem,56%,calc((100svh-6rem)*2/3))_minmax(18.125rem,1fr)] md:gap-x-3 md:gap-y-0 md:pr-3 lg:ml-0 lg:pr-0 lg:grid-cols-[auto_minmax(18.125rem,min(32rem,calc((100svh-7rem)*2/3)))] lg:justify-center lg:gap-x-14"
        >
          <div className="md:-ml-5 md:w-full lg:ml-0">
            <LookImageGallery
              theme={currentLook.theme}
              imageUrls={currentLook.imageUrls}
            />
          </div>

          <div className="space-y-8.5 md:w-full md:self-start lg:pt-8.5">
            <div>
              <p
                className="text-[#474747] tracking-wider mb-3.25"
                style={{ fontSize: "var(--lk-size-xs)" }}
              >
                {seasonLabel}
              </p>
              <h1
                className="mb-3.25"
                style={{ fontSize: "var(--lk-size-7xl)" }}
              >
                {currentLook.theme}
              </h1>
            </div>

            <div className="">
              <p
                className="text-[#474747] leading-loose"
                style={{ fontSize: "var(--lk-size-2xs)" }}
              >
                {currentLook.themeDescription || " "}
              </p>
            </div>

            <div className="pt-5.25">
              {currentLook.linkedItems.length === 0 ? (
                <p
                  className="text-[#474747]"
                  style={{ fontSize: "var(--lk-size-sm)" }}
                >
                  紐づけ商品はありません
                </p>
              ) : (
                <List<(typeof currentLook.linkedItems)[number]>
                  items={currentLook.linkedItems}
                  itemKey={(item) => String(item.id)}
                  className="border-y border-black/10 [--list-preview-scale:var(--sqrt-phi)]"
                  variant="showcase"
                  getName={(item) => item.name}
                  getCategory={(item) => item.category}
                  getPrice={(item) => currencyFormatter.format(item.price)}
                  getImage={(item) => item.imageUrl}
                  getHref={(item) => `/item/${item.id}`}
                  size="xs"
                />
              )}
            </div>

            {/* FREQ-181: PREV LOOK / LOOK LIST / NEXT LOOK の3カラムナビ
                （ラベル上・アイコン下、縦の区切り線で3等分） */}
            <nav
              data-testid="look-detail-bottom-nav"
              aria-label="Look navigation"
              className="hidden md:grid md:grid-cols-3 divide-x divide-black/10 pt-3.25"
            >
              {prevLook ? (
                <Link
                  href={`/look/${prevLook.id}`}
                  aria-label={`Previous look: ${prevLook.theme}`}
                  className="group flex cursor-pointer flex-col items-center gap-3.25 py-3.25"
                >
                  <p
                    className="text-black tracking-wider transition-colors group-hover:text-[#474747]"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    PREV LOOK
                  </p>
                  <NavIcon className="text-black transition-colors group-hover:text-[#474747]">
                    {NAV_ICON_ARROW_LEFT}
                  </NavIcon>
                </Link>
              ) : (
                <div
                  aria-hidden="true"
                  className="flex flex-col items-center gap-3.25 py-3.25 opacity-30"
                >
                  <p
                    className="text-black tracking-wider"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    PREV LOOK
                  </p>
                  <NavIcon className="text-black">
                    {NAV_ICON_ARROW_LEFT}
                  </NavIcon>
                </div>
              )}
              <Link
                href="/look"
                aria-label="Look list"
                className="group flex cursor-pointer flex-col items-center gap-3.25 py-3.25"
              >
                <p
                  className="text-black tracking-wider transition-colors group-hover:text-[#474747]"
                  style={{ fontSize: "var(--lk-size-2xs)" }}
                >
                  LOOK LIST
                </p>
                <NavIcon className="text-black transition-colors group-hover:text-[#474747]">
                  {NAV_ICON_GRID}
                </NavIcon>
              </Link>
              {nextLook ? (
                <Link
                  href={`/look/${nextLook.id}`}
                  aria-label={`Next look: ${nextLook.theme}`}
                  className="group flex cursor-pointer flex-col items-center gap-3.25 py-3.25"
                >
                  <p
                    className="text-black tracking-wider transition-colors group-hover:text-[#474747]"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    NEXT LOOK
                  </p>
                  <NavIcon className="text-black transition-colors group-hover:text-[#474747]">
                    {NAV_ICON_ARROW_RIGHT}
                  </NavIcon>
                </Link>
              ) : (
                <div
                  aria-hidden="true"
                  className="flex flex-col items-center gap-3.25 py-3.25 opacity-30"
                >
                  <p
                    className="text-black tracking-wider"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    NEXT LOOK
                  </p>
                  <NavIcon className="text-black">
                    {NAV_ICON_ARROW_RIGHT}
                  </NavIcon>
                </div>
              )}
            </nav>
          </div>
        </div>
      </div>

      {/* FREQ-343: md 未満は同じ3項目を UI の BottomNavigation として画面下に固定する
          （ITEM 詳細のモバイル固定フッターと同じ体験）。 */}
      <div data-testid="look-detail-fixed-nav" className="md:hidden">
        <BottomNavigation
          className="[--bottom-nav-label-size:var(--lk-size-7xs)]"
          activeKey=""
          fixed
          appearance="filled"
          size="md"
          items={[
            {
              key: "prev",
              label: "PREV LOOK",
              href: prevLook ? `/look/${prevLook.id}` : undefined,
              disabled: !prevLook,
              icon: (
                <NavIcon fontSize="var(--bottom-nav-icon-size)">
                  {NAV_ICON_ARROW_LEFT}
                </NavIcon>
              ),
            },
            {
              key: "list",
              label: "LOOK LIST",
              href: "/look",
              icon: (
                <NavIcon fontSize="var(--bottom-nav-icon-size)">
                  {NAV_ICON_GRID}
                </NavIcon>
              ),
            },
            {
              key: "next",
              label: "NEXT LOOK",
              href: nextLook ? `/look/${nextLook.id}` : undefined,
              disabled: !nextLook,
              icon: (
                <NavIcon fontSize="var(--bottom-nav-icon-size)">
                  {NAV_ICON_ARROW_RIGHT}
                </NavIcon>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
