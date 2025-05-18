import React from "react";
import Item from './../components/Item';

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

export default function ItemPage() {
  return (
    <main className="pt-12 pb-60">
      {/* <section id="itemCategory">
        <div className="p-6">itemカテゴリボタンを配置（複数選択可）</div>
      </section> */}
      <section id="itemFilter" className="fixed w-full bg-white z-10 shadow-md">
        {/* Header */}
        <div className="flex justify-between items-center">
          <button
            // onClick={() => setFilter(filter === "Outerwear" ? "" : "Outerwear")}
            className="px-7 py-6"
          >
            {/* FILTER {filter === "Outerwear" ? "-" : "+"} */}
            FILTER +
          </button>
          <button
            // onClick={() =>
            //   setSortOrder(sortOrder === "asc" ? "desc" : "asc")
            // }
            className="px-7 py-6"
          >
            {/* SORT {sortOrder === "asc" ? "▲" : "▼"} */}
            SORT
          </button>
        </div>
      </section>
      <div id="contact">
        <div id="contactList" className="flex justify-center">
            {/* 商品カードグリッド */}
            <Item items={items} />
        </div>
      </div>
    </main>
  );
}
