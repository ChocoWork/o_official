import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/app/components/ui/Button';
import { PublicLook, formatLookSeason, getPublishedLooks } from '@/lib/look/public';

const FIXED_LOOK_COUNT = 6;
const DEFAULT_HOME_GRID_CLASS = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-6 lg:gap-8';
const DEFAULT_CATALOG_GRID_CLASS = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-12';

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
        <div className="aspect-[2/3] bg-[#f5f5f5] mb-6 overflow-hidden relative">
          <Image
            src={look.imageUrls[0] || '/placeholder.png'}
            alt={look.theme}
            fill
            unoptimized
            className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
          />
        </div>
      </Link>
      <div className="space-y-1">
        <Link href={`/look/${look.id}`}>
          <p className="text-lg text-black font-brand hover:text-[#474747] transition-colors">{formatLookSeason(look.seasonYear, look.seasonType)} - {look.theme}</p>
        </Link>
        <div className="pt-2 space-y-1">
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

  const loadedLooks = props.looks ?? await getPublishedLooks(FIXED_LOOK_COUNT);
  const totalLookCount = loadedLooks.length;
  const resolvedLooks = loadedLooks.slice(0, FIXED_LOOK_COUNT);

  const defaultGridClass = variant === 'home' ? DEFAULT_HOME_GRID_CLASS : DEFAULT_CATALOG_GRID_CLASS;
  const gridClassName = className ?? defaultGridClass;

  const renderGrid = () => (
    <div className={gridClassName}>
      {resolvedLooks.map((look) => {
        return <LookCard key={look.id} look={look} />;
      })}
    </div>
  );

  // home variant rendering
  if (variant === 'home') {
    return (
      <section id="look" className="px-6 lg:px-12 bg-white w-full pt-14 pb-[72px] md:pt-16 md:pb-[88px] lg:pt-20 lg:pb-[104px]">
        <div className="max-w-7xl mx-auto">
          <div className="text-left mb-10 md:mb-12">
            <h2 className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
              LOOK
            </h2>
          </div>

          {resolvedLooks.length === 0 ? (
            <div className="text-center py-12 text-[#474747] font-brand">公開中のLOOKがありません</div>
          ) : (
            <>
              {renderGrid()}
              {totalLookCount > FIXED_LOOK_COUNT && (
                <div className="text-center mt-12 lg:hidden">
                  <Button href="/look" variant="secondary" size="md" className="font-acumin">
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

  // catalog variant rendering
  return (
    <>
      {resolvedLooks.length === 0 ? (
        <div className="text-center py-12 text-[#474747] font-brand">公開中のLOOKがありません</div>
      ) : (
        renderGrid()
      )}
    </>
  );
}
