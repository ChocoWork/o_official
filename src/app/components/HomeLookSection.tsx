import { getPublishedLooks } from '@/lib/look/public';
import { Button } from '@/app/components/ui/Button';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';

export default async function HomeLookSection() {
  const looks = await getPublishedLooks(4);

  return (
    <section id="look" className="lg:py-32 px-6 lg:px-12 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16 lg:mb-24">
          <h2 className="text-4xl lg:text-5xl mb-4 text-black tracking-tight font-display">LOOK</h2>
          <div className="w-16 h-px bg-black mx-auto"></div>
        </div>

        {looks.length === 0 ? (
          <div className="text-center py-8 text-[#474747] font-brand">公開中のLOOKがありません</div>
        ) : (
          <>
            <PublicLookGrid
              looks={looks}
              variant="home"
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8"
            />

            <div className="text-center mt-8">
              <Button href="/look" variant="secondary" size="md" className="font-brand">VIEW LOOKBOOK</Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
