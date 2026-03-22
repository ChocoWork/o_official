import { getPublishedLooks } from '@/lib/look/public';
import { Button } from '@/app/components/ui/Button';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';

type HomeLookSectionProps = {
  limit?: number;
};

export default async function HomeLookSection({ limit = 6 }: HomeLookSectionProps) {
  const looks = await getPublishedLooks(8);

  return (
    <section id="look" className="lg:py-32 px-6 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-left mb-8">
          <h2 className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
            LOOK
          </h2>
        </div>

        {looks.length === 0 ? (
          <div className="text-center py-8 text-[#474747] font-brand">公開中のLOOKがありません</div>
        ) : (
          <>
            <PublicLookGrid
              looks={looks}
              variant="home"
              mobileLimit={limit}
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8"
            />

            {looks.length > limit && (
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
