import Image from "next/image";

type Item = {
  id: number;
  name: string;
  imageUrl: string;
};

const items: Item[] = Array.from({ length: 10 }, (_, i) => ({
  id: i,
  name: `商品名`,
  imageUrl: "/placeholder.png", // public フォルダの画像
}));

export default function Home() {
  return (
    <div className="min-h-screen pb-20 font-sans">
      <main className="flex flex-col items-center gap-8">

        {/* 元画像の縦横比を保って全体表示 */}
        <div className="w-full max-w-screen">
          <Image
            src="/top_photo2.jpg"
            alt="main photo"
            width={6048} // ← 画像の実際の幅
            height={4024} // ← 画像の実際の高さ
            className="w-full h-auto object-contain"
            priority
          />
        </div>

        {/* 見出し */}
        <h2 className="text-2xl mt-25 mb-5">New Item</h2>

        {/* 商品カードグリッド */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5 gap-3 w-full px-4 sm:px-6 md:px-8 lg:px-10 xl:px-12">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex flex-col items-start"
            >
              <div className="w-full aspect-[3/4] relative">
                <Image
                  src={item.imageUrl}
                  alt={item.name}
                  fill
                  className="object-cover"
                />
              </div>
              <p className="mt-2 mb-12 text-sm text-left">{item.name}</p>
            </div>
          ))}
        </div>

        {/* VIEW ALLボタン */}
        <button className="px-20 py-1 bg-black text-white rounded hover:opacity-80">
           VIEW ALL
        </button>

        {/* 見出し */}
        <h2 className="text-2xl mt-25 mb-5">LOOK</h2>

        {/* LOOKカードグリッド */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5 gap-3 w-full px-4 sm:px-6 md:px-8 lg:px-10 xl:px-12">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex flex-col items-start"
            >
              <div className="w-full aspect-[3/4] relative">
                <Image
                  src={item.imageUrl}
                  alt={item.name}
                  fill
                  className="object-cover"
                />
              </div>
            </div>
          ))}
        </div>

        {/* VIEW ALLボタン */}
        <button className="my-15 px-20 py-1 bg-black text-white rounded hover:opacity-80">
          VIEW ALL
        </button>
      </main>
    </div>
  );
}
