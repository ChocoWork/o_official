export default function StockistPage() {
  // 各地域のデータを配列で管理
  const stockists = [
    {
      title: "TOKYO",
      places: [
        "BARNEYS NEW YORK GINZA Kojun Building 6-8-7 Ginza Chuo-Ku Tokyo 0120 137 007",
        "BARNEYS NEW YORK ROPPONGI 7-7-7 Roppongi Minato-Ku Tokyo 0120 137 007",
        "BIOTOP 4-6-44 Shirokanedai Minato-Ku Tokyo 03 3444 2421",
        "EDITION LUMINE SHINJUKU B1F Lumine1 1-1-5 Nishishinjuku Shinjuku-Ku Tokyo 03 3343 0121",
        "EDITION OMOTESANDO HILLS 2F 4-12-10 Jingumae Shibuya-Ku Tokyo 03 3403 8086",
      ],
    },
    {
      title: "HOKKAIDO",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
    {
      title: "TOHOKU",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
    {
      title: "KANTO",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
    {
      title: "CHUBU",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
    {
      title: "KINKI",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
    {
      title: "CHUGOKU",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
    {
      title: "SHIKOKU",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
    {
      title: "KYUSYU",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
    {
      title: "OKINAWA",
      places: [
        "MARUIIMAI RE-STYLE 3F Odori Building Minami1-Jo Nishi 2-Chome Chuo-Ku Sapporo Hokkaido 011 205 2333",
        "MAW 1F Alpha 2-5 Building Minami 2-Jo Nishi 5-Chome Chuo-Ku Sapporo Hokkaido 011 271 0505",
        "UNITED ARROWS SAPPORO 1.2F Sapporo Parco Minami1-Jo Nishi 3-Chome Chuo-Ku Sapporo Hokkaido 011 218 6001",
      ],
    },
  ];

  return (
    <main className="px-5 pt-40 pb-60">
      <div id="mainContents">
        <div id="article" className="flex justify-center">
          <div id="articleInnerList">
            {stockists.map((stockist, index) => (
              <div key={index} className="flex mb-5">
                <h4 className="font-bold w-48">{stockist.title}</h4>
                <span className="articleInnerIcon">
                  <span className="articleInnerBars"></span>
                </span>
                <ul>
                  {stockist.places.map((place, idx) => (
                    <li className="mb-half" key={idx}>{place}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}