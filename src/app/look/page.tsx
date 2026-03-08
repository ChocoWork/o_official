import { getPublishedLooks } from '@/lib/look/public';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';

export default async function LookPage() {
    const looks = await getPublishedLooks();

    return (
        <main className="pt-32 pb-20 px-6 lg:px-12">
            <div className="max-w-7xl mx-auto">
                {looks.length === 0 ? (
                    <div className="text-center py-12 text-[#474747] font-brand">公開中のLOOKがありません</div>
                ) : (
                    <PublicLookGrid looks={looks} variant="catalog" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12" />
                )}
            </div>
        </main>
    );
}
