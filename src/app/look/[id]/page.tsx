import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { formatLookSeason } from "@/lib/look/public";
import { getPublishedLookById, getPublishedLooks } from "@/lib/look/server";
import { List } from "@/components/ui/List/List";
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
}: {
  children: ReactNode;
  className?: string;
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
      style={{ fontSize: "var(--lk-size-7xl)" }}
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-[34px] lg:gap-[55px]">
          <div className="space-y-[13px]">
            <LookImageGallery
              theme={currentLook.theme}
              imageUrls={currentLook.imageUrls}
            />
          </div>

          <div className="lg:pt-[34px] space-y-[34px]">
            <div>
              <p
                className="text-[#474747] tracking-wider mb-[13px]"
                style={{ fontSize: "var(--lk-size-xs)" }}
              >
                {seasonLabel}
              </p>
              <h1
                className="mb-[13px]"
                style={{ fontSize: "var(--lk-size-7xl)" }}
              >
                {currentLook.theme}
              </h1>
            </div>

            <div className="">
              <p
                className="text-[#474747] leading-[2]"
                style={{ fontSize: "var(--lk-size-2xs)" }}
              >
                {currentLook.themeDescription || " "}
              </p>
            </div>

            <div className="pt-[21px]">
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
              className="grid grid-cols-3 divide-x divide-black/10 pt-[13px]"
            >
              {prevLook ? (
                <Link
                  href={`/look/${prevLook.id}`}
                  aria-label={`Previous look: ${prevLook.theme}`}
                  className="group flex cursor-pointer flex-col items-center gap-[13px] py-[13px]"
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
                  className="flex flex-col items-center gap-[13px] py-[13px] opacity-30"
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
                className="group flex cursor-pointer flex-col items-center gap-[13px] py-[13px]"
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
                  className="group flex cursor-pointer flex-col items-center gap-[13px] py-[13px]"
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
                  className="flex flex-col items-center gap-[13px] py-[13px] opacity-30"
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
    </div>
  );
}
