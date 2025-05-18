import Link from 'next/link'; // Linkコンポーネントをインポート
import Image from "next/image";

const Header = () => {
  return (
    <header className="fixed top-0 left-0 w-full bg-white z-50 grid grid-cols-[4fr_1fr_4fr] items-center p-2 px-7">
      {/* 左側のメニュー */}
      <nav className="flex space-x-7 justify-start text-sm">
        <Link href="/news" className="text-gray-700 hover:text-gray-900">NEWS</Link>
        <Link href="/item" className="text-gray-700 hover:text-gray-900">ITEM</Link>
        <Link href="/look" className="text-gray-700 hover:text-gray-900">LOOK</Link>
        <Link href="/story" className="text-gray-700 hover:text-gray-900">STORY</Link>
        <Link href="/contact" className="text-gray-700 hover:text-gray-900">CONTACT</Link>
        <Link href="/stockist" className="text-gray-700 hover:text-gray-900">STOCKIST</Link>
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
        <button className="p-2 rounded hover:bg-gray-200 transition">
          <Image src="/bag_icon.svg" alt="cart" width={20} height={20} />
        </button>
      </div>
    </header>
  );
};

export default Header; // 別のファイルから使用できるようにするためにエクスポートする