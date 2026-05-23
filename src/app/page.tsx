import type { Metadata } from "next";
import Image from "next/image";
import ReactDOM from "react-dom";
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';
import { SearchHomePreview } from '@/features/search/components/SearchHomePreview';
import { SectionTitle } from '@/components/ui/SectionTitle/SectionTitle';
import { getPublishedItems } from '@/lib/items/public';
import { getPublishedLooks } from '@/lib/look/server';
import { getPublishedNews } from '@/features/news/services/public';

const HOME_LOOK_FETCH_COUNT = 7;

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'Le Fil des Heures',
    description: 'Le Fil des Heuresの公式オンラインストア。時を紡ぐニュートラルモードな日常着を提案します。',
    openGraph: {
      title: 'Le Fil des Heures',
      description: 'Le Fil des Heuresの公式オンラインストア。時を紡ぐニュートラルモードな日常着を提案します。',
      images: ['/mainphoto.png'],
    },
  };
}

export default async function Home() {
  const [homeItems, homeLooks, homeNews] = await Promise.all([
    getPublishedItems(9),
    getPublishedLooks(HOME_LOOK_FETCH_COUNT),
    getPublishedNews({ limit: 6 }),
  ]);

  ReactDOM.preload('/mainphoto.png', {
    as: 'image',
  });

  return (
    <div className="min-h-screen w-full">
      <div className="flex flex-col w-full items-stretch">
        {/* メイン画像セクション */}
        <section className="relative min-h-screen w-full flex items-center justify-center bg-white pt-20">
          <div className="absolute inset-0 overflow-hidden">
            <Image
              src="/mainphoto.png"
              alt="Hero Background"
              width={2752} // ←mainphoto.pngの実際の横幅に合わせて調整してください
              height={1536} // ←mainphoto.pngの実際の縦幅に合わせて調整してください
              priority
              sizes="100vw"
              className="image opacity-90"
            />
            <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/60" />
          </div>
          <div className="relative z-10 text-center px-6 max-w-4xl mx-auto">
            <h1 className="text-[22px] sm:text-[26px] md:text-[28px] lg:text-[32px] xl:text-[34px] mb-[13px] sm:mb-[16px] md:mb-[21px] tracking-tight text-white" style={{ fontFamily: 'Didot, serif' }}>
              Le Fil des Heures
            </h1>
          </div>
        </section>

        <SearchHomePreview />

        {/* Item セクション */}
        <PublicItemGrid variant="home" items={homeItems} />

        {/* Look セクション */}
        <PublicLookGrid variant="home" looks={homeLooks} />

        {/* News セクション */}
        <PublicNewsGrid variant="home" articles={homeNews} />

        {/* ABOUT セクション */}
        <section id="about" className="section-space-about">
          <div className="element-width">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-[21px] sm:gap-[26px] md:gap-[34px] lg:gap-[55px] items-center">
              <div className="order-2 md:order-1">
                <SectionTitle title="ABOUT" />
                <div className="about-main-space">
                  <p className="about-main-text">Le Fil des Heuresは、「時を紡ぐニュートラルモードな日常着」をコンセプトに、2026年に日本の宮城県で誕生したアパレルブランドです。</p>
                  <p className="about-main-text">時代を超えて愛される普遂的なデザインと、素材選びにこだわり、日常に寄り添う洗練されたワードローブを提案しています。</p>
                  <p className="about-main-text">ミニマルでありながら、着る人の個性を引き立てる。そんな服作りを目指し、一着一着丁寧に仕上げています。</p>
                  <p className="about-main-text">移り変わる時の流れの中で、変わらない価値を持つ服を、永く使用していただく。それが願いです。</p>
                </div>
                <div className="mt-[21px] sm:mt-[26px] md:mt-[34px] grid grid-cols-2 gap-[13px] sm:gap-[16px] md:gap-[21px]">
                  <div>
                    <h3 className="about-secondary-title font-brand">PHILOSOPHY</h3>
                    <p className="about-secondary-text">Timeless Design</p>
                  </div>
                  <div>
                    <h3 className="about-secondary-title font-brand">ESTABLISHED</h3>
                    <p className="about-secondary-text">2026, Miyagi in Japan</p>
                  </div>
                </div>
              </div>

              <div className="order-1 md:order-2">
                <div className="relative aspect-[3/4] overflow-hidden">
                  <Image
                    src="/about.png"
                    alt="About Le Fil des Heures"
                    fill
                    unoptimized
                    className="image"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* STOCKIST セクション */}
        <PublicStockistGrid variant="home" />
      </div>
    </div>
  );
}