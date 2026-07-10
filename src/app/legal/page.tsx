import type { Metadata } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { getSiteUrl } from '@/lib/redirect';

const pageTitleStyle: CSSProperties = { fontSize: 'var(--lk-size-4xl)' };
const labelStyle: CSSProperties = { fontSize: 'var(--lk-size-sm)' };
const bodyTextStyle: CSSProperties = { fontSize: 'var(--lk-size-md)' };
const noteStyle: CSSProperties = { fontSize: 'var(--lk-size-sm)' };

export async function generateMetadata(): Promise<Metadata> {
  const title = '特定商取引法に基づく表記 | Le Fil des Heures';
  const description =
    'Le Fil des Heures の特定商取引法に基づく表記です。販売事業者・支払方法・引渡時期・返品についてご案内します。';

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: ['/mainphoto.png'],
    },
  };
}

type LegalRow = { label: string; value: ReactNode };

export default function LegalPage() {
  const siteUrl = getSiteUrl();

  const rows: LegalRow[] = [
    { label: '販売事業者', value: 'Le Fil des Heures（運営者氏名：※要記入）' },
    { label: '運営統括責任者', value: '※要記入' },
    {
      label: '所在地',
      value:
        'ご請求に応じて遅滞なく開示いたします。お問い合わせフォームよりご請求ください。',
    },
    {
      label: '電話番号',
      value:
        'ご請求に応じて遅滞なく開示いたします。お問い合わせフォームよりご請求ください。',
    },
    {
      label: 'お問い合わせ',
      value: (
        <Link
          href="/contact"
          className="underline underline-offset-4 hover:text-black transition-colors"
        >
          お問い合わせフォーム
        </Link>
      ),
    },
    { label: '販売URL', value: siteUrl },
    { label: '販売価格', value: '各商品ページに表示する価格（消費税込み）' },
    {
      label: '商品代金以外の必要料金',
      value: '消費税、送料（ご注文手続き時に表示します）',
    },
    {
      label: '支払方法',
      value: 'クレジットカード／PayPay／コンビニ決済',
    },
    {
      label: '支払時期',
      value:
        '各決済手段の定めに従い、ご注文時に確定します。コンビニ決済の場合は、所定の期限内にお支払いください。',
    },
    {
      label: '商品の引渡時期',
      value:
        '受注生産のため、ご注文（コンビニ決済の場合はご入金）確認後、◯営業日以内に発送いたします（※日数 要記入）。',
    },
    {
      label: '返品・交換',
      value:
        '受注生産のため、お客様のご都合による返品・交換はお受けできません。商品の不良または誤配送の場合に限り、商品到着後7日以内にお問い合わせフォームよりご連絡いただくことで、当社負担にて対応いたします。',
    },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto">
      <h1 className="mb-8" style={pageTitleStyle}>
        特定商取引法に基づく表記
      </h1>

      <dl className="border-t border-black/10">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-col sm:flex-row gap-1 sm:gap-8 border-b border-black/10 py-4"
          >
            <dt
              className="font-brand text-black sm:w-52 flex-shrink-0 tracking-wide"
              style={labelStyle}
            >
              {row.label}
            </dt>
            <dd className="text-[#474747] leading-relaxed" style={bodyTextStyle}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-8 text-[#474747] leading-relaxed" style={noteStyle}>
        ※「要記入」の項目は、事業開始時に正式な情報を記載してください。所在地・電話番号は、特定商取引法の規定に基づき、ご請求があった場合に遅滞なく開示する運用としています。
      </p>
    </div>
  );
}
