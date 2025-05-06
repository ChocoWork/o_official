import Image from "next/image";

const Footer = () => {
  return (
    <footer className="pl-5 pr-5">
      <hr />
        <div className="grid grid-cols-[1fr_4fr] items-center p-10">
          <div className="flex space-x-7 pl-5 justify-center">
            <Image src="/logo.png" alt="Logo" width={100} height={100} />
          </div>
          <div className="grid grid-cols-[3fr_1fr] justify-start text-sm">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6 pl-40 pr-40">
              <div>
                NEWS
              </div>
              <div>
                ITEM
                <ul className="mt-2 ml-3 space-y-1">
                  <li> ALL</li>
                  <li> OUTERS</li>
                  <li> TOPS</li>
                  <li> BOTTOMS</li>
                </ul>
              </div>
              <div>
                LOOK
              </div>
              <div>
                STORY
              </div>
              <div>
                CONTACT
              </div>
              <div>
                STOCKIST
              </div>
            </div>
            <div>
              NEWS LATER
              <input
                type="text"
                placeholder="メールアドレスを入力"
                className="mt-2 p-2 w-full border border-gray-300 rounded"
              />
            </div>
            
          </div>

        </div>
      <hr />
        <div className="grid grid-cols-[1fr_1fr] items-center p-2">
          <div className="flex space-x-7 pl-5 justify-start">
            © O
          </div>
          <div className="flex space-x-7 pr-5 justify-end">
            <a href="#" className="text-gray-700 text-sm hover:text-gray-900">Privacy Policy</a>
            <a href="#" className="text-gray-700 text-sm hover:text-gray-900">Terms Of Use</a>
          </div>
        </div>
    </footer>
  );
};

export default Footer; // 別のファイルから使用できるようにするためにエクスポートする