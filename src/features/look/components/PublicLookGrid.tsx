"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { SectionTitle } from "@/components/ui/SectionTitle/SectionTitle";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { MultiSelect } from "@/components/ui/MultiSelect/MultiSelect";
import {
  filterLooksBySeason,
  formatLookSeason,
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
  "grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-4 sm:gap-6 lg:gap-8";
const DEFAULT_CATALOG_GRID_CLASS =
  "grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3 md:gap-8 lg:grid-cols-3 lg:gap-10 xl:gap-12";
const TAB_SCROLL_CONTAINER_CLASS =
  "w-full overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";
const LOOK_SEASON_FILTER_OPTIONS = LOOK_SEASON_OPTIONS.map((season) => ({
  value: season,
  label: season,
}));

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
  const currencyFormatter = new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  });
  return (
    <div>
      <Link href={`/look/${look.id}`} className="group block">
        <div className="relative mb-3 aspect-[2/3] overflow-hidden bg-[#f5f5f5] sm:mb-4">
          <Image
            src={look.imageUrls[0] || "/placeholder.png"}
            alt={look.theme}
            fill
            unoptimized
            className="h-full w-full object-cover object-top transition-transform duration-500 motion-safe:group-hover:scale-105"
          />
        </div>
      </Link>
      <div>
        <Link href={`/look/${look.id}`} className="inline-block">
          <p
            className=" text-black/50 tracking-widest mb-[3px] sm:mb-[5px]"
            style={{ fontSize: "var(--lk-size-3xs)" }}
          >
            {formatLookSeason(look.seasonYear, look.seasonType)} COLLECTION
          </p>
          <h3
            className="mb-1 font-brand transition-colors hover:text-[#474747] "
            style={{ fontSize: "var(--lk-size-2xs)" }}
          >
            {look.theme}
          </h3>
        </Link>
        <div className="look-related-items flex flex-col">
          {look.linkedItems.length === 0 ? (
            <p className="look-related-item-text text-[#474747]">
              紐づけ商品なし
            </p>
          ) : (
            look.linkedItems.map((item) => (
              <Link
                key={item.id}
                href={`/item/${item.id}`}
                className="look-related-item-text block text-[#474747] transition-colors hover:text-black"
              >
                <div className="flex items-center justify-between">
                  <span style={{ fontSize: "var(--lk-size-3xs)" }}>
                    {item.name}
                  </span>
                  <span style={{ fontSize: "var(--lk-size-3xs)" }}>
                    {currencyFormatter.format(item.price)}
                  </span>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function renderEmptyState(message: string) {
  return (
    <div className="py-20 text-center">
      <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-md)" }}>{message}</p>
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

  const renderSeasonFilter = () => (
    <MultiSelect
      variant="panel"
      options={LOOK_SEASON_FILTER_OPTIONS}
      values={selectedSeasonValues}
      onChange={handleSeasonSelection}
      shape="square"
      checkStyle="fill"
      size="xs"
      className="tracking-widest"
      expandLabelHitArea={true}
      renderOptionLabel={(option) => (
        <span style={{ fontSize: "var(--lk-size-4xs)" }}>{option.label}</span>
      )}
    />
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
        "flex items-center justify-between border-b border-black/5 bg-white/95 py-[13px] backdrop-blur",
        !interactive && "pointer-events-none invisible",
      )}
    >
      <Button
        data-filter-button={interactive ? "floating" : "placeholder"}
        onClick={interactive ? () => setIsFilterDrawerOpen(true) : undefined}
        variant="text"
        size="xs"
        className="tracking-[0.1em]"
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
            {renderSeasonFilter()}
          </div>
        </div>
      </Drawer>

      <div className="flex w-full">
        <aside
          className="hidden lg:block w-[199px] xl:w-[233px] flex-shrink-0 sticky h-[calc(100vh-var(--site-header-offset))] overflow-visible transition-[top,height] duration-300 ease-in-out"
          style={desktopFilterStickyStyle}
        >
          <div className="h-full overflow-y-auto border-r border-black/5 px-[13px] py-[21px] xl:px-[21px] xl:py-[34px]">
            <div className={TAB_SCROLL_CONTAINER_CLASS}>
              <div className="flex min-w-max w-full justify-center">
                {renderSeasonFilter()}
              </div>
            </div>
          </div>
        </aside>

        <div className="flex-1 min-w-0 w-full max-w-full px-0 py-0 md:px-[21px] lg:px-[21px] xl:px-[34px] 2xl:px-[55px] xl:py-[34px]">
          <div className="lg:hidden">
            {renderMobileFilterBar(false)}
          </div>
          <div
            className="fixed inset-x-0 z-30 lg:hidden bg-white transition-transform duration-300 ease-in-out"
            style={mobileFilterStickyStyle}
          >
            <div className="element-width px-6 md:px-[45px]">
              {renderMobileFilterBar(true)}
            </div>
          </div>

          {looks.length === 0 ? (
            renderEmptyState("公開中のLOOKがありません")
          ) : displayLooks.length === 0 ? (
            renderEmptyState("該当シーズンのLOOKがありません")
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
    const hasMoreLooks = looks.length > FIXED_LOOK_COUNT;
    const resolvedLooks = looks.slice(0, FIXED_LOOK_COUNT);
    const gridClassName = className ?? DEFAULT_HOME_GRID_CLASS;

    return (
      <section id="look" className="section-space">
        <div className="element-width">
          <SectionTitle title="LOOK" />

          {resolvedLooks.length === 0 ? (
            renderEmptyState("公開中のLOOKがありません")
          ) : (
            <>
              <div className={gridClassName}>
                {resolvedLooks.map((look) => (
                  <LookCard key={look.id} look={look} variant="home" />
                ))}
              </div>

              {hasMoreLooks && (
                <div className="mt-6 text-center md:mt-8 lg:mt-12">
                  <Button href="/look" variant="secondary" size="xs">
                    VIEW LOOKBOOK
                  </Button>
                </div>
              )}
            </>
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
