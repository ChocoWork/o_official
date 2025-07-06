"use client"; // この行を追加してクライアントコンポーネントとして明示

import React, { useState } from "react";
import Image from 'next/image'; // next/imageをインポート

export default function CartPage() {
  // サンプルデータ（実際にはAPIなどから取得する）
  const [cartItems, setCartItems] = useState([
    {
      id: 1,
      name: "LAYERED PANTS",
      size: "1",
      price: 41800,
      quantity: 1,
      image: "/path/to/layered_pants.jpg",
    },
    {
      id: 2,
      name: "GURKHA SANDALS",
      size: "24",
      price: 61600,
      quantity: 1,
      image: "/path/to/gurkha_sandals.jpg",
    },
  ]);

  const handleRemove = (id: number) => {
    setCartItems(cartItems.filter(item => item.id !== id));
  };

  return (
    <main className="px-5 pt-40 pb-60">
      <div id="cart">
        <div id="mainContents" className="ja w-full">
          {/* <div className="max-w-3xl mx-auto p-6"> */}
          <div id="data-cart-wrapper">
            <form action="/cart" method="post" noValidate className="cart">
              <table className="w-full">
                <thead className="cart_row cart_row--heading">
                  <tr>
                    <th className=" px-4 py-2">商品名</th>
                    <th className=" px-4 py-2">価格</th>
                    <th className=" px-4 py-2">数量</th>
                    <th className=" px-4 py-2">合計</th>
                    <th className=" px-4 py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                {cartItems.map(item => (
                    <tr key={item.id}>
                    <td className="border-t border-b px-4 py-2">
                        <div className="flex items-center gap-x-4">
                          <div>
                            <Image src={item.image} alt={item.name} width={63.5} height={95} className="w-16 h-16 object-cover" />
                          </div>
                          <div>
                            {item.name} <br /> Size: {item.size}
                          </div>
                        </div>
                    </td>
                    <td className="border-t border-b px-4 py-2">
                        ¥{item.price.toLocaleString()}
                    </td>
                    <td className="border-t border-b px-4 py-2 text-center">
                        {item.quantity}
                    </td>
                    <td className="border-t border-b px-4 py-2">
                        ¥{(item.price * item.quantity).toLocaleString()}
                    </td>
                    <td className="border-t border-b px-4 py-2 text-center">
                        <button
                        onClick={() => handleRemove(item.id)}
                        className="text-red-600 hover:underline"
                        >
                        削除
                        </button>
                    </td>
                    </tr>
                ))}
                </tbody>
              </table>
              <div className="cart_footer">
                
              </div>
            </form>
          </div>
        </div>

      </div>
    </main>
  );
}
