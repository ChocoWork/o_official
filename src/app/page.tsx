'use client';

import Link from 'next/link';
import Image from "next/image";
import { useEffect, useState } from 'react';
import { Item } from '@/app/types/item';

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchItems = async () => {
      try {
        const response = await fetch('/api/items');
        if (!response.ok) {
          throw new Error('Failed to fetch items');
        }
        const data: Item[] = await response.json();
        setItems(data);
      } catch (err) {
        setError('商品データの取得に失敗しました');
        console.error('Failed to fetch items:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchItems();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl">商品データを読み込み中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xl text-red-500">{error}</div>
      </div>
    );
  }

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
                <div className="text-3xl md:text-4xl lg:text-5xl mb-8 text-black tracking-tight w-full" style={{ fontFamily: 'Didot, serif' }}>26SS Theme 「Black Rose」</div>
                <div className="text-lg md:text-3xl lg:text-4xl text-[#474747] tracking-widest max-w-2xl mx-auto leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>出発 × 永遠</div>
              </div>
            </div>
          </div>
        </section>

        {/* News セクション */}
        <section id="news" className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-16 lg:mb-24">
              <h2 className="text-4xl lg:text-5xl mb-4 text-black tracking-tight" style={{ fontFamily: 'Didot, serif' }}>NEWS</h2>
              <div className="w-16 h-px bg-black mx-auto"></div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 lg:gap-12">
              <a href="/viewer/readdy-nextjs-v1-prod/2874d3eb57d938/news/1">
                <article className="group cursor-pointer">
                  <div className="relative overflow-hidden mb-6 aspect-[4/3]">
                    <Image
                      src="/news1.png"
                      alt="2024 Spring/Summer Collection Launch"
                      fill
                      unoptimized
                      className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                      sizes="(max-width: 1024px) 100vw, 33vw"
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center space-x-4 text-xs tracking-widest text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      <span>2024.03.15</span>
                      <span className="w-1 h-1 bg-[#474747] rounded-full"></span>
                      <span>COLLECTION</span>
                    </div>
                    <h3 className="text-xl text-black group-hover:text-[#474747] transition-colors duration-300" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2024 Spring/Summer Collection Launch</h3>
                    <p className="text-sm text-[#474747] leading-relaxed line-clamp-3" style={{ fontFamily: 'acumin-pro, sans-serif' }}>新しいシーズンコレクションが登場。ミニマルなデザインと上質な素材が織りなす、洗練された日常着をご覧ください。</p>
                  </div>
                </article>
              </a>
              <a href="/viewer/readdy-nextjs-v1-prod/2874d3eb57d938/news/2">
                <article className="group cursor-pointer">
                  <div className="relative overflow-hidden mb-6 aspect-[4/3]">
                    <Image
                      src="/news2.png"
                      alt="Pop-up Store in Tokyo"
                      fill
                      unoptimized
                      className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                      sizes="(max-width: 1024px) 100vw, 33vw"
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center space-x-4 text-xs tracking-widest text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      <span>2024.03.08</span>
                      <span className="w-1 h-1 bg-[#474747] rounded-full"></span>
                      <span>EVENT</span>
                    </div>
                    <h3 className="text-xl text-black group-hover:text-[#474747] transition-colors duration-300" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Pop-up Store in Tokyo</h3>
                    <p className="text-sm text-[#474747] leading-relaxed line-clamp-3" style={{ fontFamily: 'acumin-pro, sans-serif' }}>東京・青山にて期間限定ポップアップストアを開催。最新コレクションを実際に手に取ってご覧いただけます。</p>
                  </div>
                </article>
              </a>
              <a href="/viewer/readdy-nextjs-v1-prod/2874d3eb57d938/news/3">
                <article className="group cursor-pointer">
                  <div className="relative overflow-hidden mb-6 aspect-[4/3]">
                    <Image
                      src="/news3.png"
                      alt="Artist Collaboration Series"
                      fill
                      unoptimized
                      className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                      sizes="(max-width: 1024px) 100vw, 33vw"
                    />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center space-x-4 text-xs tracking-widest text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      <span>2024.02.28</span>
                      <span className="w-1 h-1 bg-[#474747] rounded-full"></span>
                      <span>COLLABORATION</span>
                    </div>
                    <h3 className="text-xl text-black group-hover:text-[#474747] transition-colors duration-300" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Artist Collaboration Series</h3>
                    <p className="text-sm text-[#474747] leading-relaxed line-clamp-3" style={{ fontFamily: 'acumin-pro, sans-serif' }}>気鋭のアーティストとのコラボレーションアイテムが登場。アートとファッションが融合した特別なコレクションです。</p>
                  </div>
                </article>
              </a>
            </div>
            <div className="text-center mt-16">
              <a href="/viewer/readdy-nextjs-v1-prod/2874d3eb57d938/news">
                <button className="px-12 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap" style={{ fontFamily: 'acumin-pro, sans-serif' }}>VIEW ALL NEWS</button>
              </a>
            </div>
          </div>
        </section>


        {/* Item セクション */}
        <section className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
          <div className="max-w-7xl mx-auto">
            {/* カラムを減らして画像幅を大きく、間隔も広めに */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-12">
              <Link href="/item/1">
                <div className="group cursor-pointer">
                  {/* アスペクト比を指定して横切れを防ぐ */}
                  <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                    <Image
                      src="https://readdy.ai/api/search-image?query=Minimalist%20black%20wool%20coat%20on%20neutral%20beige%20background%20with%20clean%20lines%20and%20elegant%20silhouette%20showcasing%20timeless%20design%20and%20premium%20quality%20fabric%20texture%20in%20professional%20product%20photography&width=600&height=800&seq=item001&orientation=portrait"
                      alt="Minimal Wool Coat"
                      fill
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                      unoptimized
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OUTERWEAR</p>
                    <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Minimal Wool Coat</h3>
                    <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥89,000</p>
                  </div>
                </div>
              </Link>
              <Link href="/item/2">
                <div className="group cursor-pointer">
                  <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                    <Image
                      src="https://readdy.ai/api/search-image?query=Elegant%20grey%20wide%20leg%20trousers%20displayed%20on%20white%20background%20with%20minimalist%20styling%20soft%20natural%20lighting%20highlighting%20the%20fabric%20drape%20and%20tailored%20silhouette%20in%20neutral%20tones%20showcasing%20contemporary%20fashion%20with%20clean%20simple%20presentation%20and%20subtle%20texture%20details&width=600&height=800&seq=item002&orientation=portrait"
                      alt="Wide Leg Trousers"
                      fill
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                      unoptimized
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BOTTOMS</p>
                    <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Wide Leg Trousers</h3>
                    <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥32,000</p>
                  </div>
                </div>
              </Link>
              <Link href="/item/3">
                <div className="group cursor-pointer">
                  <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                    <Image
                      src="https://readdy.ai/api/search-image?query=Sophisticated%20sand%20beige%20oversized%20coat%20hanging%20on%20minimal%20white%20background%20with%20soft%20studio%20lighting%20emphasizing%20the%20luxurious%20fabric%20texture%20and%20elegant%20draping%20in%20neutral%20tones%20with%20contemporary%20minimalist%20fashion%20photography%20style%20and%20clean%20architectural%20composition&width=600&height=800&seq=item003&orientation=portrait"
                      alt="Oversized Coat"
                      fill
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                      unoptimized
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OUTERWEAR</p>
                    <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Oversized Coat</h3>
                    <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥68,000</p>
                  </div>
                </div>
              </Link>
              <Link href="/item/4">
                <div className="group cursor-pointer">
                  <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                    <Image
                      src="https://readdy.ai/api/search-image?query=Minimalist%20grey%20cotton%20knit%20sweater%20folded%20neatly%20on%20pure%20white%20surface%20with%20soft%20natural%20lighting%20highlighting%20the%20knit%20texture%20and%20simple%20elegant%20design%20in%20neutral%20tones%20with%20contemporary%20fashion%20photography%20style%20and%20subtle%20shadows%20creating%20depth&width=600&height=800&seq=item004&orientation=portrait"
                      alt="Cotton Knit Sweater"
                      fill
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                      unoptimized
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>TOPS</p>
                    <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Cotton Knit Sweater</h3>
                    <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥24,000</p>
                  </div>
                </div>
              </Link>
              <a href="/viewer/readdy-nextjs-v1-prod/8ed5d1f76d3598/item/5">
                <div className="group cursor-pointer">
                  <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                    <Image
                      src="https://readdy.ai/api/search-image?query=Elegant%20beige%20pleated%20midi%20skirt%20displayed%20on%20white%20background%20with%20minimalist%20styling%20soft%20natural%20lighting%20highlighting%20the%20pleated%20fabric%20texture%20and%20flowing%20silhouette%20in%20neutral%20tones%20showcasing%20contemporary%20fashion%20with%20clean%20simple%20presentation&width=600&height=800&seq=item005&orientation=portrait"
                      alt="Pleated Midi Skirt"
                      fill
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                      unoptimized
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BOTTOMS</p>
                    <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Pleated Midi Skirt</h3>
                    <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥26,000</p>
                  </div>
                </div>
              </a>
              <a href="/viewer/readdy-nextjs-v1-prod/8ed5d1f76d3598/item/6">
                <div className="group cursor-pointer">
                  <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden relative">
                    <Image
                      src="https://readdy.ai/api/search-image?query=Sophisticated%20black%20structured%20blazer%20hanging%20on%20minimal%20white%20background%20with%20soft%20studio%20lighting%20emphasizing%20the%20tailored%20silhouette%20and%20luxurious%20fabric%20texture%20in%20neutral%20tones%20with%20contemporary%20minimalist%20fashion%20photography%20style%20and%20clean%20lines&width=600&height=800&seq=item006&orientation=portrait"
                      alt="Structured Blazer"
                      fill
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                      unoptimized
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-[#474747] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OUTERWEAR</p>
                    <h3 className="text-base text-black tracking-tight" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Structured Blazer</h3>
                    <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>¥58,000</p>
                  </div>
                </div>
              </a>
            </div>
            <div className="text-center mt-16">
              <a href="/viewer/readdy-nextjs-v1-prod/8ed5d1f76d3598/item">
                <button className="px-12 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap" style={{ fontFamily: 'acumin-pro, sans-serif' }}>VIEW ALL ITEMS</button>
              </a>
            </div>
          </div>
        </section>

        {/* LOOK セクション */}
        <section id="look" className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
          <div className="max-w-7xl mx-auto">
            <div className="text-center mb-16 lg:mb-24">
              <h2 className="text-4xl lg:text-5xl mb-4 text-black tracking-tight" style={{ fontFamily: 'Didot, serif' }}>LOOK</h2>
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
                  <h3 className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>LOOK 01</h3>
                  <p className="text-xs tracking-widest text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2024 S/S</p>
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
                  <h3 className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>LOOK 02</h3>
                  <p className="text-xs tracking-widest text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2024 S/S</p>
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
                  <h3 className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>LOOK 03</h3>
                  <p className="text-xs tracking-widest text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2024 S/S</p>
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
                  <h3 className="text-lg text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>LOOK 04</h3>
                  <p className="text-xs tracking-widest text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2024 S/S</p>
                </div>
              </div>
            </div>

            <div className="text-center mt-8">
              <a href="/viewer/readdy-nextjs-v1-prod/2871426bde5e68/look">
                <button className="px-12 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap" style={{ fontFamily: 'acumin-pro, sans-serif' }}>VIEW LOOKBOOK</button>
              </a>
            </div>
          </div>
        </section>
        {/* ABOUT セクション */}
        <section id="about" className="py-24 lg:py-32 px-6 lg:px-12 bg-[#fafafa] w-full">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
              <div className="order-2 lg:order-1">
                <h2 className="text-4xl lg:text-5xl mb-8 text-black tracking-tight" style={{ fontFamily: 'Didot, serif' }}>ABOUT</h2>
                <div className="w-16 h-px bg-black mb-8"></div>
                <div className="space-y-6 text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                  <p className="text-base lg:text-lg leading-relaxed">Le Fil des Heuresは、「時を紡ぐニュートラルモードな日常着」をコンセプトに、2020年に東京で誕生したアパレルブランドです。</p>
                  <p className="text-base lg:text-lg leading-relaxed">時代を超えて愛される普遍的なデザインと、上質な素材選びにこだわり、日常に寄り添う洗練されたワードローブを提案しています。</p>
                  <p className="text-base lg:text-lg leading-relaxed">ミニマルでありながら、着る人の個性を引き立てる。そんな服作りを目指し、一着一着丁寧に仕上げています。</p>
                  <p className="text-base lg:text-lg leading-relaxed">シーズンごとに移り変わる時の流れの中で、変わらない価値を持つ服を。それが私たちの願いです。</p>
                </div>
                <div className="mt-12 grid grid-cols-2 gap-8">
                  <div>
                    <h3 className="text-sm tracking-widest text-black mb-3" style={{ fontFamily: 'acumin-pro, sans-serif' }}>PHILOSOPHY</h3>
                    <p className="text-sm text-[#474747] leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>時代を超える普遍的な美しさ</p>
                  </div>
                  <div>
                    <h3 className="text-sm tracking-widest text-black mb-3" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ESTABLISHED</h3>
                    <p className="text-sm text-[#474747] leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>2020, Tokyo</p>
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
              <h2 className="text-4xl lg:text-5xl mb-4 text-black tracking-tight" style={{ fontFamily: 'Didot, serif' }}>STOCKIST</h2>
              <div className="w-16 h-px bg-black mx-auto"></div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 lg:gap-12">
              <div className="border border-[#d5d0c9] p-8 lg:p-10 hover:border-black transition-colors duration-300">
                <h3 className="text-xl lg:text-2xl mb-6 text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Le Fil des Heures Aoyama</h3>
                <div className="space-y-3 text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
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
                <h3 className="text-xl lg:text-2xl mb-6 text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Le Fil des Heures Ginza</h3>
                <div className="space-y-3 text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
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
                <h3 className="text-xl lg:text-2xl mb-6 text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Le Fil des Heures Kyoto</h3>
                <div className="space-y-3 text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
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
                <h3 className="text-xl lg:text-2xl mb-6 text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>Le Fil des Heures Osaka</h3>
                <div className="space-y-3 text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
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
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  style={{ border: 0 }}
                />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}