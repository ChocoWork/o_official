import { Card } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle/SectionTitle';
import {
  getHomePublicStockists,
  getPublicStockists,
} from '@/features/stockist/services/public';
import { PublicStockist } from '@/features/stockist/types';

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

  // Home variant: hide items beyond index 3 on mobile, show all on tablet (md+)
  const mobileLimit = variant === 'home' ? 3 : undefined;
  const gapClass = variant === 'catalog' ? 'stockist-grid-catalog' : 'stockist-grid-home';
  const colsClass = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';

  const renderGrid = () => (
    <div className={`${gapClass} ${colsClass}${className ? ` ${className}` : ''}`}>
      {resolvedStockists.map((shop, index) => (
        // Vertical card: name, divider, detail rows
        // Responsive scale: mobile=compact / sm(tablet)=readable / xl(desktop)=luxurious
        <Card
          key={shop.id}
          className={`stockist-card${typeof mobileLimit === 'number' && index >= mobileLimit ? ' hidden md:block' : ''}`}
          hoverable
          size="sm"
        >
          {/* Identity section */}
          <div className="stockist-card-identity">
            <h3 className="stockist-card-title">{shop.name}</h3>
          </div>
          {/* Divider */}
          <div className="stockist-card-divider" />
          {/* Detail rows */}
          <div className="stockist-card-details">
            <div className="stockist-card-row">
              <i className="ri-map-pin-line stockist-card-icon stockist-card-icon--pin" />
              <p className="stockist-card-text">{shop.address}</p>
            </div>
            <div className="stockist-card-row stockist-card-row--compact">
              <i className="ri-phone-line stockist-card-icon" />
              <p className="stockist-card-text">{shop.phone}</p>
            </div>
            <div className="stockist-card-row stockist-card-row--compact">
              <i className="ri-time-line stockist-card-icon" />
              <p className="stockist-card-text">{shop.time}</p>
            </div>
            <div className="stockist-card-row stockist-card-row--compact">
              <i className="ri-calendar-line stockist-card-icon" />
              <p className="stockist-card-text">{shop.holiday}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );

  if (variant === 'home') {
    return (
      <section id="stockist" className="section-space">
        <div className="element-width">
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