import Image from "next/image";
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';

export default async function Home() {
  return (
    <div className="min-h-screen font-sans">
      <main className="flex flex-col items-center">
        {/* メイン画像セクション */}
        <section className="relative min-h-screen w-full flex items-center justify-center bg-white pt-20">
          <div className="flex h-full w-full">
            <div className="h-screen min-h-[400px] relative flex items-center justify-center">
              <Image
                src="/original.jpg"
                alt="main photo"
                width={1024} // ←original.jpgの実際の横幅に合わせて調整してください
                height={1536} // ←original.jpgの実際の縦幅に合わせて調整してください
                className="h-full object-contain object-left opacity-90"
                priority
              />
              <div className="absolute inset-0 bg-gradient-to-b from-white/40 via-transparent to-white/60"></div>
            </div>
            <div className="h-full flex-1 flex items-center justify-center relative z-10 min-w-0">
              <div className="h-screen text-center px-6 max-w-4xl w-full mx-auto flex flex-col justify-center">
                <div className="text-3xl md:text-4xl lg:text-5xl mb-8 text-black tracking-tight w-full font-display">26SS Theme 「Black Rose」</div>
                <div className="text-lg md:text-3xl lg:text-4xl text-[#474747] tracking-widest max-w-2xl mx-auto leading-relaxed font-brand">出発 × 永遠</div>
              </div>
            </div>
          </div>
        </section>

        {/* Item セクション */}
        <PublicItemGrid variant="home" />

        {/* Look セクション */}
        <PublicLookGrid variant="home" />

        {/* News セクション */}
        <PublicNewsGrid variant="home" />

        {/* ABOUT セクション */}
        <section id="about" className="py-24 lg:py-32 px-6 lg:px-12 bg-[#fafafa] w-full">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
              <div className="order-2 lg:order-1">
                <div className="text-left mb-10 md:mb-12">
                  <h2 className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
                    STOCKIST
                  </h2>
                </div>
                <div className="space-y-6 text-[#474747] font-brand">
                  <p className="text-base lg:text-lg leading-relaxed">Le Fil des Heuresは、「時を紡ぐニュートラルモードな日常着」をコンセプトに、2026年に日本の宮城県で誕生したアパレルブランドです。</p>
                  <p className="text-base lg:text-lg leading-relaxed">時代を超えて愛される普遍的なデザインと、素材選びにこだわり、日常に寄り添う洗練されたワードローブを提案しています。</p>
                  <p className="text-base lg:text-lg leading-relaxed">ミニマルでありながら、着る人の個性を引き立てる。そんな服作りを目指し、一着一着丁寧に仕上げています。</p>
                  <p className="text-base lg:text-lg leading-relaxed">移り変わる時の流れの中で、変わらない価値を持つ服を、永く使用していただく。それが願いです。</p>
                </div>
                <div className="mt-12 grid grid-cols-2 gap-8">
                  <div>
                    <h3 className="text-sm tracking-widest text-black mb-3 font-brand">PHILOSOPHY</h3>
                    <p className="text-sm text-[#474747] leading-relaxed font-brand">時代を超えた普遍的な美しさ</p>
                  </div>
                  <div>
                    <h3 className="text-sm tracking-widest text-black mb-3 font-brand">ESTABLISHED</h3>
                    <p className="text-sm text-[#474747] leading-relaxed font-brand">2026, Miyagi in Japan</p>
                  </div>
                </div>
              </div>

              <div className="order-1 lg:order-2">
                <div className="relative aspect-[3/4] overflow-hidden">
                  <Image
                    src="https://readdy.ai/api/search-image?query=Minimalist%20fashion%20brand%20atelier%20studio%20interior%20with%20neutral%20beige%20and%20grey%20tones%20featuring%20clean%20white%20walls%20elegant%20fabric%20samples%20hanging%20on%20simple%20racks%20natural%20lighting%20through%20large%20windows%20contemporary%20workspace%20with%20sophisticated%20design%20elements%20and%20architectural%20details%20showcasing%20modern%20fashion%20design%20environment&width=800&height=1000&seq=about001&orientation=portrait"
                    alt="About Le Fil des Heures"
                    fill
                    unoptimized
                    className="w-full h-full object-cover object-center"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* STOCKIST セクション */}
        <PublicStockistGrid variant="home" />
      </main>
    </div>
  );
}