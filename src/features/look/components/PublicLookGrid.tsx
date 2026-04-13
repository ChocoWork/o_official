import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { PublicLook, formatLookSeason, getPublishedLooks } from '@/lib/look/public';

const FIXED_LOOK_COUNT = 6;
const DEFAULT_HOME_GRID_CLASS = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-4 sm:gap-6 lg:gap-8';
const DEFAULT_CATALOG_GRID_CLASS = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-4 sm:gap-6 md:gap-8 lg:gap-10 xl:gap-12';

type PublicLookGridHomeProps = {
  variant: 'home';
  looks?: PublicLook[];
  className?: string;
};

type PublicLookGridCatalogProps = {
  variant: 'catalog';
  looks?: PublicLook[];
  className?: string;
};

type PublicLookGridProps = PublicLookGridHomeProps | PublicLookGridCatalogProps;

type LookCardProps = {
  look: PublicLook;
};

function LookCard({ look }: LookCardProps) {
  return (
    <div>
      <Link href={`/look/${look.id}`} className="group block">
        <div className="aspect-[2/3] bg-[#f5f5f5] mb-3 sm:mb-4 overflow-hidden relative">
          <Image
            src={look.imageUrls[0] || '/placeholder.png'}
            alt={look.theme}
            fill
            unoptimized
            className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
          />
        </div>
      </Link>
      <div className="">
        <Link href={`/look/${look.id}`}>
          <p className="text-sm sm:text-base lg:text-lg mb-1.5 sm:mb-2 text-black font-brand hover:text-[#474747] transition-colors">{formatLookSeason(look.seasonYear, look.seasonType)} - {look.theme}</p>
        </Link>
        <div className="space-y-1">
          {look.linkedItems.length === 0 ? (
            <p className="text-xs text-[#474747] font-brand">紐づけ商品なし</p>
          ) : (
            look.linkedItems.map((item) => (
              <Link
                key={item.id}
                href={`/item/${item.id}`}
                className="block text-xs text-[#474747] hover:text-black transition-colors font-brand"
              >
                {item.name}
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export async function PublicLookGrid(props: PublicLookGridProps) {
  const { variant, className } = props;

  const loadedLooks = props.looks
    ?? await getPublishedLooks(variant === 'home' ? FIXED_LOOK_COUNT + 1 : undefined);
  const hasMoreLooks = variant === 'home' && loadedLooks.length > FIXED_LOOK_COUNT;
  const resolvedLooks = variant === 'home' ? loadedLooks.slice(0, FIXED_LOOK_COUNT) : loadedLooks;

  const defaultGridClass = variant === 'home' ? DEFAULT_HOME_GRID_CLASS : DEFAULT_CATALOG_GRID_CLASS;
  const gridClassName = className ?? defaultGridClass;

  const renderGrid = () => (
    <div className={gridClassName}>
      {resolvedLooks.map((look) => {
        return <LookCard key={look.id} look={look} />;
      })}
    </div>
  );

  const renderEmptyState = () => (
    <div className="text-center py-12 text-[#474747] font-brand">公開中のLOOKがありません</div>
  );

  const renderContent = () => {
    if (resolvedLooks.length === 0) {
      return renderEmptyState();
    }

    return (
      <>
        {renderGrid()}
        {variant === 'home' && hasMoreLooks && (
          <div className="text-center mt-6 md:mt-8 lg:mt-12">
            <Button href="/look" variant="secondary" size="md" className="font-acumin">
              VIEW LOOKBOOK
            </Button>
          </div>
        )}
      </>
    );
  };

  if (variant === 'home') {
    return (
      <section id="look" className="mt-14 sm:mt-16 lg:mt-20 pb-14 sm:pb-16 md:pb-20 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto">
          <SectionTitle title="LOOK" />
          {renderContent()}
        </div>
      </section>
    );
  }

  return <>{renderContent()}</>;

}
