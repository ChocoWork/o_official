import Link from 'next/link';
import Image from 'next/image';
import { formatLookSeason, getPublishedLooks } from '@/lib/look/public';

export default async function LookDetailPage({ params }: { params: { id: string } }) {
  const lookId = Number(params.id);
  const looks = await getPublishedLooks();
  const currentIndex = looks.findIndex((look) => look.id === lookId);

  if (currentIndex < 0) {
    return (
      <main className="pt-32 pb-20 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto text-center">
          <h1 className="text-2xl font-brand text-black">Look not found</h1>
          <Link href="/look" className="text-sm text-[#474747] hover:text-black mt-4 inline-block">
            Back to Lookbook
          </Link>
        </div>
      </main>
    );
  }

  const currentLook = looks[currentIndex];
  const prevLook = currentIndex > 0 ? looks[currentIndex - 1] : null;
  const nextLook = currentIndex < looks.length - 1 ? looks[currentIndex + 1] : null;
  const mainImage = currentLook.imageUrls[0] || '/placeholder.png';
  const seasonLabel = formatLookSeason(currentLook.seasonYear, currentLook.seasonType);
  const currencyFormatter = new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  });

    return (
        <main className="pt-32 pb-20 px-6 lg:px-12">
            <div className="max-w-7xl mx-auto">
                <Link
                    href="/look"
                    className="flex items-center space-x-2 text-sm text-[#474747] mb-12 hover:text-black transition-colors duration-300"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
                >
                    <i className="ri-arrow-left-line w-4 h-4 flex items-center justify-center"></i>
                    <span className="tracking-widest">BACK TO LOOKBOOK</span>
                </Link>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20">
                    <div className="space-y-4">
                        <div className="w-full aspect-[3/4] bg-[#f5f5f5] overflow-hidden relative">
                            <Image src={mainImage} alt={currentLook.theme} fill className="w-full h-full object-cover object-top" unoptimized />
                        </div>
                    </div>

                    <div className="lg:pt-8 space-y-10">
                        <div>
                            <p className="text-xs text-[#474747] tracking-widest mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                {seasonLabel}
                            </p>
                            <h1 className="text-4xl lg:text-5xl text-black mb-3" style={{ fontFamily: 'Didot, serif' }}>
                                {currentLook.theme}
                            </h1>
                        </div>

                        <div className="border-t border-[#d5d0c9] pt-8">
                            <p className="text-sm text-[#474747] leading-[2]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                {currentLook.themeDescription || ' '}
                            </p>
                        </div>

                        <div className="border-t border-[#d5d0c9] pt-8">
                            <h3 className="text-xs text-black tracking-widest mb-6" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                STYLING ITEMS
                            </h3>
                            <div className="space-y-4">
                                {currentLook.linkedItems.length === 0 ? (
                                    <p className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                        紐づけ商品はありません
                                    </p>
                                ) : (
                                    currentLook.linkedItems.map((item) => (
                                        <div key={item.id} className="flex items-center justify-between py-3 border-b border-[#f0ede8]">
                                            <span className="text-sm text-black tracking-wide" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                                {item.name}
                                            </span>
                                            <span className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                                {currencyFormatter.format(item.price)}
                                            </span>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        <div className="flex items-center justify-between pt-4">
                            {prevLook ? (
                                <Link href={`/look/${prevLook.id}`} className="group flex items-center space-x-3 cursor-pointer">
                                    <i className="ri-arrow-left-line w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors"></i>
                                    <div>
                                        <p className="text-xs text-[#999] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            PREV
                                        </p>
                                        <p className="text-sm text-[#474747] group-hover:text-black transition-colors" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            {prevLook.theme}
                                        </p>
                                    </div>
                                </Link>
                            ) : (
                                <div />
                            )}
                            {nextLook ? (
                                <Link href={`/look/${nextLook.id}`} className="group flex items-center space-x-3 cursor-pointer text-right">
                                    <div>
                                        <p className="text-xs text-[#999] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            NEXT
                                        </p>
                                        <p className="text-sm text-[#474747] group-hover:text-black transition-colors" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            {nextLook.theme}
                                        </p>
                                    </div>
                                    <i className="ri-arrow-right-line w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors"></i>
                                </Link>
                            ) : (
                                <div />
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
