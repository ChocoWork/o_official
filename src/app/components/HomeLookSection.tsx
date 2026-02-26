import Image from 'next/image';
import Link from 'next/link';
import { formatLookSeason, getPublishedLooks } from '@/lib/look/public';
import { LinkButton } from '@/app/components/ui/LinkButton';

export default async function HomeLookSection() {
  const looks = await getPublishedLooks(4);

  return (
    <section id="look" className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16 lg:mb-24">
          <h2 className="text-4xl lg:text-5xl mb-4 text-black tracking-tight font-display">LOOK</h2>
          <div className="w-16 h-px bg-black mx-auto"></div>
        </div>

        {looks.length === 0 ? (
          <div className="text-center py-8 text-[#474747] font-brand">公開中のLOOKがありません</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
              {looks.map((look, index) => (
                <Link key={look.id} href={`/look/${look.id}`} className="group cursor-pointer">
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
              ))}
            </div>

            <div className="text-center mt-8">
              <LinkButton href="/look" size="lg" className="font-brand">VIEW LOOKBOOK</LinkButton>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
