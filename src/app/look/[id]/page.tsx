import type { Metadata } from "next";
import Link from "next/link";
import { formatLookSeason } from "@/lib/look/public";
import { getPublishedLookById, getPublishedLooks } from "@/lib/look/server";
import { List } from "@/components/ui/List/List";
import { LookImageGallery } from "@/features/look/components/LookImageGallery";

type Props = {
  params: Promise<{ id: string }>;
};

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
                    className="text-[#474747] transition-colors group-hover:text-black"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    PREV LOOK
                  </p>
                  <i
                    className="ri-arrow-left-line leading-none text-[#474747] transition-colors group-hover:text-black"
                    style={{ fontSize: "var(--lk-size-6xl)" }}
                    aria-hidden="true"
                  ></i>
                </Link>
              ) : (
                <div
                  aria-hidden="true"
                  className="flex flex-col items-center gap-[13px] py-[13px] opacity-30"
                >
                  <p
                    className="text-[#474747] tracking-widest"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    PREV LOOK
                  </p>
                  <i
                    className="ri-arrow-left-line leading-none text-[#474747]"
                    style={{ fontSize: "var(--lk-size-6xl)" }}
                  ></i>
                </div>
              )}
              <Link
                href="/look"
                aria-label="Look list"
                className="group flex cursor-pointer flex-col items-center gap-[13px] py-[13px]"
              >
                <p
                  className="text-[#474747] tracking-wider transition-colors group-hover:text-black"
                  style={{ fontSize: "var(--lk-size-2xs)" }}
                >
                  LOOK LIST
                </p>
                <i
                  className="ri-function-line leading-none text-[#474747] transition-colors group-hover:text-black"
                  style={{ fontSize: "var(--lk-size-6xl)" }}
                  aria-hidden="true"
                ></i>
              </Link>
              {nextLook ? (
                <Link
                  href={`/look/${nextLook.id}`}
                  aria-label={`Next look: ${nextLook.theme}`}
                  className="group flex cursor-pointer flex-col items-center gap-[13px] py-[13px]"
                >
                  <p
                    className="text-[#474747] tracking-wider transition-colors group-hover:text-black"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    NEXT LOOK
                  </p>
                  <i
                    className="ri-arrow-right-line leading-none text-[#474747] transition-colors group-hover:text-black"
                    style={{ fontSize: "var(--lk-size-6xl)" }}
                    aria-hidden="true"
                  ></i>
                </Link>
              ) : (
                <div
                  aria-hidden="true"
                  className="flex flex-col items-center gap-[13px] py-[13px] opacity-30"
                >
                  <p
                    className="text-[#474747] tracking-wider"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    NEXT LOOK
                  </p>
                  <i
                    className="ri-arrow-right-line leading-none text-[#474747]"
                    style={{ fontSize: "var(--lk-size-6xl)" }}
                  ></i>
                </div>
              )}
            </nav>
          </div>
        </div>
      </div>
    </div>
  );
}
