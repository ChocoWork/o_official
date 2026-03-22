import Image from 'next/image';
import Link from 'next/link';
import { PublicLook, formatLookSeason } from '@/lib/look/public';

type PublicLookGridVariant = 'home' | 'catalog';

type PublicLookGridProps = {
  looks: PublicLook[];
  variant: PublicLookGridVariant;
  className?: string;
  mobileLimit?: number;
};

export function PublicLookGrid({ looks, variant, className, mobileLimit }: PublicLookGridProps) {
  const gridClassName = className ?? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12';

  return (
    <div className={gridClassName}>
      {looks.map((look, index) => {
        const mobileLimitClassName =
          mobileLimit !== undefined && index >= mobileLimit ? 'hidden lg:block' : undefined;

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
}
