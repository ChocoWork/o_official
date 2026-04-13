import { Card } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';
import {
  getHomePublicStockists,
  getPublicStockists,
} from '@/features/stockist/services/public';
import { PublicStockist } from '@/features/stockist/types';

// Home variant: 3-col showcasing grid
const DEFAULT_GRID_CLASS = 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8 lg:gap-12';
// Catalog variant: 3-col grid for vertical cards (matches mobile stacked layout)
const CATALOG_GRID_CLASS = 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4';

type PublicStockistGridHomeProps = {
  variant: 'home';
  stockists?: PublicStockist[];
  className?: string;
};

type PublicStockistGridCatalogProps = {
  variant: 'catalog';
  stockists?: PublicStockist[];
  className?: string;
};

type PublicStockistGridProps = PublicStockistGridHomeProps | PublicStockistGridCatalogProps;

export async function PublicStockistGrid(props: PublicStockistGridProps) {
  const { variant, className } = props;
  const resolvedStockists =
    props.stockists ??
    (variant === 'home' ? await getHomePublicStockists() : await getPublicStockists());
  const gridClassName = className ?? (variant === 'catalog' ? CATALOG_GRID_CLASS : DEFAULT_GRID_CLASS);

  // Home variant: hide items beyond index 3 on mobile, show all on tablet (md+)
  const mobileLimit = variant === 'home' ? 3 : undefined;

  const renderGrid = () => (
    <div className={gridClassName}>
      {resolvedStockists.map((shop, index) => (
        // Vertical card: name, divider, detail rows
        // Responsive scale: mobile=compact / sm(tablet)=readable / xl(desktop)=luxurious
        <Card
          key={shop.id}
          className={`border-black/10 p-5 sm:p-6 xl:p-7 hover:border-black transition-colors duration-300${typeof mobileLimit === 'number' && index >= mobileLimit ? ' hidden md:block' : ''}`}
          size="sm"
        >
          {/* Identity section */}
          <div className="mb-3 sm:mb-4 xl:mb-5">
            <h2 className="text-sm sm:text-base xl:text-lg text-black font-display leading-snug">{shop.name}</h2>
          </div>
          {/* Divider */}
          <div className="border-t border-black/10 mb-3 sm:mb-4 xl:mb-5" />
          {/* Detail rows */}
          <div className="flex flex-col gap-1.5 sm:gap-2 xl:gap-2.5">
            <div className="flex items-start gap-2">
              <i className="ri-map-pin-line text-xs sm:text-sm text-black flex-shrink-0 mt-[3px]" />
              <p className="text-xs sm:text-sm text-[#474747] font-brand leading-relaxed">{shop.address}</p>
            </div>
            <div className="flex items-center gap-2">
              <i className="ri-phone-line text-xs sm:text-sm text-black flex-shrink-0" />
              <p className="text-xs sm:text-sm text-[#474747] font-brand">{shop.phone}</p>
            </div>
            <div className="flex items-center gap-2">
              <i className="ri-time-line text-xs sm:text-sm text-black flex-shrink-0" />
              <p className="text-xs sm:text-sm text-[#474747] font-brand">{shop.time}</p>
            </div>
            <div className="flex items-center gap-2">
              <i className="ri-calendar-line text-xs sm:text-sm text-black flex-shrink-0" />
              <p className="text-xs sm:text-sm text-[#474747] font-brand">{shop.holiday}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );

  if (variant === 'home') {
    return (
      <section id="stockist" className="mt-14 sm:mt-16 lg:mt-20 pb-20 sm:pb-24 lg:pb-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto">
          <SectionTitle title="STOCKIST" />

          {renderGrid()}

          {/*
          <div className="mt-16 lg:mt-24">
            <div className="aspect-[16/9] lg:aspect-[21/9] w-full">
              <iframe
                src={STOCKIST_MAP_EMBED_URL}
                width="100%"
                height="100%"
                className="border-0"
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                title="Le Fil des Heures stockist map"
              />
            </div>
          </div>
          */}
        </div>
      </section>
    );
  }

  return renderGrid();
}