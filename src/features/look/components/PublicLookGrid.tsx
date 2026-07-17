"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { HomeSectionHeader } from "@/features/home/components/HomeSectionHeader";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { MultiSelect } from "@/components/ui/MultiSelect/MultiSelect";
import type { ComponentSize } from "@/components/ui/types";
import {
  filterLooksBySeason,
  LOOK_SEASON_OPTIONS,
  normalizeLookSeasonSelection,
  resolveLookSeasonFilter,
  toLookSeasonValues,
  type LookSeasonFilter,
  type PublicLook,
} from "@/lib/look/public";
import { cn } from "@/lib/utils";

const FIXED_LOOK_COUNT = 6;
const DEFAULT_HOME_GRID_CLASS =
  "grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6 lg:gap-4 xl:gap-6";
// 近接: カード間隔は縦横同じ gap にして、グリッド全体を均質に見せる。
const DEFAULT_CATALOG_GRID_CLASS =
  "grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3 md:gap-8 lg:grid-cols-3 lg:gap-4 xl:grid-cols-4 xl:gap-6";
const LOOK_SEASON_FILTER_OPTIONS = LOOK_SEASON_OPTIONS.map((season) => ({
  value: season,
  label: season,
}));

// L-6: フォーマッタはモジュールスコープで1度だけ生成（カード描画毎の再生成を回避）
const currencyFormatter = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

type LookCardProps = {
  look: PublicLook;
  variant: "home" | "catalog";
};

type PublicLookGridHomeProps = {
  variant: "home";
  looks: PublicLook[];
  className?: string;
};

type PublicLookGridCatalogProps = {
  variant: "catalog";
  looks: PublicLook[];
  className?: string;
  initialSeason?: LookSeasonFilter;
};

type PublicLookGridProps = PublicLookGridHomeProps | PublicLookGridCatalogProps;

