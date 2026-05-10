import type { Metadata } from 'next';
import Image from 'next/image';

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
    <div className="max-w-6xl mx-auto">
      <div className="mb-8 sm:mb-10 lg:mb-12">
        <h1>ABOUT</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-8 lg:gap-16 mb-8 sm:mb-14 lg:mb-28">
        <div className="aspect-[4/5] overflow-hidden">
          <Image
            alt="Le Fil des Heuresのブランド哲学を表現したミニマルなスタイリングイメージ"
            className="image"
            src="/about.png"
            width={800}
            height={1000}
          />
        </div>
        <div className="flex flex-col justify-center">
          <div>
            <h2 className="mb-3 sm:mb-6">Brand Philosophy</h2>
            <div className="about-main-space">
              <p className="about-main-text">
                Le Fil des Heuresは、「時を紡ぐニュートラルモードな日常着」をコンセプトに、時代を超えて愛される普遍的なデザインと上質な素材にこだわったアパレルブランドです。
              </p>
              <p className="about-main-text">
                ミニマルでありながら洗練されたデザイン、そして着る人の個性を引き立てるニュートラルなカラーパレット。私たちは、日常に寄り添いながらも特別な瞬間を演出する服を提案します。
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-8 lg:gap-16 mb-8 sm:mb-14 lg:mb-24">
        <div className="flex flex-col justify-center lg:order-2">
          <div>
            <h2 className="mb-3 sm:mb-6">Quality &amp; Craftsmanship</h2>
            <div className="about-main-space">
              <p className="about-main-text">
                こだわりの素材と、職人による丁寧な縫製。細部にまでこだわり抜いた製品づくりが、Le Fil des Heuresの品質を支えています。
              </p>
              <p className="about-main-text">
                長く愛用していただけるよう、普遍的なデザインと耐久性、快適性を兼ね備えた服作りを心がけています。
              </p>
            </div>
          </div>
        </div>
        <div className="aspect-[4/5] overflow-hidden lg:order-1">
          <Image
            alt="上質な素材感と仕立ての丁寧さを伝えるクラフトマンシップイメージ"
            className="image"
            src="/mainphoto.png"
            width={800}
            height={1000}
          />
        </div>
      </div>
    </div>
  );
}