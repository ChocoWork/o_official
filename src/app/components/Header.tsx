"use client";

import Link from 'next/link'; // Linkコンポーネントをインポート
import Image from "next/image";
import { usePathname } from 'next/navigation';

const Header = () => {
  const pathname = usePathname();
  const menuItems = [
    { href: '/news', label: 'NEWS' },
    { href: '/item', label: 'ITEM' },
    { href: '/look', label: 'LOOK' },
    { href: '/story', label: 'STORY' },
    { href: '/contact', label: 'CONTACT' },
    { href: '/stockist', label: 'STOCKIST' },
  ];

  return (
    <header className="fixed top-0 left-0 w-full bg-white z-50 grid grid-cols-[4fr_1fr_4fr] items-center p-2 px-7">
      {/* 左側のメニュー */}
      <nav className="flex space-x-7 justify-start text-sm">
        {menuItems.map((item) => (
          <Link key={item.href} href={item.href} legacyBehavior passHref>
            <a
              className={`text-gray-700 hover:text-gray-900 pb-1 transition border-b-2 ${pathname === item.href ? 'border-black' : 'border-transparent'}`}
            >
              {item.label}
            </a>
          </Link>
        ))}
      </nav>
      {/* 中央のロゴ */}
      <div className="flex justify-center items-center">
        <Link href="/">
          <Image src="/logo.png" alt="Logo" width={40} height={40} />
        </Link>
      </div>
      {/* 右側のボタン */}
      <div className="flex space-x-2 justify-end">
        <button className="p-2 rounded hover:bg-gray-200 transition">
          <Image src="/instagram_icon.svg" alt="instagram" width={20} height={20} />
        </button>
        <button className="p-2 rounded hover:bg-gray-200 transition">
          <Image src="/search_icon.svg" alt="search" width={20} height={20} />
        </button>
        <button className="p-2 rounded hover:bg-gray-200 transition">
          <Image src="/person_white.svg" alt="login" width={20} height={20} />
        </button>
        {/* <button className="p-2 rounded hover:bg-gray-200 transition">
          <Image src="/bag_icon.svg" alt="cart" width={20} height={20} />
        </button> */}
        <Link href="/cart" className="p-2 rounded hover:bg-gray-200 transition">
          <Image src="/bag_icon.svg" alt="cart" width={20} height={20} />
        </Link>
      </div>
    </header>
  );
};

export default Header; // 別のファイルから使用できるようにするためにエクスポートする