function LookCard({ look }: LookCardProps) {
  const seasonLabel = `${look.seasonYear}${look.seasonType}`;

  return (
    <div>
      <Link href={`/look/${look.id}`} className="group block">
        <div className="relative mb-3 aspect-[2/3] overflow-hidden bg-[#f5f5f5] sm:mb-4 lg:mb-0">
          <Image
            src={look.imageUrls[0] || "/placeholder.png"}
            alt={look.theme}
            fill
            sizes="(min-width: 1024px) 33vw, 50vw"
            className="h-full w-full object-cover object-top"
          />
          {/* ホバー時: 2枚目の画像があればクロスフェードで表示（ズームはしない） */}
          {look.imageUrls[1] ? (
            <Image
              src={look.imageUrls[1]}
              alt={look.theme}
              fill
              sizes="(min-width: 1024px) 33vw, 50vw"
              data-testid="look-card-image-hover"
              className="h-full w-full object-cover object-top opacity-0 transition-opacity duration-500 group-hover:opacity-100"
            />
          ) : null}
          {/* PC のみ: シーズンとテーマを画像下部に白文字で重ねて表示。
              白文字の視認性確保のため下部に黒グラデーションを敷く。
              多段ストップでイージングを近似し、上端へ滑らかに消す。
              ホバー時はシーズン・テーマが消え、関連アイテムと価格に入れ替わる */}
          <div
            data-testid="look-card-overlay"
            className="absolute inset-x-0 bottom-0 hidden lg:block bg-[linear-gradient(to_top,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0.38)_30%,rgba(0,0,0,0.2)_55%,rgba(0,0,0,0.08)_78%,rgba(0,0,0,0)_100%)] px-[13px] pb-[13px] pt-[89px] text-white"
          >
            {/* タイトル群と関連アイテム群を同一グリッドセルに重ね、
                last baseline 揃えで「最終行の文字の下のライン」を一致させる
                （フォントサイズ差による行ボックス余白のずれを吸収する） */}
            <div className="grid">
              <div
                data-testid="look-card-overlay-title"
                className={cn(
                  "col-start-1 row-start-1 [align-self:last_baseline]",
                  look.linkedItems.length > 0 &&
                    "transition-opacity duration-300 group-hover:opacity-0",
                )}
              >
                <p
                  className="tracking-widest mb-[2px]"
                  style={{ fontSize: "var(--lk-size-3xs)" }}
                >
                  {seasonLabel}
                </p>
                <h3
                  className="font-display uppercase"
                  style={{ fontSize: "var(--lk-size-2xl)" }}
                >
                  {look.theme}
                </h3>
              </div>
              {look.linkedItems.length > 0 ? (
                <div
                  data-testid="look-card-overlay-items"
                  className="col-start-1 row-start-1 [align-self:last_baseline] flex flex-col gap-[2px] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                >
                  {look.linkedItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-baseline justify-between gap-2"
                      style={{ fontSize: "var(--lk-size-2xs)" }}
                    >
                      <span>{item.name}</span>
                      <span className="whitespace-nowrap">
                        {currencyFormatter.format(item.price)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </Link>
      <div>
        <Link
          href={`/look/${look.id}`}
          data-testid="look-card-caption"
          className="inline-block lg:hidden"
        >
          {/* 近接: コレクション時期と名前は同一グループとして密に（mb 小）、
              別グループの関連アイテムとの間は広く取る（h3 の mb 大）。 */}
          <p
            className=" text-black/50 tracking-widest mb-[2px]"
            style={{ fontSize: "var(--lk-size-3xs)" }}
          >
            {seasonLabel}
          </p>
          <h3
            className="mb-[8px] sm:mb-[13px] font-brand transition-colors hover:text-[#474747] "
            style={{ fontSize: "var(--lk-size-2xs)" }}
          >
            {look.theme}
          </h3>
        </Link>
        {/* L-7: 関連商品が無い場合は運用用語を出さず行ごと非表示。
            PC（lg 以上）はホバーでオーバーレイに関連アイテムを表示するため、
            カード下のリストは出さない */}
        {look.linkedItems.length > 0 ? (
          <div className="look-related-items flex flex-col lg:hidden">
            {look.linkedItems.map((item) => (
              <Link
                key={item.id}
                href={`/item/${item.id}`}
                className="look-related-item-text block text-[#474747] transition-colors hover:text-black"
              >
                {/* モバイルは商品名と価格を縦積み（折り返し回避）。sm 以上は従来の横並び。 */}
                <div className="flex flex-col gap-[2px] sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <span style={{ fontSize: "var(--lk-size-2xs)" }}>
                    {item.name}
                  </span>
                  <span
                    className="whitespace-nowrap"
                    style={{ fontSize: "var(--lk-size-2xs)" }}
                  >
                    {currencyFormatter.format(item.price)}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderEmptyState(message: string, action?: ReactNode) {
  return (
    <div className="py-20 text-center">
      <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-md)" }}>
        {message}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

type PublicLookCatalogProps = {
  looks: PublicLook[];
  initialSeason?: LookSeasonFilter;
  className?: string;
};

function PublicLookCatalog({
  looks,
  initialSeason = "ALL",
  className,
}: PublicLookCatalogProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const seasonQuery = searchParams.get("season");

  const [selectedSeason, setSelectedSeason] = useState<LookSeasonFilter>(() =>
    resolveLookSeasonFilter(seasonQuery, initialSeason),
  );
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);

  useEffect(() => {
    const nextSeason = resolveLookSeasonFilter(seasonQuery, initialSeason);
    setSelectedSeason((current) =>
      current === nextSeason ? current : nextSeason,
    );
  }, [initialSeason, seasonQuery]);

  const syncSeasonQuery = (nextSeason: LookSeasonFilter): void => {
    const params = new URLSearchParams(searchParams.toString());

    if (nextSeason === "ALL") {
      params.delete("season");
    } else {
      params.set("season", nextSeason);
    }

    const query = params.toString();
    const nextUrl = query.length > 0 ? `${pathname}?${query}` : pathname;
    router.push(nextUrl, { scroll: false });
  };

  const handleSeasonSelection = (values: string[]): void => {
    const nextSeason = normalizeLookSeasonSelection(values);

    if (
      nextSeason === selectedSeason &&
      resolveLookSeasonFilter(seasonQuery, initialSeason) === nextSeason
    ) {
      return;
    }

    setSelectedSeason(nextSeason);
    syncSeasonQuery(nextSeason);
  };

  const selectedSeasonValues = useMemo(
    () => toLookSeasonValues(selectedSeason),
    [selectedSeason],
  );
  const displayLooks = useMemo(
    () => filterLooksBySeason(looks, selectedSeason),
    [looks, selectedSeason],
  );
  const gridClassName = className ?? DEFAULT_CATALOG_GRID_CLASS;

  // NEWS 一覧の renderCategoryFilter と同一構造に揃える。.filter-sections で
  // 選択肢同士の間隔（option-list gap）を NEWS と共通化し、size / expandHitArea も
  // PC は 3xs / 非拡張、drawer は xs / 拡張で一致させる。
  const renderSeasonFilter = (
    size: ComponentSize = "3xs",
    expandHitArea = false,
  ) => (
    <div className="filter-sections">
      <MultiSelect
        variant="panel"
        options={LOOK_SEASON_FILTER_OPTIONS}
        values={selectedSeasonValues}
        onChange={handleSeasonSelection}
        shape="square"
        checkStyle="fill"
        size={size}
        className="space-y-2 tracking-widest"
        expandLabelHitArea={expandHitArea}
        renderOptionLabel={(option) => (
          <span style={{ fontSize: "var(--lk-size-4xs)" }}>{option.label}</span>
        )}
      />
    </div>
  );

  const mobileFilterStickyStyle = {
    top: "var(--site-header-height)",
    transform:
      "translateY(calc(var(--site-header-offset) - var(--site-header-height)))",
  } as const;

  const desktopFilterStickyStyle = {
    top: "var(--site-header-offset)",
  } as const;

  const renderMobileFilterBar = (interactive: boolean) => (
    <div
      data-filter-bar={interactive ? "floating" : "placeholder"}
      aria-hidden={interactive ? undefined : true}
      className={cn(
        "flex items-center justify-between bg-white/95 py-[13px] backdrop-blur",
        !interactive && "pointer-events-none invisible",
      )}
    >
      <Button
        data-filter-button={interactive ? "floating" : "placeholder"}
        onClick={interactive ? () => setIsFilterDrawerOpen(true) : undefined}
        variant="text"
        size="3xs"
        className="tracking-[0.06em]"
        style={{ marginLeft: "calc(-1 * var(--pad-x) - 1px)" }}
        aria-haspopup={interactive ? "dialog" : undefined}
        aria-expanded={interactive ? isFilterDrawerOpen : undefined}
        tabIndex={interactive ? undefined : -1}
      >
        FILTER
      </Button>
    </div>
  );

  return (
    <>
      <Drawer
        open={isFilterDrawerOpen}
        onClose={() => setIsFilterDrawerOpen(false)}
        side="left"
        size="md"
        className="[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        <div
          className="flex flex-col h-full"
          style={{
            paddingInline: "calc(var(--lk-size-sm) * var(--phi))",
            paddingTop: "calc(var(--lk-size-sm) * var(--sqrt-phi))",
          }}
        >
          <div className="flex justify-end pb-[13px]">
            <Button
              variant="text"
              size="xs"
              onClick={() => setIsFilterDrawerOpen(false)}
              aria-label="Close filter drawer"
            >
              <i className="ri-close-line" aria-hidden="true" />
            </Button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden pb-[21px]">
            {renderSeasonFilter("xs", true)}
          </div>
        </div>
      </Drawer>

      <div className="flex w-full">
        {/* デスクトップ: NEWS と同様に SEASON フィルターを左サイドバーに配置 */}
        <aside
          className="hidden lg:block w-[233px] xl:w-[288px] flex-shrink-0 sticky h-[calc(100vh-var(--site-header-offset))] overflow-visible transition-[top,height] duration-300 ease-in-out"
          style={desktopFilterStickyStyle}
        >
          <div
            className="h-full overflow-y-auto border-r border-black/5 px-[13px] xl:px-[21px]"
            style={{
              paddingBlock:
                "calc(var(--lk-size-sm) * var(--phi) * var(--phi)) calc(var(--lk-size-xs) * var(--phi))",
            }}
          >
            {renderSeasonFilter("3xs")}
          </div>
        </aside>

        <div
          data-testid="look-content-column"
          className="flex-1 min-w-0 w-full max-w-full px-0 md:px-[21px] lg:pl-[34px] lg:pr-[16px] xl:pl-[55px] xl:pr-[21px] 2xl:pl-[89px] 2xl:pr-[34px] py-0 xl:pb-[34px]"
        >
          <div className="sm:-mt-1 md:-mt-2 lg:hidden">
            {renderMobileFilterBar(false)}
          </div>
          <div
            className="fixed inset-x-0 z-30 lg:hidden bg-white border-b border-black/5 transition-transform duration-300 ease-in-out"
            style={mobileFilterStickyStyle}
          >
            <div className="element-width px-6 md:px-[45px]">
              {renderMobileFilterBar(true)}
            </div>
          </div>

          {looks.length === 0 ? (
            renderEmptyState("公開中のLOOKがありません")
          ) : displayLooks.length === 0 ? (
            renderEmptyState(
              "該当シーズンのLOOKがありません",
              <Button
                variant="secondary"
                size="xs"
                onClick={() => handleSeasonSelection(["ALL"])}
              >
                すべて見る
              </Button>,
            )
          ) : (
            <div className={gridClassName}>
              {displayLooks.map((look) => (
                <LookCard key={look.id} look={look} variant="catalog" />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function PublicLookGrid(props: PublicLookGridProps) {
  const { variant, className, looks } = props;

  if (variant === "home") {
    const resolvedLooks = looks.slice(0, FIXED_LOOK_COUNT);
    const gridClassName = className ?? DEFAULT_HOME_GRID_CLASS;

    return (
      <section id="look" className="section-space">
        <div className="element-width">
          <HomeSectionHeader
            title="LOOK"
            viewAllHref="/look"
            viewAllAriaLabel="VIEW ALL LOOKS"
          />

          {resolvedLooks.length === 0 ? (
            renderEmptyState("公開中のLOOKがありません")
          ) : (
            <div className={gridClassName}>
              {resolvedLooks.map((look) => (
                <LookCard key={look.id} look={look} variant="home" />
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <PublicLookCatalog
      looks={looks}
      initialSeason={props.initialSeason ?? "ALL"}
      className={className}
    />
  );
}
