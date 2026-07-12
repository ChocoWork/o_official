import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { getSiteUrl } from "@/lib/redirect";

const pageTitleStyle: CSSProperties = { fontSize: "var(--lk-size-5xl)" };
const labelStyle: CSSProperties = { fontSize: "var(--lk-size-md)" };
const bodyTextStyle: CSSProperties = {
  fontSize: "var(--lk-size-xs)",
  lineHeight: 1.9,
};
const noteStyle: CSSProperties = {
  fontSize: "var(--lk-size-2xs)",
  lineHeight: 1.9,
};

export async function generateMetadata(): Promise<Metadata> {
  const title = "Legal Notice | Le Fil des Heures";
  const description =
    "Le Fil des Heures の特定商取引法に基づく表記です。販売事業者・支払方法・引渡時期・返品についてご案内します。";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: ["/mainphoto.png"],
    },
  };
}

type LegalRow = { label: string; value: ReactNode };

export default function LegalPage() {
  const siteUrl = getSiteUrl();

  const rows: LegalRow[] = [
    { label: "販売業者", value: "Le Fil des Heures" },
    { label: "運営統括責任者", value: "櫻井 雅也" },
    {
      label: "所在地",
      value: (
        <>
          〒980-0021
          <br />
          宮城県仙台市青葉区中央2丁目11-19 仙南ビル 4階-A
        </>
      ),
    },
    {
      label: "電話番号",
      value: (
        <>
          080-9637-0468
          <br />
          ※
          本電話番号は、特定商取引法の遵守にあたり、代表番号を記載するものです。商品返品等カスタマー対応は致し兼ねます。必要の際は、下記お問い合わせフォームよりご連絡下さいますようお願いいたします。
          <br />
          <br />
          <Link
            href="/contact"
            className="underline underline-offset-4 hover:text-black transition-colors"
          >
            お問い合わせフォーム
          </Link>
        </>
      ),
    },
    { label: "ウェブサイト", value: siteUrl },
    {
      label: "販売価格",
      value: "各商品ページにてご確認ください（表示価格は消費税込みです）。",
    },
    {
      label: "商品以外の必要代金",
      value: (
        <>
          送料　　　　：無料（商品価格に含みます）
          <br />
          決済手数料　：コンビニ決済をご利用の場合は、別途コンビニ決済手数料をお客様にご負担いただきます。
          <br />
          試着サービス：往復配送料・クリーニング代等を含む所定の試着サービス料金を含む金額をお客様にご負担いただきます。
        </>
      ),
    },
    {
      label: "支払方法・支払時期",
      value: (
        <>
          クレジットカード決済：ご注文時にお支払いが確定します。
          <br />
          PayPay：ご注文時にお支払いが確定します。
          <br />
          コンビニ決済：ご注文後に発行される払込番号の期限（ご注文から7日以内）までに、選択したコンビニでお支払いください。
          <span className="mt-1 block text-[#767676]" style={noteStyle}>
            ※
            コンビニ決済をご選択の場合、期限までにお支払いが確認できないときは、ご注文をキャンセルさせていただくことがあります。
          </span>
        </>
      ),
    },
    {
      label: "商品の引渡時期",
      value:
        "当社の商品は原則として受注生産です。在庫がある場合は、ご注文（コンビニ決済の場合はご入金）確認後、通常3〜7営業日以内に発送いたします。在庫がなく受注生産となる場合は、一定数のご注文がまとまった時点で製造を開始し、注文確定後、発送までに数週間から2ヶ月以上お時間をいただく場合があります。発送時期の目安は、各商品ページまたは注文確定時のご案内にてお知らせします。",
    },
    {
      label: "返品・交換・キャンセルについて",
      value: (
        <>
          <p>
            ご注文後のお客様都合による返品・交換・キャンセルは、原則としてお受けできません。
          </p>
          <p className="mt-4">
            初期不良（仕様上明らかな不具合がある場合）または誤送（ご注文と異なる商品が届いた場合）に限り、商品到着後7日以内にお問い合わせフォームよりご連絡いただいた場合に、返品・交換・修理を承ります。この場合、該当商品を当店までご返送いただく必要がございます。7日を過ぎたご連絡は、未使用であってもお受けできません。
          </p>
          <p className="mt-4">
            サイズ交換をご希望の場合は、未使用品かつ在庫があるものに限り対応いたします。
          </p>
          <p className="mt-4">以下の場合は、返品・交換をお受けできません。</p>
          <ul className="mt-1 list-disc list-inside">
            <li>商品到着後7日以上経過したもの</li>
            <li>お客様が一度ご使用になったもの</li>
            <li>お客様が破損・汚損されたもの</li>
            <li>お客様が加工・修理されたもの</li>
            <li>
              商品の箱・タグ・説明書などの付属品を汚損・破損・紛失された場合
            </li>
          </ul>
          <p className="mt-4">
            返品にかかる送料は、お客様のご負担となります。ただし、初期不良・誤送など当社の責めに帰すべき理由による場合は、当社が負担いたします。
          </p>
          <p className="mt-4">
            当社の商品は、素材の風合いを活かして一点一点丁寧に仕立てております。製造過程で避けられない細かな傷や掠れ、天然素材特有のへこみ・色むら・黒点などは、素材の個性および良品として取り扱っておりますので、これらを理由とする返品・交換はご容赦ください。
          </p>
        </>
      ),
    },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto">
      <h1 className="mb-10" style={pageTitleStyle}>
        Legal Notice / 特定商取引法に基づく表記
      </h1>

      <dl className="space-y-8">
        {rows.map((row) => (
          <div key={row.label}>
            <dt
              className="mb-3 font-brand text-black tracking-wide"
              style={labelStyle}
            >
              {row.label}
            </dt>
            <dd className="text-[#474747]" style={bodyTextStyle}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
