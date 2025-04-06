import Image from "next/image";

const Header = () => {
  return (
    <header className="grid grid-cols-[4fr_1fr_4fr] items-center p-2 pl-10 pr-10"> {/* bg-gray-100 */}
      {/* 左側のメニュー */}
      <nav className="flex space-x-7 justify-start text-sm">
        <a href="#" className="text-gray-700 hover:text-gray-900">NEWS</a>
        <a href="#" className="text-gray-700 hover:text-gray-900">ITEM</a>
        <a href="#" className="text-gray-700 hover:text-gray-900">LOOK</a>
        <a href="#" className="text-gray-700 hover:text-gray-900">STORY</a>
        <a href="#" className="text-gray-700 hover:text-gray-900">CONTACT</a>
        <a href="#" className="text-gray-700 hover:text-gray-900">STOCKIST</a>
      </nav>
      {/* 中央のロゴ */}
      <div className="flex justify-center items-center">
        <Image src="/logo.png" alt="Logo" width={40} height={40} />
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