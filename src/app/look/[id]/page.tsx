import type { Metadata } from 'next';
import Link from 'next/link';
import { formatLookSeason } from '@/lib/look/public';
import { getPublishedLookById, getPublishedLooks } from '@/lib/look/server';
import { List } from '@/components/ui/List/List';
import { LookImageGallery } from '@/features/look/components/LookImageGallery';

type Props = {
    params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { id } = await params;
    const lookId = Number(id);
    const look = Number.isNaN(lookId) ? null : await getPublishedLookById(lookId);

    if (!look) {
        return {
            title: 'Look not found | Le Fil des Heures',
            description: '指定されたルックは見つかりませんでした。',
        };
    }

    const title = `${look.theme} | LOOK | Le Fil des Heures`;
    const description = look.themeDescription || `${look.theme} のスタイリング詳細ページ`;

    return {
        title,
        description,
        openGraph: {
            title,
            description,
            images: look.imageUrls.length > 0 ? [{ url: look.imageUrls[0] }] : [],
        },
    };
}

export default async function LookDetailPage({ params }: Props) {
  const { id } = await params;
  const lookId = Number(id);
  const looks = await getPublishedLooks();
  const currentIndex = looks.findIndex((look) => look.id === lookId);

  if (currentIndex < 0) {
    return (
      <div>
        <div className="element-width text-center">
          <h1>Look not found</h1>
          <Link href="/look" className="text-[#474747] hover:text-black mt-4 inline-block" style={{ fontSize: 'var(--lk-size-xs)' }}>
            Back to Lookbook
          </Link>
        </div>
      </div>
    );
  }

  const currentLook = looks[currentIndex];
  const prevLook = currentIndex > 0 ? looks[currentIndex - 1] : null;
  const nextLook = currentIndex < looks.length - 1 ? looks[currentIndex + 1] : null;
  const seasonLabel = formatLookSeason(currentLook.seasonYear, currentLook.seasonType);
  const currencyFormatter = new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  });

    return (
        <div>
            <div className="element-width">
                <div className="mb-[21px]">
                    <Link href="/look" className="text-[#474747] hover:text-black inline-block" style={{ fontSize: 'var(--lk-size-xs)' }} aria-label="Back to Lookbook">
                        Back to Lookbook
                    </Link>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-[34px] lg:gap-[55px]">
                    <div className="space-y-[13px]">
                        <LookImageGallery theme={currentLook.theme} imageUrls={currentLook.imageUrls} />
                    </div>

                    <div className="lg:pt-[34px] space-y-[34px]">
                        <div>
                            <p className="text-[#474747] tracking-widest mb-[13px]" style={{ fontSize: 'var(--lk-size-xs)' }}>
                                {seasonLabel}
                            </p>
                            <h1 className="mb-[13px]" style={{ fontSize: 'var(--lk-size-3xl)' }}>
                                {currentLook.theme}
                            </h1>
                        </div>

                        <div className="border-t border-[#d5d0c9] pt-[34px]">
                            <p className="text-[#474747] leading-[2]" style={{ fontSize: 'var(--lk-size-md)' }}>
                                {currentLook.themeDescription || ' '}
                            </p>
                        </div>

                        <div className="border-t border-[#d5d0c9] pt-[34px]">
                            <h3 className="text-black tracking-widest mb-[21px] font-brand" style={{ fontSize: 'var(--lk-size-lg)' }}>
                                STYLING ITEMS
                            </h3>
                            {currentLook.linkedItems.length === 0 ? (
                                <p className="text-[#474747]" style={{ fontSize: 'var(--lk-size-sm)' }}>
                                    紐づけ商品はありません
                                </p>
                            ) : (
                                <List<(typeof currentLook.linkedItems)[number]>
                                    items={currentLook.linkedItems}
                                    itemKey={(item) => String(item.id)}
                                    className="space-y-px border border-black/20"
                                    variant="showcase"
                                    getName={(item) => item.name}
                                    getCategory={(item) => item.category}
                                    getPrice={(item) => currencyFormatter.format(item.price)}
                                    getImage={(item) => item.imageUrl}
                                    getHref={(item) => `/item/${item.id}`}
                                    size="xs"
                                />
                            )}
                        </div>

                        <div className="flex items-center justify-between pt-[13px]">
                            {prevLook ? (
                                <Link href={`/look/${prevLook.id}`} aria-label={`Previous look: ${prevLook.theme}`} className="group flex items-center space-x-[13px] cursor-pointer">
                                    <i className="ri-arrow-left-line w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors"></i>
                                    <div>
                                        <p className="text-[#999] tracking-widest" style={{ fontSize: 'var(--lk-size-xs)' }}>
                                            PREV
                                        </p>
                                        <p className="text-[#474747] group-hover:text-black transition-colors" style={{ fontSize: 'var(--lk-size-md)' }}>
                                            {prevLook.theme}
                                        </p>
                                    </div>
                                </Link>
                            ) : (
                                <div />
                            )}
                            {nextLook ? (
                                <Link href={`/look/${nextLook.id}`} aria-label={`Next look: ${nextLook.theme}`} className="group flex items-center space-x-[13px] cursor-pointer text-right">
                                    <div>
                                        <p className="text-[#999] tracking-widest" style={{ fontSize: 'var(--lk-size-xs)' }}>
                                            NEXT
                                        </p>
                                        <p className="text-[#474747] group-hover:text-black transition-colors" style={{ fontSize: 'var(--lk-size-md)' }}>
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
        </div>
    );
}
