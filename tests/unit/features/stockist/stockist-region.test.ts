import {
  getPrefectureFromAddress,
  getPrefectureShortLabel,
  STOCKIST_REGIONS,
} from "@/features/stockist/region";

describe("getPrefectureFromAddress", () => {
  it("DD-STOCKIST-005 県名で始まる住所から正式な県名を返す", () => {
    expect(getPrefectureFromAddress("東京都渋谷区神宮前1-1")).toBe("東京都");
  });

  it("DD-STOCKIST-005 前に空白がある住所でも県名を返す", () => {
    expect(getPrefectureFromAddress("  大阪府大阪市")).toBe("大阪府");
  });

  it("DD-STOCKIST-005 北海道を返す", () => {
    expect(getPrefectureFromAddress("北海道札幌市")).toBe("北海道");
  });

  it("DD-STOCKIST-005 京都府の住所を東京都にしない", () => {
    expect(getPrefectureFromAddress("京都府京都市")).toBe("京都府");
  });

  it.each(["Tokyo", "渋谷区神宮前1-1", "東京", ""])(
    "DD-STOCKIST-005 県名で始まらない住所 %p は null を返す",
    (address) => {
      expect(getPrefectureFromAddress(address)).toBeNull();
    },
  );

  it("DD-STOCKIST-005 地方の定義にある47県すべてを判定できる", () => {
    const all = STOCKIST_REGIONS.flatMap((entry) => [...entry.prefectures]);

    expect(all).toHaveLength(47);
    for (const prefecture of all) {
      expect(getPrefectureFromAddress(`${prefecture}テスト市1-1`)).toBe(
        prefecture,
      );
    }
  });
});

describe("getPrefectureShortLabel", () => {
  it("DD-STOCKIST-006 北海道はそのまま返す", () => {
    expect(getPrefectureShortLabel("北海道")).toBe("北海道");
  });

  it.each([
    ["東京都", "東京"],
    ["大阪府", "大阪"],
    ["京都府", "京都"],
    ["青森県", "青森"],
  ])("DD-STOCKIST-006 %s の末尾の都・府・県を落として %s にする", (input, expected) => {
    expect(getPrefectureShortLabel(input)).toBe(expected);
  });

  it("DD-STOCKIST-006 末尾が都・府・県でない値はそのまま返す", () => {
    expect(getPrefectureShortLabel("ABC")).toBe("ABC");
  });
});
