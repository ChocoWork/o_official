import type { Metadata } from "next";
import { Button } from "@/components/ui/Button/Button";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "ABOUT | Le Fil des Heures",
    description:
      "Le Fil des Heures のブランド哲学。時間を超えて選ばれ続ける服を、シルエットと生地への徹底したこだわりから。天然繊維100%・国内生産・受注生産・タイムレス・ユニセックス。",
    openGraph: {
      title: "ABOUT | Le Fil des Heures",
      description:
        "Le Fil des Heures のブランド哲学。時間というフィルターを通しても価値が落ちない、時に耐えられる服をつくります。",
      images: ["/about.png"],
    },
  };
}

export default function StoryPage() {
  const taglineStyle = { fontSize: "var(--lk-size-md)" } as const;
  const sectionTitleStyle = {
    fontSize: "var(--lk-size-2xl)",
    letterSpacing: "0.08em",
  } as const;
  const subTitleStyle = { fontSize: "var(--lk-size-md)" } as const;
  const labelStyle = { fontSize: "var(--lk-size-4xs)" } as const;
  const bodyTextStyle = { fontSize: "var(--lk-size-xs)" } as const;
  const quoteStyle = {
    fontSize: "var(--lk-size-sm)",
    lineHeight: 1.9,
  } as const;
  const numberStyle = {
    fontSize: "var(--lk-size-xl)",
    letterSpacing: "0.05em",
  } as const;

  const principles = [
    {
      no: "01",
      en: "TIMELESS / UNISEX",
      ja: "タイムレス・ユニセックス",
      text: "どの時代でも手に取りたくなる服を。シーズンごとにルックは発表しますが、一度世に出した服はつくり続け、いつでも手に取れるようにしています。性別の境界も設けず、男女を問わず着られるデザインに。だから一着は、時代も性別も越えて、長く誰かの日常であり続けます。",
    },
    {
      no: "02",
      en: "NATURAL FIBERS",
      ja: "天然繊維",
      text: "生地は天然繊維を中心に。見慣れたものよりワンランク上のもの、少し変わった表情を持つものを選びます。化学繊維は自然に還らず、海の生きものや鳥にも影響を与えています。服として最高の一着を。地球にもやさしい一着に。",
    },
    {
      no: "03",
      en: "DOMESTIC, MADE TO ORDER",
      ja: "国内受注生産",
      text: "すべて、国内で受注生産。必要な人に、必要な分だけつくるから、廃棄はほとんど生まれません。安さを求めて海外でつくる時代でも、私たちは国内にこだわります。手を動かす職人がいなくなれば、その技術は二度と戻らない。国内でつくり続けることが、日本の縫製技術を未来へつなぐ唯一の方法だと考えています。",
    },
  ];

  return (
    <div className="max-w-6xl mx-auto px-1 sm:px-4 lg:px-8">
      {/* Philosophy（ブランド主語の説明） */}
      <div className="mb-[34px] sm:mb-[55px] lg:mb-[89px] border-t border-black/10 pt-[34px] sm:pt-[55px] lg:pt-[89px]">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,_1fr)_minmax(0,_2fr)] gap-x-[48px] gap-y-[13px] sm:gap-y-[21px]">
          <h2 style={sectionTitleStyle}>Brand Philosophy / ブランドの思想</h2>
          <div className="about-main-space">
            <p className="about-main-text" style={bodyTextStyle}>
              Le Fil des Heures
              は、時間を超えて選ばれ続ける服をつくるブランドです。ブランド名は「時の糸」を意味します。
            </p>
            <p className="about-main-text" style={bodyTextStyle}>
              流行を否定はしません。けれど、流行だけで終わる服はつくりません。何年たっても、何度袖を通しても美しいと思えること。新品でも、数年後でも、古着屋に並んでいても、また手に取りたいと思えること。それが私たちの考える「時を超えて価値の続く服」です。
            </p>
            <p className="about-main-text" style={bodyTextStyle}>
              そのために、シルエット、生地、縫製、素材、そして生産方法まで、すべてをひとつの思想のもとで設計します。
            </p>
          </div>
        </div>
      </div>

      {/* なぜ、つくるのか（市場への問題提起 + 創業者の言葉） */}
      <div className="mb-[34px] sm:mb-[55px] lg:mb-[89px]">
        <div className="border-t border-black/10 pt-[34px] sm:pt-[55px] lg:pt-[89px]">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,_1fr)_minmax(0,_2fr)] gap-x-[48px] gap-y-[13px] sm:gap-y-[21px]">
            <h2 style={sectionTitleStyle}>WHY WE MAKE / なぜ、つくるのか</h2>
            <div className="space-y-[16px] sm:space-y-[21px]">
              <p className="about-main-text" style={bodyTextStyle}>
                低価格。大量生産。機能性。それらが優先されるうちに、化学繊維を用いた、当たり障りのない形の服が増えた。ベーシックな形かつ上質な生地のアイテムをベースとして、「シルエット」と「生地」から生まれる服本来の面白さを提案します。
              </p>
              <p className="font-display text-black" style={quoteStyle}>
                「シルエットは良くても生地に納得できない。生地は素晴らしくても形に納得できない。その両方を満たそうとすると、極端に高価になる。私はその妥協をなくしたいと思いました。」
              </p>
              <p className="font-display text-black" style={quoteStyle}>
                「形と生地にも妥協せず、最高の服を、適正と思える価格で。その過程での、つくり手の技術継承や自然環境を考えたものづくりをします。」
              </p>
              <p className="about-main-text" style={bodyTextStyle}>
                — Founder, Le Fil des Heures
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Our Commitments（事業原則 / 手段） */}
      <div className="mb-[34px] sm:mb-[55px] lg:mb-[89px] border-t border-black/10 pt-[34px] sm:pt-[55px] lg:pt-[89px]">
        <h2 className="mb-[21px] sm:mb-[34px]" style={sectionTitleStyle}>
          OUR COMMITMENTS / 取り組み
        </h2>
        <div className="pl-[12px] sm:pl-[24px] lg:pl-[32px]">
          {principles.map((principle, index) => (
            <div
              key={principle.no}
              className="grid grid-cols-1 sm:grid-cols-[64px_1fr] lg:grid-cols-[88px_1fr] gap-[8px] sm:gap-[32px] lg:gap-[48px]"
            >
              <p
                className="font-display text-[#474747] sm:text-right"
                style={numberStyle}
              >
                {principle.no}
              </p>
              <div
                className={`border-t border-black/10 pt-[16px] sm:pt-[21px] lg:pt-[26px] pb-[16px] sm:pb-[21px] lg:pb-[26px] ${
                  index === principles.length - 1 ? "border-b" : ""
                }`}
              >
                <p
                  className="about-secondary-title font-brand"
                  style={labelStyle}
                >
                  {principle.en}
                </p>
                <h3
                  className="mb-[8px] sm:mb-[10px] font-brand text-black"
                  style={subTitleStyle}
                >
                  {principle.ja}
                </h3>
                <p className="about-main-text" style={bodyTextStyle}>
                  {principle.text}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Collection（商品設計思想 / Type A・B） */}
      <div className="mb-[34px] sm:mb-[55px] lg:mb-[89px] border-t border-black/10 pt-[34px] sm:pt-[55px] lg:pt-[89px]">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,_1fr)_minmax(0,_2fr)] gap-x-[48px] gap-y-[13px] sm:gap-y-[21px]">
          <h2 style={sectionTitleStyle}>COLLECTION / 商品設計思想</h2>
          <p className="about-main-text" style={bodyTextStyle}>
            毎日に寄り添うベーシックも、もちろんそろえています。そのうえで、シルエットと生地に少しずつ変化を加えることで、一着ごとに異なる「服の面白さ」と出会えるように。普遍的なかたちを突きつめた一着から、生地の表情を味わう一着、シルエットそのものを主役にした一着まで。その日の気分で選べる幅を、用意しています。
          </p>
        </div>
      </div>

      {/* 締めのCTA */}
      <div className="border-t border-black/10 pt-[34px] sm:pt-[55px] lg:pt-[89px] pb-[34px] sm:pb-[42px] text-center">
        <p
          className="font-display text-black mb-[21px] sm:mb-[26px]"
          style={taglineStyle}
        >
          時を超えて価値の続く服を。
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-[13px] sm:gap-[16px]">
          <Button
            href="/item"
            variant="primary"
            size="md"
            className="w-full sm:w-auto sm:min-w-[260px] text-center justify-center"
          >
            VIEW COLLECTION
          </Button>
          <Button
            href="/look"
            variant="secondary"
            size="md"
            className="w-full sm:w-auto sm:min-w-[260px] text-center justify-center"
          >
            VIEW LOOKBOOK
          </Button>
        </div>
      </div>
    </div>
  );
}
