import Image from "next/image";
import HomeNewsSection from '@/app/components/HomeNewsSection';
import HomeItemsSection from '@/app/components/HomeItemsSection';
import { getLatestNews } from '@/app/actions/news';

export default async function Home() {
  const latestNews = await getLatestNews();

  return (
    <div className="min-h-screen font-sans">
      <main className="flex flex-col items-center gap-8">
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
        <HomeItemsSection />

        {/* LOOK セクション */}
        <section id="look" className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-16 lg:mb-24">
              <h2 className="text-4xl lg:text-5xl mb-4 text-black tracking-tight font-display">LOOK</h2>
              <div className="w-16 h-px bg-black mx-auto"></div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
              <div className="group cursor-pointer">
                <div className="relative overflow-hidden mb-4 aspect-[2/3]">
                  <Image
                    src="https://readdy.ai/api/search-image?query=Full%20body%20fashion%20editorial%20photography%20featuring%20minimalist%20neutral%20beige%20and%20grey%20outfit%20on%20model%20against%20clean%20white%20studio%20background%20with%20soft%20natural%20lighting%20showcasing%20contemporary%20modern%20styling%20with%20elegant%20silhouette%20and%20sophisticated%20draping%20in%20neutral%20color%20palette&width=800&height=1200&seq=look001&orientation=portrait"
                    alt="LOOK 01"
                    fill
                    unoptimized
                    className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                  />
                </div>
                <div className="text-center space-y-2">
                  <h3 className="text-lg text-black font-brand">LOOK 01</h3>
                  <p className="text-xs tracking-widest text-[#474747] font-brand">2024 S/S</p>
                </div>
              </div>

              <div className="group cursor-pointer">
                <div className="relative overflow-hidden mb-4 aspect-[2/3]">
                  <Image
                    src="https://readdy.ai/api/search-image?query=Full%20body%20fashion%20editorial%20photography%20featuring%20minimalist%20sand%20beige%20and%20white%20layered%20outfit%20on%20model%20against%20clean%20white%20studio%20background%20with%20soft%20natural%20lighting%20showcasing%20contemporary%20modern%20styling%20with%20flowing%20silhouette%20and%20elegant%20composition%20in%20neutral%20tones&width=800&height=1200&seq=look002&orientation=portrait"
                    alt="LOOK 02"
                    fill
                    unoptimized
                    className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                  />
                </div>
                <div className="text-center space-y-2">
                  <h3 className="text-lg text-black font-brand">LOOK 02</h3>
                  <p className="text-xs tracking-widest text-[#474747] font-brand">2024 S/S</p>
                </div>
              </div>

              <div className="group cursor-pointer">
                <div className="relative overflow-hidden mb-4 aspect-[2/3]">
                  <Image
                    src="https://readdy.ai/api/search-image?query=Full%20body%20fashion%20editorial%20photography%20featuring%20minimalist%20grey%20and%20black%20structured%20outfit%20on%20model%20against%20clean%20white%20studio%20background%20with%20soft%20natural%20lighting%20showcasing%20contemporary%20modern%20styling%20with%20tailored%20silhouette%20and%20sophisticated%20design%20in%20neutral%20color%20palette&width=800&height=1200&seq=look003&orientation=portrait"
                    alt="LOOK 03"
                    fill
                    unoptimized
                    className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                  />
                </div>
                <div className="text-center space-y-2">
                  <h3 className="text-lg text-black font-brand">LOOK 03</h3>
                  <p className="text-xs tracking-widest text-[#474747] font-brand">2024 S/S</p>
                </div>
              </div>

              <div className="group cursor-pointer">
                <div className="relative overflow-hidden mb-4 aspect-[2/3]">
                  <Image
                    src="https://readdy.ai/api/search-image?query=Full%20body%20fashion%20editorial%20photography%20featuring%20minimalist%20beige%20monochrome%20outfit%20on%20model%20against%20clean%20white%20studio%20background%20with%20soft%20natural%20lighting%20showcasing%20contemporary%20modern%20styling%20with%20elegant%20draping%20and%20sophisticated%20silhouette%20in%20neutral%20tones&width=800&height=1200&seq=look004&orientation=portrait"
                    alt="LOOK 04"
                    fill
                    unoptimized
                    className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                  />
                </div>
                <div className="text-center space-y-2">
                  <h3 className="text-lg text-black font-brand">LOOK 04</h3>
                  <p className="text-xs tracking-widest text-[#474747] font-brand">2024 S/S</p>
                </div>
              </div>
            </div>

            <div className="text-center mt-8">
              <a href="/viewer/readdy-nextjs-v1-prod/2871426bde5e68/look">
                <button className="px-12 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap font-brand">VIEW LOOKBOOK</button>
              </a>
            </div>
          </div>
        </section>

        {/* News セクション */}
        <HomeNewsSection initialNews={latestNews} />

        {/* ABOUT セクション */}
        <section id="about" className="py-24 lg:py-32 px-6 lg:px-12 bg-[#fafafa] w-full">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
              <div className="order-2 lg:order-1">
                <h2 className="text-4xl lg:text-5xl mb-8 text-black tracking-tight font-display">ABOUT</h2>
                <div className="w-16 h-px bg-black mb-8"></div>
                <div className="space-y-6 text-[#474747] font-brand">
                  <p className="text-base lg:text-lg leading-relaxed">Le Fil des Heuresは、「時を紡ぐニュートラルモードな日常着」をコンセプトに、2020年に東京で誕生したアパレルブランドです。</p>
                  <p className="text-base lg:text-lg leading-relaxed">時代を超えて愛される普遍的なデザインと、上質な素材選びにこだわり、日常に寄り添う洗練されたワードローブを提案しています。</p>
                  <p className="text-base lg:text-lg leading-relaxed">ミニマルでありながら、着る人の個性を引き立てる。そんな服作りを目指し、一着一着丁寧に仕上げています。</p>
                  <p className="text-base lg:text-lg leading-relaxed">シーズンごとに移り変わる時の流れの中で、変わらない価値を持つ服を。それが私たちの願いです。</p>
                </div>
                <div className="mt-12 grid grid-cols-2 gap-8">
                  <div>
                    <h3 className="text-sm tracking-widest text-black mb-3 font-brand">PHILOSOPHY</h3>
                    <p className="text-sm text-[#474747] leading-relaxed font-brand">時代を超える普遍的な美しさ</p>
                  </div>
                  <div>
                    <h3 className="text-sm tracking-widest text-black mb-3 font-brand">ESTABLISHED</h3>
                    <p className="text-sm text-[#474747] leading-relaxed font-brand">2020, Tokyo</p>
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
        <section id="stockist" className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-16 lg:mb-24">
              <h2 className="text-4xl lg:text-5xl mb-4 text-black tracking-tight font-display">STOCKIST</h2>
              <div className="w-16 h-px bg-black mx-auto"></div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 lg:gap-12">
              <div className="border border-[#d5d0c9] p-8 lg:p-10 hover:border-black transition-colors duration-300">
                <h3 className="text-xl lg:text-2xl mb-6 text-black font-brand">Le Fil des Heures Aoyama</h3>
                <div className="space-y-3 text-[#474747] font-brand">
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-map-pin-line text-lg"></i></div>
                    <p className="text-sm">東京都港区南青山3-14-8</p>
                  </div>
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-phone-line text-lg"></i></div>
                    <p className="text-sm">03-1234-5678</p>
                  </div>
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-time-line text-lg"></i></div>
                    <div className="text-sm">
                      <p>11:00 - 20:00</p>
                      <p className="text-xs mt-1">水曜定休</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border border-[#d5d0c9] p-8 lg:p-10 hover:border-black transition-colors duration-300">
                <h3 className="text-xl lg:text-2xl mb-6 text-black font-brand">Le Fil des Heures Ginza</h3>
                <div className="space-y-3 text-[#474747] font-brand">
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-map-pin-line text-lg"></i></div>
                    <p className="text-sm">東京都中央区銀座6-10-1</p>
                  </div>
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-phone-line text-lg"></i></div>
                    <p className="text-sm">03-2345-6789</p>
                  </div>
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-time-line text-lg"></i></div>
                    <div className="text-sm">
                      <p>11:00 - 20:00</p>
                      <p className="text-xs mt-1">不定休</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border border-[#d5d0c9] p-8 lg:p-10 hover:border-black transition-colors duration-300">
                <h3 className="text-xl lg:text-2xl mb-6 text-black font-brand">Le Fil des Heures Kyoto</h3>
                <div className="space-y-3 text-[#474747] font-brand">
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-map-pin-line text-lg"></i></div>
                    <p className="text-sm">京都府京都市中京区烏丸通三条上ル</p>
                  </div>
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-phone-line text-lg"></i></div>
                    <p className="text-sm">075-123-4567</p>
                  </div>
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-time-line text-lg"></i></div>
                    <div className="text-sm">
                      <p>11:00 - 19:00</p>
                      <p className="text-xs mt-1">水曜定休</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border border-[#d5d0c9] p-8 lg:p-10 hover:border-black transition-colors duration-300">
                <h3 className="text-xl lg:text-2xl mb-6 text-black font-brand">Le Fil des Heures Osaka</h3>
                <div className="space-y-3 text-[#474747] font-brand">
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-map-pin-line text-lg"></i></div>
                    <p className="text-sm">大阪府大阪市北区梅田2-5-25</p>
                  </div>
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-phone-line text-lg"></i></div>
                    <p className="text-sm">06-1234-5678</p>
                  </div>
                  <div className="flex items-start">
                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0 mr-3"><i className="ri-time-line text-lg"></i></div>
                    <div className="text-sm">
                      <p>11:00 - 20:00</p>
                      <p className="text-xs mt-1">不定休</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-16 lg:mt-24">
              <div className="aspect-[16/9] lg:aspect-[21/9] w-full">
                <iframe
                  src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3241.2479707857677!2d139.71433831525895!3d35.66572098019819!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x60188b835e2c0d0f%3A0x3c6c8e8e8e8e8e8e!2z5p2x5Lqs6YO95riv5Yy65Y2X6Z2S5bGx!5e0!3m2!1sja!2sjp!4v1234567890123!5m2!1sja!2sjp"
                  width="100%"
                  height="100%"
                  className="border-0"
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}