import type { Metadata } from "next";
import React from "react";
import Link from "next/link";

const pageTitleStyle: React.CSSProperties = { fontSize: "var(--lk-size-5xl)" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-md)",
};
const bodyTextStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-xs)",
  lineHeight: 1.9,
};
const dateTextStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-2xs)",
  lineHeight: 1.9,
};

export async function generateMetadata(): Promise<Metadata> {
  const title = "Privacy Policy | Le Fil des Heures";
  const description =
    "Le Fil des Heures のプライバシーポリシー。個人情報の取扱い、利用目的、第三者提供、お問い合わせ窓口をご案内します。";

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

export default function PrivacyPage() {
  return (
    <div className="w-full max-w-3xl mx-auto">
      <h1 className="mb-10" style={pageTitleStyle}>
        Privacy Policy / 個人情報の取り扱いについて
      </h1>

      <div className="space-y-8">
        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            個人情報の取り扱いについて
          </h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            Le Fil des
            Heures（以下「当社」）は、お客様の個人情報保護の重要性について認識し、個人情報の保護に関する法律（以下「個人情報保護法」）を遵守すると共に、以下のプライバシーポリシー（以下「本ポリシー」）に従い、適切な取扱い及び保護に努めます。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            1. 個人情報の定義
          </h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            本ポリシーにおいて、個人情報とは、個人情報保護法第2条第1項により定義された個人情報、すなわち、生存する個人に関する情報であって、当該情報に含まれる氏名、生年月日その他の記述等により特定の個人を識別することができるもの（他の情報と容易に照合することができ、それにより特定の個人を識別することができることとなるものを含みます）、もしくは個人識別符号が含まれる情報を意味します。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            2. 個人情報の収集方法
          </h2>
          <p className="text-[#474747] mb-2" style={bodyTextStyle}>
            当社は、以下の方法により個人情報を収集することがあります：
          </p>
          <ul
            className="list-disc list-inside text-[#474747]"
            style={bodyTextStyle}
          >
            <li>オンラインストアでの商品購入時</li>
            <li>会員登録時</li>
            <li>お問い合わせフォームからのご連絡時</li>
            <li>メールマガジンの購読登録時</li>
            <li>キャンペーンやイベントへの参加時</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            3. 個人情報の利用目的
          </h2>
          <p className="text-[#474747] mb-2" style={bodyTextStyle}>
            当社は、収集した個人情報を以下の目的で利用いたします：
          </p>
          <ul
            className="list-disc list-inside text-[#474747]"
            style={bodyTextStyle}
          >
            <li>商品の発送及びサービスの提供</li>
            <li>お客様からのお問い合わせへの対応</li>
            <li>新商品やキャンペーン情報のご案内</li>
            <li>サービスの改善及び新サービスの開発</li>
            <li>利用規約違反行為への対応</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            4. 個人情報の第三者提供
          </h2>
          <p className="text-[#474747] mb-2" style={bodyTextStyle}>
            当社は、以下の場合を除き、お客様の同意なく個人情報を第三者に提供することはありません：
          </p>
          <ul
            className="list-disc list-inside text-[#474747]"
            style={bodyTextStyle}
          >
            <li>法令に基づく場合</li>
            <li>人の生命、身体又は財産の保護のために必要がある場合</li>
            <li>
              公衆衛生の向上又は児童の健全な育成の推進のために特に必要がある場合
            </li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            5. 個人情報の取扱いの委託
          </h2>
          <p className="text-[#474747] mb-2" style={bodyTextStyle}>
            当社は、利用目的の達成に必要な範囲内において、個人情報の取扱いの全部または一部を外部の事業者に委託する場合があります。この場合、当社は、委託先について適切な調査を行った上で選定し、委託契約の締結等を通じて、委託先において個人情報の安全管理が図られるよう、必要かつ適切な監督を行います。主な委託業務は以下のとおりです：
          </p>
          <ul
            className="list-disc list-inside text-[#474747]"
            style={bodyTextStyle}
          >
            <li>商品の配送業務（配送事業者）</li>
            <li>決済処理業務（Stripe, Inc.）</li>
            <li>サーバー及びシステムの運用・保守業務</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            6. 個人情報の保有期間
          </h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            当社は、個人情報を利用目的の達成に必要な期間に限り保有します。当該目的を達成した後は、法令に基づき保存が義務付けられている場合を除き、遅滞なく個人情報を消去または廃棄します。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            7. 個人情報の国外移転
          </h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            当社は、決済処理をはじめとする一部の業務において、外国にある第三者が運営するクラウドサービス等を利用しており、これに伴いお客様の個人情報が国外のサーバーに保存・処理される場合があります。当社は、当該第三者との間で適切な契約を締結する等、個人情報保護法に基づき、お客様の個人情報の適切な保護のために必要な措置を講じます。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            8. 個人情報の安全管理
          </h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            当社は、個人情報の紛失、破壊、改ざん及び漏洩などのリスクに対して、個人情報の安全管理が図られるよう、当社の従業員に対し、必要かつ適切な監督を行います。また、個人情報の取扱いを委託する場合は、委託先において個人情報の安全管理が図られるよう、必要かつ適切な監督を行います。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            9. Cookie 及び外部サービスの利用
          </h2>
          <p className="text-[#474747] mb-2" style={bodyTextStyle}>
            当サイトは、ログイン状態の保持やショッピングカートの管理など、サービス提供に必要な範囲で
            Cookie を使用します。
          </p>
          <p className="text-[#474747]" style={bodyTextStyle}>
            また、決済処理のために Stripe, Inc.
            を利用しており、決済に必要な情報は同社へ送信され、同社のプライバシーポリシーに基づいて取り扱われます。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            10. 保有個人データの開示・訂正・利用停止等の請求
          </h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            お客様は、当社が保有するご自身の個人情報について、開示、内容の訂正・追加・削除、利用の停止・消去、及び第三者への提供の停止を請求することができます。ご請求の際は、下記のお問い合わせ窓口までご連絡ください。当社は、ご本人であることを確認させていただいた上で、法令に従い、合理的な期間内に対応いたします。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            11. 本ポリシーの変更
          </h2>
          <p className="text-[#474747]" style={bodyTextStyle}>
            当社は、法令の改正やサービス内容の変更等に応じて、本ポリシーを変更することがあります。変更後の本ポリシーは、当社ウェブサイトに掲載した時点から効力を生じるものとします。
          </p>
        </section>

        <section>
          <h2 className="mb-3 font-brand" style={sectionTitleStyle}>
            12. お問い合わせ窓口
          </h2>
          <p className="text-[#474747] mb-2" style={bodyTextStyle}>
            個人情報の取扱いに関するお問い合わせ、及び前条の開示等のご請求は、下記の窓口までご連絡ください。
          </p>
          <ul className="text-[#474747]" style={bodyTextStyle}>
            <li>事業者名：Le Fil des Heures</li>
            <li>お問い合わせ先：privacy@lefildesheures.com</li>
          </ul>
          <p className="text-[#474747] mt-2" style={bodyTextStyle}>
            <Link
              href="/contact"
              className="underline underline-offset-4 hover:text-black transition-colors"
            >
              お問い合わせフォーム
            </Link>
          </p>
        </section>

        <section>
          <p className="text-[#474747]" style={dateTextStyle}>
            制定日：2026年6月20日
            <br />
            最終改定日：2026年7月11日
          </p>
        </section>
      </div>
    </div>
  );
}
