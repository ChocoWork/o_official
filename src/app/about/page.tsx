import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'ABOUT | Le Fil des Heures',
    description: 'Le Fil des Heures のブランド哲学、品質へのこだわり、価値観を紹介するABOUTページです。',
    openGraph: {
      title: 'ABOUT | Le Fil des Heures',
      description: 'Le Fil des Heures のブランド哲学、品質へのこだわり、価値観を紹介するABOUTページです。',
      images: ['/about.png'],
    },
  };
}

export default function StoryPage() {
  return (
    <div className="pb-10 sm:pb-14">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-12">
        <div className="mb-8 sm:mb-10 lg:mb-12">
          <h1 className="text-2xl sm:text-3xl lg:text-4xl text-black tracking-tight">ABOUT</h1>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-8 lg:gap-16 mb-8 sm:mb-14 lg:mb-24">
          <div className="aspect-[4/5] bg-[#f5f5f5] overflow-hidden">
            <Image
              alt="Le Fil des Heuresのブランド哲学を表現したミニマルなスタイリングイメージ"
              className="w-full h-full object-cover object-center"
              src="/about.png"
              width={800}
              height={1000}
            />
          </div>
          <div className="flex flex-col justify-center space-y-4 lg:space-y-8">
            <div>
              <h2 className="text-xl sm:text-2xl lg:text-3xl text-black mb-3 sm:mb-6 tracking-tight">Brand Philosophy</h2>
              <p className="text-base text-[#474747] leading-relaxed mb-4">
                Le Fil des Heuresは、「時を紡ぐニュートラルモードな日常着」をコンセプトに、時代を超えて愛される普遍的なデザインと上質な素材にこだわったアパレルブランドです。
              </p>
              <p className="text-base text-[#474747] leading-relaxed">
                ミニマルでありながら洗練されたデザイン、そして着る人の個性を引き立てるニュートラルなカラーパレット。私たちは、日常に寄り添いながらも特別な瞬間を演出する服を提案します。
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-8 lg:gap-16 mb-8 sm:mb-14 lg:mb-24">
          <div className="flex flex-col justify-center space-y-4 lg:space-y-8 lg:order-2">
            <div>
              <h2 className="text-xl sm:text-2xl lg:text-3xl text-black mb-3 sm:mb-6 tracking-tight">Quality &amp; Craftsmanship</h2>
              <p className="text-base text-[#474747] leading-relaxed mb-4">
                こだわりの素材と、職人による丁寧な縫製。細部にまでこだわり抜いた製品づくりが、Le Fil des Heuresの品質を支えています。
              </p>
              <p className="text-base text-[#474747] leading-relaxed">
                長く愛用していただけるよう、普遍的なデザインと耐久性、快適性を兼ね備えた服作りを心がけています。
              </p>
            </div>
          </div>
          <div className="aspect-[4/5] bg-[#f5f5f5] overflow-hidden lg:order-1">
            <Image
              alt="上質な素材感と仕立ての丁寧さを伝えるクラフトマンシップイメージ"
              className="w-full h-full object-cover object-center"
              src="/mainphoto.png"
              width={800}
              height={1000}
            />
          </div>
        </div>

        <section className="mb-8 sm:mb-14 lg:mb-24 border-t border-black/10 pt-8 sm:pt-10 lg:pt-12">
          <h2 className="text-xl sm:text-2xl lg:text-3xl text-black mb-6 sm:mb-8 tracking-tight text-center">Explore More</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
            <Link href="/item" className="block border border-black/20 px-6 py-4 text-center hover:border-black transition-colors">
              COLLECTIONを見る
            </Link>
            <Link href="/look" className="block border border-black/20 px-6 py-4 text-center hover:border-black transition-colors">
              LOOKBOOKを見る
            </Link>
            <Link href="/contact" className="block border border-black/20 px-6 py-4 text-center hover:border-black transition-colors">
              CONTACTする
            </Link>
          </div>
        </section>

        <div className="mb-8 sm:mb-14 lg:mb-24">
          <h2 className="text-xl sm:text-2xl lg:text-3xl text-black mb-6 sm:mb-8 lg:mb-12 tracking-tight text-center">Our Values</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto flex items-center justify-center"><i aria-hidden="true" className="ri-time-line text-4xl text-black"></i></div>
              <h3 className="text-xl text-black tracking-tight">Timeless</h3>
              <p className="text-sm text-[#474747] leading-relaxed">流行に左右されない、時代を超えたデザイン</p>
            </div>

            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto flex items-center justify-center"><i aria-hidden="true" className="ri-leaf-line text-4xl text-black"></i></div>
              <h3 className="text-xl text-black tracking-tight">Sustainable</h3>
              <p className="text-sm text-[#474747] leading-relaxed">環境に配慮した素材と製造プロセス</p>
            </div>

            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto flex items-center justify-center"><i aria-hidden="true" className="ri-heart-line text-4xl text-black"></i></div>
              <h3 className="text-xl text-black tracking-tight">Thoughtful</h3>
              <p className="text-sm text-[#474747] leading-relaxed">着る人に寄り添う、心地よい服作り</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}