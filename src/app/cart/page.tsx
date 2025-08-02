"use client"; // この行を追加してクライアントコンポーネントとして明示

import React, { useState } from "react";
import { Cart } from '../components/Cart';
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
    <main className="px-5 pt-20">
      <Cart items={cartItems} onRemoveItem={handleRemove} />
    </main>
  );
}
