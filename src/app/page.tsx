import type { Metadata } from "next";
import Image from "next/image";
import ReactDOM from "react-dom";
import { PublicLookGrid } from "@/features/look/components/PublicLookGrid";
import { PublicItemGrid } from "@/features/items/components/PublicItemGrid";
import { PublicNewsGrid } from "@/features/news/components/PublicNewsGrid";
import { PublicStockistGrid } from "@/features/stockist/components/PublicStockistGrid";
import { SearchHomePreview } from "@/features/search/components/SearchHomePreview";
import { SectionTitle } from "@/components/ui/SectionTitle/SectionTitle";
import { Button } from "@/components/ui/Button/Button";
import { getPublishedItems } from "@/lib/items/public";
import { getPublishedLooks } from "@/lib/look/server";
import { getPublishedNews } from "@/features/news/services/public";
import { getHomePublicStockists } from "@/features/stockist/services/public";

const HOME_LOOK_FETCH_COUNT = 7;

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Le Fil des Heures",
    description:
      "Le Fil des Heuresの公式オンラインストア。時を紡ぐニュートラルモードな日常着を提案します。",
    openGraph: {
      title: "Le Fil des Heures",
      description:
        "Le Fil des Heuresの公式オンラインストア。時を紡ぐニュートラルモードな日常着を提案します。",
      images: ["/mainphoto.png"],
    },
  };
}

export default async function Home() {
  const [homeItems, homeLooks, homeNews, homeStockists] = await Promise.all([
    getPublishedItems(9),
    getPublishedLooks(HOME_LOOK_FETCH_COUNT),
    getPublishedNews({ limit: 6 }),
    getHomePublicStockists(),
  ]);

  ReactDOM.preload("/mainphoto.png", {
    as: "image",
  });

  return (
    <div className="min-h-screen w-full">
      <div className="flex flex-col w-full items-stretch">
        {/* メイン画像セクション */}
        <section className="relative min-h-[100svh] w-full flex items-center justify-center bg-white pt-20">
          <div className="absolute inset-0 overflow-hidden">
            <Image
              src="/mainphoto.png"
              alt="ニュートラルな日常着をまとう Le Fil des Heures のメインビジュアル"
              width={2752} // ←mainphoto.pngの実際の横幅に合わせて調整してください
              height={1536} // ←mainphoto.pngの実際の縦幅に合わせて調整してください
              priority
              sizes="(max-width: 1023px) 300vw, 100vw"
              className="image opacity-90"
            />
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/60"
            />
          </div>
          <div className="relative z-10 text-center px-6 max-w-4xl mx-auto">
            <h1
              className="mb-[13px] sm:mb-[16px] md:mb-[21px] tracking-tight text-white"
              style={{
                fontFamily: "Didot, serif",
                fontSize: "var(--lk-size-4xl)",
              }}
            >
              Le Fil des Heures
            </h1>
          </div>
          <div
            aria-hidden="true"
            className="absolute bottom-[26px] sm:bottom-[34px] left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-[8px]"
          >
            <span
              className="font-brand text-white/70 tracking-[0.3em]"
              style={{ fontSize: "var(--lk-size-4xs)" }}
            >
              SCROLL
            </span>
            <span className="block h-[34px] w-px bg-white/50" />
          </div>
        </section>

        <SearchHomePreview />

        {/* Item セクション */}
        <PublicItemGrid variant="home" items={homeItems} />

        {/* Look セクション */}
        <PublicLookGrid variant="home" looks={homeLooks} />

        {/* News セクション */}
        <PublicNewsGrid variant="home" articles={homeNews} />

        {/* ABOUT セクション（CONCEPT 統合：思想・差別化・ブランド概要を集約） */}
        <section id="about" className="section-space-about">
          <div className="element-width">
            <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-[21px] sm:gap-[26px] md:gap-[34px] lg:gap-[55px] items-start">
              {/* 左: ABOUT タイトル + テキスト全量 + 3本柱 + CTA */}
              <div className="order-2 md:order-1 flex flex-col">
                <SectionTitle title="ABOUT" />
                <div className="about-main-space">
                  <p
                    className="about-main-text"
                    style={{ fontSize: "var(--lk-size-sm)" }}
                  >
                    長く着られる服だけをつくる。それが、唯一のこだわり。
                  </p>
                  <p
                    className="about-main-text"
                    style={{ fontSize: "var(--lk-size-sm)" }}
                  >
                    流行ではなく、タイムレスなシルエットと素材を。
                  </p>
                </div>
                {/* 差別化の3本柱（縦並び・仕切り線） */}
                <div className="mt-[21px] sm:mt-[26px] md:mt-[34px] divide-y divide-black/10 border-t border-b border-black/10">
                  {[
                    {
                      en: "TIMELSS & UNISEX",
                      ja: "タイムレス＆ユニセックス",
                      body: "時代も性別もサイズも超えてフリーな着こなしを。古着になっても時を超えて誰かに手に取ってもらえる服を。",
                    },
                    {
                      en: "NATURAL FIBERS",
                      ja: "天然繊維100%",
                      body: "洗うほど馴染み、役目を終えれば土に還る。古着のような確かな厚みと手触りを。",
                    },
                    {
                      en: "MADE TO ORDER",
                      ja: "国内受注生産",
                      body: "必要なときに、必要な人に、必要な分だけ。日本の技術を次世代に紡ぐ。",
                    },
                  ].map((pillar) => (
                    <div key={pillar.en} className="py-[13px] sm:py-[16px]">
                      <h3
                        className="about-secondary-title font-brand"
                        style={{ fontSize: "var(--lk-size-3xs)" }}
                      >
                        {pillar.en}
                      </h3>
                      <p
                        className="text-black mb-[4px] sm:mb-[6px]"
                        style={{ fontSize: "var(--lk-size-sm)" }}
                      >
                        {pillar.ja}
                      </p>
                      <p
                        className="about-main-text"
                        style={{ fontSize: "var(--lk-size-2xs)" }}
                      >
                        {pillar.body}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-[21px] sm:mt-[26px] md:mt-[34px]">
                  <Button href="/about" variant="secondary" size="xs">
                    READ OUR STORY
                  </Button>
                </div>
              </div>

              {/* 右: 画像 */}
              <div className="order-1 md:order-2">
                <div className="relative aspect-[3/4] overflow-hidden">
                  <Image
                    src="/about.png"
                    alt="About Le Fil des Heures"
                    fill
                    sizes="(min-width: 768px) 50vw, 100vw"
                    className="image"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* STOCKIST セクション */}
        <PublicStockistGrid variant="home" stockists={homeStockists} />
      </div>
    </div>
  );
}
