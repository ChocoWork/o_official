import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/app/components/ui/Button';
import { PublicLook, formatLookSeason, getPublishedLooks } from '@/lib/look/public';

const DEFAULT_HOME_GRID_CLASS = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8';
const DEFAULT_CATALOG_GRID_CLASS = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12';

type PublicLookGridHomeProps = {
  variant: 'home';
  looks?: PublicLook[];
  /** データを自己フェッチする際の上限。未指定時は 8 */
  fetchLimit?: number;
  /** モバイルで非表示にする閾値。未指定時は 6 */
  mobileLimit?: number;
  className?: string;
};

type PublicLookGridCatalogProps = {
  variant: 'catalog';
  looks?: PublicLook[];
  className?: string;
  mobileLimit?: number;
};

type PublicLookGridProps = PublicLookGridHomeProps | PublicLookGridCatalogProps;

export async function PublicLookGrid(props: PublicLookGridProps) {
  const { variant, className, mobileLimit } = props;

  const fetchLimit = variant === 'home' ? (props.fetchLimit ?? 8) : undefined;
  const resolvedLooks = props.looks ?? await getPublishedLooks(fetchLimit);

  const defaultGridClass = variant === 'home' ? DEFAULT_HOME_GRID_CLASS : DEFAULT_CATALOG_GRID_CLASS;
  const gridClassName = className ?? defaultGridClass;

  const resolvedMobileLimit = variant === 'home' ? (mobileLimit ?? 6) : mobileLimit;
  const shouldLimitOnMobile = typeof resolvedMobileLimit === 'number';

  const renderGrid = () => (
    <div className={gridClassName}>
      {resolvedLooks.map((look, index) => {
        const hideOnMobile = shouldLimitOnMobile && index >= resolvedMobileLimit!;
        const mobileLimitClassName = hideOnMobile ? 'hidden lg:block' : undefined;

        if (variant === 'home') {
          return (
            <Link
              key={look.id}
              href={`/look/${look.id}`}
              className={['group cursor-pointer', mobileLimitClassName].filter(Boolean).join(' ')}
            >
              <div className="relative overflow-hidden mb-4 aspect-[2/3]">
                <Image
                  src={look.imageUrls[0] || '/placeholder.png'}
                  alt={`LOOK ${index + 1}`}
                  fill
                  unoptimized
                  className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                />
              </div>
              <div className="text-center space-y-2">
                <h3 className="text-lg text-black font-brand">{look.theme}</h3>
                <p className="text-xs tracking-widest text-[#474747] font-brand">
                  {formatLookSeason(look.seasonYear, look.seasonType)}
                </p>
              </div>
            </Link>
          );
        }

        return (
          <div key={look.id} className={mobileLimitClassName}>
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
            <div className="space-y-3">
              <p className="text-xs text-[#474747] tracking-widest font-brand">
                {formatLookSeason(look.seasonYear, look.seasonType)}
              </p>
              <Link href={`/look/${look.id}`}>
                <p className="text-sm text-black font-brand hover:text-[#474747] transition-colors">{look.theme}</p>
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
      })}
    </div>
  );

  // home variant rendering
  if (variant === 'home') {
    return (
      <section id="look" className="lg:py-32 px-6 bg-white w-full">
        <div className="max-w-7xl mx-auto">
          <div className="text-left mb-8">
            <h2 className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
              LOOK
            </h2>
          </div>

          {resolvedLooks.length === 0 ? (
            <div className="text-center py-8 text-[#474747] font-brand">公開中のLOOKがありません</div>
          ) : (
            <>
              {renderGrid()}
              {shouldLimitOnMobile && resolvedLooks.length > resolvedMobileLimit! && (
                <div className="text-center mt-10 lg:hidden">
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
