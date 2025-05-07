import Image from "next/image";
import React from "react";

type Item = {
    id: number;
    name: string;
    imageUrl: string;
  };
  
const items: Item[] = Array.from({ length: 10 }, (_, i) => ({
id: i,
name: `商品名 ${i + 1}`,
imageUrl: "/placeholder.png", // public フォルダの画像
}));

export default function LookPage() {
    return (
        <main className="px-5 pt-20 pb-20">
            <div className="grid grid-cols-[1fr_2fr_3fr]">
                {/* 左カラム: テキストリスト */}
                <div className="pr-5">
                    <ul className="text-left space-y-4">
                        <li>
                            <h2 className="font-bold text-xl">04</h2>
                        </li>
                        <li>
                            WIDE RIBBED SHORT-SLV SWEATER <br />
                            <span className="text-sm">11348</span> <br />
                            <a href="#" className="text-blue-500 underline">ONLINE STORE</a>
                        </li>
                        <li>
                            WHITE STITCH STRAPLESS TOP <br />
                            <span className="text-sm">17435</span> <br />
                            <a href="#" className="text-blue-500 underline">ONLINE STORE</a>
                        </li>
                        <li>
                            WEATHER HIGH-WAISTED PANTS <br />
                            <span className="text-sm">13278</span> <br />
                            <a href="#" className="text-blue-500 underline">ONLINE STORE</a>
                        </li>
                        <li>
                            OVAL EARRINGS <br />
                            <span className="text-sm">19315</span> <br />
                            <a href="#" className="text-blue-500 underline">ONLINE STORE</a>
                        </li>
                    </ul>
                </div>

                {/* 中央カラム: メイン画像 */}
                <div className="flex justify-center">
                    <img
                        src="./../placeholder.png"
                        alt="Main Look"
                        className="w-full object-cover aspect-[3/4] relative"
                    />
                </div>

                {/* 右カラム: サムネイル */}
                {/* LOOKカードグリッド */}
                <div className="grid grid-cols-1 sm:grid-cols-1 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-4 gap-1 w-full px-4">
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
                {/* <div className="pl-5 grid grid-cols-3 gap-2">
                    <img src="./../placeholder.png" alt="Thumbnail 1" className="object-cover" />
                    <img src="./../placeholder.png" alt="Thumbnail 2" className="object-cover" />
                    <img src="./../placeholder.png" alt="Thumbnail 3" className="object-cover" />
                    <img src="./../placeholder.png" alt="Thumbnail 4" className="object-cover" />
                    <img src="./../placeholder.png" alt="Thumbnail 5" className="object-cover" />
                    <img src="./../placeholder.png" alt="Thumbnail 6" className="object-cover" />
                </div> */}
            </div>
        </main>
    );
}
