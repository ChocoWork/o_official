// Next.jsのImageコンポーネントをインポート。画像の最適化やレスポンシブ対応に使用する
import Image from "next/image";

// Homeコンポーネントを定義。これはページのメインコンテンツとなる
export default function Home() {
  return (
    // divタグで全体をラップ。グリッドレイアウトを使用し、アイテムを中央に配置
    <div className="grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20 font-[family-name:var(--font-geist-sans)]">
      {/* mainタグでページの主要コンテンツ部分を定義 */}
      <main className="flex flex-col gap-[32px] row-start-2 items-center sm:items-start">
        {/* Next.jsのロゴ画像を表示 */}
        <Image
          className="dark:invert"  // ダークモード時に画像を反転
          src="/next.svg"  // 画像のパス
          alt="Next.js logo"  // 画像の幅
          width={180}  // 画像の高さ
          height={38}  // 画像の優先読み込みを指定
          priority
        />
        {/* リストを表示。スタートアップ手順をリスト形式で表示 */}
        <ol className="list-inside list-decimal text-sm/6 text-center sm:text-left font-[family-name:var(--font-geist-mono)]">
          <li className="mb-2 tracking-[-.01em]">
            Get started by editing{" "}
            {/* `src/app/page.tsx`をコードの形式で表示 */}
            <code className="bg-black/[.05] dark:bg-white/[.06] px-1 py-0.5 rounded font-[family-name:var(--font-geist-mono)] font-semibold">
              src/app/page.tsx
            </code>
            .
          </li>
          <li className="tracking-[-.01em]">
            Save and see your changes instantly.
          </li>
        </ol>

        {/* ボタンリンクのグループ。VercelへのデプロイとNext.jsのドキュメントページにリンク */}
        <div className="flex gap-4 items-center flex-col sm:flex-row">
          {/* Vercelデプロイリンク */}
          <a
            className="rounded-full border border-solid border-transparent transition-colors flex items-center justify-center bg-foreground text-background gap-2 hover:bg-[#383838] dark:hover:bg-[#ccc] font-medium text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 sm:w-auto"
            href="https://vercel.com/new?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            {/* Vercelのロゴ画像 */}
            <Image
              className="dark:invert"  // ダークモード時に画像を反転
              src="/vercel.svg"  // 画像のパス
              alt="Vercel logomark"  // 画像の代替テキスト
              width={20}  // 画像の幅
              height={20}  // 画像の高さ
            />
            Deploy now  {/* デプロイボタン */}
          </a>
          {/* Next.jsのドキュメントリンク */}
          <a
            className="rounded-full border border-solid border-black/[.08] dark:border-white/[.145] transition-colors flex items-center justify-center hover:bg-[#f2f2f2] dark:hover:bg-[#1a1a1a] hover:border-transparent font-medium text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 w-full sm:w-auto md:w-[158px]"
            href="https://nextjs.org/docs?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read our docs
          </a>
        </div>
      </main>
      {/* フッター部分。複数のリンクを表示 */}
      <footer className="row-start-3 flex gap-[24px] flex-wrap items-center justify-center">
        {/* Learnリンク */}
        <a
          className="flex items-center gap-2 hover:underline hover:underline-offset-4"
          href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          {/* ファイルアイコン */}
          <Image
            aria-hidden
            src="/file.svg"  // 画像のパス
            alt="File icon"  // 画像の代替テキスト
            width={16}  // 画像の幅
            height={16}  // 画像の高さ
          />
          Learn  {/* 学習リンク */}
        </a>
        {/* Examplesリンク */}
        <a
          className="flex items-center gap-2 hover:underline hover:underline-offset-4"
          href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          {/* ウィンドウアイコン */}
          <Image
            aria-hidden
            src="/window.svg"  // 画像のパス
            alt="Window icon"  // 画像の代替テキスト
            width={16}  // 画像の幅
            height={16}  // 画像の高さ
          />
          Examples  {/* 例示リンク */}
        </a>
        {/* Next.js公式サイトリンク */}
        <a
          className="flex items-center gap-2 hover:underline hover:underline-offset-4"
          href="https://nextjs.org?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
          target="_blank"
          rel="noopener noreferrer"
        >
          {/* 地球アイコン */}
          <Image
            aria-hidden
            src="/globe.svg"  // 画像のパス
            alt="Globe icon"  // 画像の代替テキスト
            width={16}  // 画像の幅
            height={16}  // 画像の高さ
          />
          Go to nextjs.org →  {/* Next.js公式サイトへのリンク */}
        </a>
      </footer>
    </div>
  );
}
