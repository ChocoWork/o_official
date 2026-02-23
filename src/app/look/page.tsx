import Image from 'next/image';
import Link from 'next/link';
import { formatLookSeason, getPublishedLooks } from '@/lib/look/public';

export default async function LookPage() {
    const looks = await getPublishedLooks();

    return (
        <main className="pt-32 pb-20 px-6 lg:px-12">
            <div className="max-w-7xl mx-auto">
                {looks.length === 0 ? (
                    <div className="text-center py-12 text-[#474747] font-brand">公開中のLOOKがありません</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12">
                        {looks.map((look) => (
                            <div key={look.id}>
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
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
}
