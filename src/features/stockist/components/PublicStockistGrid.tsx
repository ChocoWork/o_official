import { Card } from '@/app/components/ui/Card';
import { TagLabel } from '@/app/components/ui/TagLabel';
import {
  getPublicStockists,
  HOME_PUBLIC_STOCKISTS,
  STOCKIST_MAP_EMBED_URL,
} from '@/features/stockist/services/public';
import { PublicStockist } from '@/features/stockist/types';

const DEFAULT_GRID_CLASS = 'grid grid-cols-1 md:grid-cols-2 gap-8 lg:gap-12';

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

export function PublicStockistGrid(props: PublicStockistGridProps) {
  const { variant, className } = props;
  const resolvedStockists = props.stockists ?? (variant === 'home' ? HOME_PUBLIC_STOCKISTS : getPublicStockists());
  const gridClassName = className ?? DEFAULT_GRID_CLASS;

  const renderGrid = () => (
    <div className={gridClassName}>
      {resolvedStockists.map((shop) => {
        const isHome = variant === 'home';

        if (isHome) {
          return (
            <div key={shop.name} className="border border-[#d5d0c9] p-8 lg:p-10 hover:border-black transition-colors duration-300">
              <h3 className="text-xl lg:text-2xl mb-6 text-black font-brand">{shop.name}</h3>
              <div className="space-y-3 text-[#474747] font-brand">
                <div className="flex items-start">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-map-pin-line text-lg" /></div>
                  <p className="text-sm">{shop.address}</p>
                </div>
                <div className="flex items-start">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-phone-line text-lg" /></div>
                  <p className="text-sm">{shop.phone}</p>
                </div>
                <div className="flex items-start">
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-time-line text-lg" /></div>
                  <div className="text-sm">
                    <p>{shop.time}</p>
                    <p className="text-xs mt-1">{shop.holiday}</p>
                  </div>
                </div>
              </div>
            </div>
          );
        }

        return (
          <Card key={shop.name} className="border-black/10 p-8 hover:border-black transition-colors duration-300" size="md">
            <div className="mb-4">
              <TagLabel className="inline-block mb-4 font-brand" size="md">{shop.type}</TagLabel>
              <h2 className="text-2xl text-black mb-6 font-display">{shop.name}</h2>
            </div>
            <div className="space-y-3">
              <div className="flex items-start">
                <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-map-pin-line text-lg text-black" /></div>
                <p className="text-sm text-[#474747] font-brand">{shop.address}</p>
              </div>
              <div className="flex items-center">
                <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-phone-line text-lg text-black" /></div>
                <p className="text-sm text-[#474747] font-brand">{shop.phone}</p>
              </div>
              <div className="flex items-center">
                <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-time-line text-lg text-black" /></div>
                <p className="text-sm text-[#474747] font-brand">{shop.time}</p>
              </div>
              <div className="flex items-center">
                <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-calendar-line text-lg text-black" /></div>
                <p className="text-sm text-[#474747] font-brand">{shop.holiday}</p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );

  if (variant === 'home') {
    return (
      <section id="stockist" className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto">
          <div className="text-left mb-10 md:mb-12">
            <h2 className="text-xl lg:text-2xl text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
              STOCKIST
            </h2>
          </div>

          {renderGrid()}

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
        </div>
      </section>
    );
  }

  return renderGrid();
}