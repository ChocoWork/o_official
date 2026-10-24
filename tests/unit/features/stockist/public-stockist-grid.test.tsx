import { fireEvent, render, screen, within } from "@testing-library/react";
import { PublicStockistGrid } from "@/features/stockist/components/PublicStockistGrid";
import type { PublicStockist } from "@/features/stockist/types";

const mockPush = jest.fn();
let mockSearchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/stockist",
  useSearchParams: () => mockSearchParams,
}));

function makeShop(
  id: number,
  address: string,
  overrides: Partial<PublicStockist> = {},
): PublicStockist {
  return {
    id,
    name: `店舗${id}`,
    address,
    phone: "03-1234-5678",
    time: "11:00-19:00",
    holiday: "水曜日",
    ...overrides,
  };
}

const tokyo = makeShop(1, "東京都渋谷区神宮前1-1");
const kanagawa = makeShop(2, "神奈川県横浜市中区1-1");
const hokkaido = makeShop(3, "北海道札幌市中央区1-1");
const noPrefecture = makeShop(4, "Tokyo Shibuya 1-1");

function setSearch(query: string) {
  mockSearchParams = new URLSearchParams(query);
}

function renderCatalog(stockists: PublicStockist[]) {
  return render(<PublicStockistGrid variant="catalog" stockists={stockists} />);
}

function desktopTree(container: HTMLElement) {
  const aside = container.querySelector("aside") as HTMLElement;
  return within(aside);
}

function treeLabels(container: HTMLElement) {
  const aside = container.querySelector("aside") as HTMLElement;
  return Array.from(aside.querySelectorAll("[data-ui-checkbox-label]")).map(
    (el) => el.textContent,
  );
}

function prefQuery(prefectures: string[], rest = "") {
  const params = new URLSearchParams(rest);
  params.set("pref", prefectures.join(","));
  return `/stockist?${params.toString()}`;
}

function cardTitles(container: HTMLElement) {
  return Array.from(container.querySelectorAll(".stockist-card-title")).map(
    (el) => el.textContent,
  );
}

function isChecked(element: HTMLElement) {
  return (element as HTMLInputElement).checked;
}

beforeEach(() => {
  mockPush.mockClear();
  setSearch("");
});

describe("PublicStockistGrid", () => {
  it("DD-STOCKIST-002 catalog は FILTER のボタンと ALL の箱を出し、home は section#stockist と見出し STOCKIST を出す", () => {
    const catalog = renderCatalog([tokyo]);

    expect(
      screen.getAllByRole("button", { name: "FILTER", hidden: true }),
    ).toHaveLength(2);
    expect(desktopTree(catalog.container).getByLabelText("ALL")).toBeTruthy();
    expect(catalog.container.querySelector("section#stockist")).toBeNull();
    catalog.unmount();

    const home = render(
      <PublicStockistGrid variant="home" stockists={[tokyo]} />,
    );

    expect(home.container.querySelector("section#stockist")).not.toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "STOCKIST" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "FILTER" })).toBeNull();
  });

  it("DD-STOCKIST-002 カードに h3 の店舗名・住所・電話・営業時間・定休日を出し、行のアイコンを aria-hidden にする", () => {
    const { container } = render(
      <PublicStockistGrid variant="home" stockists={[tokyo]} />,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "店舗1" }),
    ).toBeTruthy();
    expect(screen.getByText("東京都渋谷区神宮前1-1")).toBeTruthy();
    expect(screen.getByText("03-1234-5678")).toBeTruthy();
    expect(screen.getByText("11:00-19:00")).toBeTruthy();
    expect(screen.getByText("水曜日")).toBeTruthy();
    const icons = container.querySelectorAll(".stockist-card-icon");
    expect(icons).toHaveLength(4);
    icons.forEach((icon) => {
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    });
  });

  it("DD-STOCKIST-002 住所のリンクは Google Maps の検索で、住所を符号化し別窓で開く", () => {
    const address = "東京都渋谷区 1-2 #3";
    render(
      <PublicStockistGrid variant="home" stockists={[makeShop(1, address)]} />,
    );

    const link = screen.getByRole("link", { name: address });

    expect(link.getAttribute("href")).toBe(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each([
    ["03-1234-5678", "tel:0312345678"],
    ["+81 (3) 1234", "tel:+8131234"],
  ])(
    "DD-STOCKIST-002 電話 %s のリンクは数字と + だけにし、表示は元のまま",
    (phone, href) => {
      render(
        <PublicStockistGrid
          variant="home"
          stockists={[makeShop(1, "東京都渋谷区", { phone })]}
        />,
      );

      const link = screen.getByRole("link", { name: phone });

      expect(link.getAttribute("href")).toBe(href);
      expect(link.textContent).toBe(phone);
    },
  );

  it("DD-STOCKIST-002 電話が空なら電話の行を出さず、営業時間と定休日の行は出す", () => {
    const { container } = render(
      <PublicStockistGrid
        variant="home"
        stockists={[makeShop(1, "東京都渋谷区", { phone: "" })]}
      />,
    );

    expect(container.querySelector(".ri-phone-line")).toBeNull();
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
    expect(container.querySelector(".ri-time-line")).not.toBeNull();
    expect(container.querySelector(".ri-calendar-line")).not.toBeNull();
    expect(screen.getByText("11:00-19:00")).toBeTruthy();
    expect(screen.getByText("水曜日")).toBeTruthy();
  });

  it("DD-STOCKIST-002 店舗の値を HTML でなく文字として出す", () => {
    const name = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <PublicStockistGrid
        variant="home"
        stockists={[makeShop(1, "東京都渋谷区", { name })]}
      />,
    );

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(name);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("PublicStockistGrid home", () => {
  it("DD-STOCKIST-002 ホームで店が0件なら案内の文と /item への VIEW COLLECTION を出し、格子を出さない", () => {
    const { container } = render(
      <PublicStockistGrid variant="home" stockists={[]} className="x" />,
    );

    expect(
      screen.getByText(
        "現在、取扱店舗はございません。オンラインストアにて販売中です。",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "VIEW COLLECTION" }).getAttribute("href"),
    ).toBe("/item");
    expect(container.querySelector(".stockist-grid-home")).toBeNull();
  });

  it("DD-STOCKIST-002 ホームで店が1件なら 1 列で狭い幅の中央寄せにする", () => {
    const { container } = render(
      <PublicStockistGrid variant="home" stockists={[tokyo]} />,
    );

    const grid = container.querySelector(".stockist-grid-home") as HTMLElement;

    expect(grid.className).toContain("grid-cols-1 max-w-sm mx-auto");
    expect(grid.className).not.toContain("sm:grid-cols-2");
  });

  it("DD-STOCKIST-002 ホームで店が2件なら 640px 以上で 2 列にし中ほどの幅で中央寄せにする", () => {
    const { container } = render(
      <PublicStockistGrid variant="home" stockists={[tokyo, kanagawa]} />,
    );

    const grid = container.querySelector(".stockist-grid-home") as HTMLElement;

    expect(grid.className).toContain("sm:grid-cols-2 max-w-3xl mx-auto");
    expect(grid.className).not.toContain("lg:grid-cols-3");
  });

  it("DD-STOCKIST-002 ホームで店が3件なら 1024px 以上で 3 列にし中央寄せにしない", () => {
    const { container } = render(
      <PublicStockistGrid
        variant="home"
        stockists={[tokyo, kanagawa, hokkaido]}
      />,
    );

    const grid = container.querySelector(".stockist-grid-home") as HTMLElement;

    expect(grid.className).toContain("sm:grid-cols-2 lg:grid-cols-3");
    expect(grid.className).not.toContain("mx-auto");
  });

  it("DD-STOCKIST-002 ホームで店が4件なら 3 列にし、4件目のカードだけに hidden md:block を付ける", () => {
    const { container } = render(
      <PublicStockistGrid
        variant="home"
        stockists={[tokyo, kanagawa, hokkaido, noPrefecture]}
      />,
    );

    const grid = container.querySelector(".stockist-grid-home") as HTMLElement;
    const cards = Array.from(container.querySelectorAll(".stockist-card"));

    expect(grid.className).toContain("lg:grid-cols-3");
    expect(cards).toHaveLength(4);
    cards.slice(0, 3).forEach((card) => {
      expect(card.className).not.toContain("hidden md:block");
    });
    expect(cards[3].className).toContain("hidden md:block");
  });

  it("DD-STOCKIST-002 ホームの className は渡した時だけ格子の class に付く", () => {
    const withClass = render(
      <PublicStockistGrid variant="home" stockists={[tokyo]} className="x" />,
    );
    expect(
      (withClass.container.querySelector(".stockist-grid-home") as HTMLElement)
        .className,
    ).toMatch(/\bx$/);
    withClass.unmount();

    const withoutClass = render(
      <PublicStockistGrid variant="home" stockists={[tokyo]} />,
    );
    const grid = withoutClass.container.querySelector(
      ".stockist-grid-home",
    ) as HTMLElement;
    expect(grid.className.trim()).toBe(grid.className);
    expect(grid.className).not.toContain(" x");
  });
});

describe("PublicStockistGrid catalog", () => {
  it("DD-STOCKIST-002 pref が無ければ ALL に印が付き全部の店が出て、一覧の格子の列数になる", () => {
    const { container } = renderCatalog([tokyo, kanagawa]);

    expect(isChecked(desktopTree(container).getByLabelText("ALL"))).toBe(true);
    expect(cardTitles(container)).toEqual(["店舗1", "店舗2"]);
    expect(
      (container.querySelector(".stockist-grid-catalog") as HTMLElement)
        .className,
    ).toContain("sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4");
    expect(
      screen.getByRole("group", { name: "エリア（地方・都道府県）で絞り込む" }),
    ).toBeTruthy();
  });

  it("DD-STOCKIST-002 pref が空の文字なら選択なしとして全部の店を出す", () => {
    setSearch("pref=");

    const { container } = renderCatalog([tokyo, kanagawa]);

    expect(cardTitles(container)).toEqual(["店舗1", "店舗2"]);
  });

  it("DD-STOCKIST-002 pref の空白・空の切れ・許可の外の値を捨て、残った県の店だけを出す", () => {
    setSearch(`pref=${encodeURIComponent(" 東京都 ,,Tokyo,大阪府")}`);
    const osaka = makeShop(5, "大阪府大阪市北区1-1");

    const { container } = renderCatalog([tokyo, kanagawa, osaka]);

    expect(cardTitles(container)).toEqual(["店舗1", "店舗5"]);
    expect(isChecked(desktopTree(container).getByLabelText("ALL"))).toBe(false);
  });

  it("DD-STOCKIST-002 pref が許可の外の値だけなら ALL に印が付き全部の店が出る", () => {
    setSearch("pref=Tokyo");

    const { container } = renderCatalog([tokyo, kanagawa]);

    expect(isChecked(desktopTree(container).getByLabelText("ALL"))).toBe(true);
    expect(cardTitles(container)).toEqual(["店舗1", "店舗2"]);
  });

  it("DD-STOCKIST-002 店のある県だけを定義の順に選択肢へ出し、県名で始まらない店は数えない", () => {
    const { container } = renderCatalog([
      tokyo,
      kanagawa,
      hokkaido,
      noPrefecture,
    ]);

    expect(treeLabels(container)).toEqual(["ALL", "北海道", "関東"]);
    expect(
      desktopTree(container).queryByRole("button", {
        name: /北海道の都道府県を/,
      }),
    ).toBeNull();

    fireEvent.click(
      desktopTree(container).getByRole("button", {
        name: "関東の都道府県を展開",
      }),
    );

    expect(treeLabels(container)).toEqual([
      "ALL",
      "北海道",
      "関東",
      "東京",
      "神奈川",
    ]);
  });

  it("DD-STOCKIST-002 pref に県がある時は、その県を含む地方を最初から開く", () => {
    setSearch(`pref=${encodeURIComponent("東京都")}`);

    const { container } = renderCatalog([tokyo, kanagawa, hokkaido]);

    const toggle = desktopTree(container).getByRole("button", {
      name: "関東の都道府県を折りたたむ",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(isChecked(desktopTree(container).getByLabelText("東京"))).toBe(true);
    expect(isChecked(desktopTree(container).getByLabelText("神奈川"))).toBe(
      false,
    );
    expect(
      desktopTree(container).queryByRole("button", {
        name: /北海道の都道府県を/,
      }),
    ).toBeNull();
  });

  it("DD-STOCKIST-002 選択のない地方は最初は閉じていて、ボタンで開閉できる", () => {
    const { container } = renderCatalog([tokyo, kanagawa]);

    const expandButton = desktopTree(container).getByRole("button", {
      name: "関東の都道府県を展開",
    });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    expect(desktopTree(container).queryByLabelText("東京")).toBeNull();

    fireEvent.click(expandButton);

    const collapseButton = desktopTree(container).getByRole("button", {
      name: "関東の都道府県を折りたたむ",
    });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
    expect(desktopTree(container).getByLabelText("東京")).toBeTruthy();

    fireEvent.click(collapseButton);

    expect(
      desktopTree(container)
        .getByRole("button", { name: "関東の都道府県を展開" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(desktopTree(container).queryByLabelText("東京")).toBeNull();
  });

  it("DD-STOCKIST-002 選択なしで県の箱を押すと pref にその県を入れた道へ scroll:false で移る", () => {
    const { container } = renderCatalog([tokyo, kanagawa]);
    fireEvent.click(
      desktopTree(container).getByRole("button", {
        name: "関東の都道府県を展開",
      }),
    );

    fireEvent.click(desktopTree(container).getByLabelText("東京"));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(prefQuery(["東京都"]), {
      scroll: false,
    });
  });

  it("DD-STOCKIST-002 選んだ県の箱をもう一度押すと pref を消した道へ移る", () => {
    setSearch(`pref=${encodeURIComponent("東京都")}`);
    const { container } = renderCatalog([tokyo, kanagawa]);

    fireEvent.click(desktopTree(container).getByLabelText("東京"));

    expect(mockPush).toHaveBeenCalledWith("/stockist", { scroll: false });
  });

  it("DD-STOCKIST-002 地方の箱は一部だけ選ばれていれば配下の全部を定義の順で足す", () => {
    setSearch(`pref=${encodeURIComponent("神奈川県")}`);
    const { container } = renderCatalog([tokyo, kanagawa]);

    fireEvent.click(desktopTree(container).getByLabelText("関東"));

    expect(mockPush).toHaveBeenCalledWith(prefQuery(["東京都", "神奈川県"]), {
      scroll: false,
    });
  });

  it("DD-STOCKIST-002 地方の箱は配下が全部選ばれていれば印が付き、押すと配下を全部外す", () => {
    setSearch(`pref=${encodeURIComponent("東京都,神奈川県,北海道")}`);
    const { container } = renderCatalog([tokyo, kanagawa, hokkaido]);
    const regionBox = desktopTree(container).getByLabelText("関東");
    expect(isChecked(regionBox)).toBe(true);

    fireEvent.click(regionBox);

    expect(mockPush).toHaveBeenCalledWith(prefQuery(["北海道"]), {
      scroll: false,
    });
  });

  it("DD-STOCKIST-002 北海道の箱を押すと pref=北海道 が入る", () => {
    const { container } = renderCatalog([tokyo, hokkaido]);

    fireEvent.click(desktopTree(container).getByLabelText("北海道"));

    expect(mockPush).toHaveBeenCalledWith(prefQuery(["北海道"]), {
      scroll: false,
    });
  });

  it("DD-STOCKIST-002 北海道の箱は選ばれていれば印が付き、押すと外れる", () => {
    setSearch(`pref=${encodeURIComponent("北海道")}`);
    const { container } = renderCatalog([tokyo, hokkaido]);
    const box = desktopTree(container).getByLabelText("北海道");
    expect(isChecked(box)).toBe(true);

    fireEvent.click(box);

    expect(mockPush).toHaveBeenCalledWith("/stockist", { scroll: false });
  });

  it("DD-STOCKIST-002 ほかのクエリを残したまま ALL で pref だけを消す", () => {
    setSearch(`x=1&pref=${encodeURIComponent("東京都")}`);
    const { container } = renderCatalog([tokyo, kanagawa]);

    fireEvent.click(desktopTree(container).getByLabelText("ALL"));

    expect(mockPush).toHaveBeenCalledWith("/stockist?x=1", { scroll: false });
  });

  it("DD-STOCKIST-002 ほかのクエリを残したまま県を足すと pref を足して移る", () => {
    setSearch("x=1");
    const { container } = renderCatalog([tokyo, hokkaido]);

    fireEvent.click(desktopTree(container).getByLabelText("北海道"));

    expect(mockPush).toHaveBeenCalledWith(prefQuery(["北海道"], "x=1"), {
      scroll: false,
    });
  });

  it("DD-STOCKIST-002 選んだ県に店が無ければ空の文と すべて見る を出し、押すと pref を消した道へ移る", () => {
    setSearch(`pref=${encodeURIComponent("沖縄県")}`);
    const { container } = renderCatalog([tokyo, kanagawa]);

    expect(screen.getByText("該当する取扱店舗がございません。")).toBeTruthy();
    expect(container.querySelector(".stockist-grid-catalog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "すべて見る" }));

    expect(mockPush).toHaveBeenCalledWith("/stockist", { scroll: false });
  });

  it("DD-STOCKIST-002 住所が県名で始まらない店だけで県を選ぶと空の表示になり、選ばなければ出る", () => {
    setSearch(`pref=${encodeURIComponent("東京都")}`);
    const filtered = renderCatalog([noPrefecture]);

    expect(screen.getByText("該当する取扱店舗がございません。")).toBeTruthy();
    filtered.unmount();

    setSearch("");
    const all = renderCatalog([noPrefecture]);

    expect(cardTitles(all.container)).toEqual(["店舗4"]);
  });

  it("DD-STOCKIST-002 公開の店が0件なら選択肢は ALL だけで、格子の代わりに空の表示を出す", () => {
    const { container } = renderCatalog([]);

    expect(treeLabels(container)).toEqual(["ALL"]);
    expect(screen.getByText("該当する取扱店舗がございません。")).toBeTruthy();
  });

  it("DD-STOCKIST-002 最初に描いた後に pref が変わると、選択は URL に合わせて変わるが開け閉めは前のまま", () => {
    const stockists = [tokyo, kanagawa, hokkaido];
    const { container, rerender } = renderCatalog(stockists);
    expect(
      desktopTree(container)
        .getByRole("button", { name: "関東の都道府県を展開" })
        .getAttribute("aria-expanded"),
    ).toBe("false");

    setSearch(`pref=${encodeURIComponent("東京都")}`);
    rerender(<PublicStockistGrid variant="catalog" stockists={stockists} />);

    expect(cardTitles(container)).toEqual(["店舗1"]);
    expect(
      desktopTree(container)
        .getByRole("button", { name: "関東の都道府県を展開" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("DD-STOCKIST-002 FILTER を押すと引き出しが開き、閉じるボタンで閉じる", () => {
    const { container } = renderCatalog([tokyo, kanagawa]);
    const floating = container.querySelector(
      '[data-filter-button="floating"]',
    ) as HTMLElement;
    expect(floating.getAttribute("aria-expanded")).toBe("false");
    expect(floating.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(floating);

    expect(floating.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog)
        .getByLabelText("ALL")
        .closest("[data-ui-checkbox]")
        ?.getAttribute("data-ui-checkbox-size"),
    ).toBe("xs");
    expect(
      desktopTree(container)
        .getByLabelText("ALL")
        .closest("[data-ui-checkbox]")
        ?.getAttribute("data-ui-checkbox-size"),
    ).toBe("3xs");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close filter drawer" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(floating.getAttribute("aria-expanded")).toBe("false");
  });

  it("DD-STOCKIST-002 引き出しの外側を押すと閉じ、中で選んでも閉じない", () => {
    const { container } = renderCatalog([tokyo, hokkaido]);
    fireEvent.click(
      container.querySelector('[data-filter-button="floating"]') as HTMLElement,
    );
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByLabelText("北海道"));

    expect(mockPush).toHaveBeenCalledWith(prefQuery(["北海道"]), {
      scroll: false,
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(document.querySelector(".drawer-overlay") as HTMLElement);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("DD-STOCKIST-002 置き台の FILTER は aria-hidden の中で tabIndex=-1 になり、押しても引き出しが開かない", () => {
    const { container } = renderCatalog([tokyo]);
    const placeholder = container.querySelector(
      '[data-filter-button="placeholder"]',
    ) as HTMLElement;

    expect(placeholder.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(placeholder.getAttribute("tabindex")).toBe("-1");
    expect(placeholder.getAttribute("aria-haspopup")).toBeNull();
    expect(placeholder.getAttribute("aria-expanded")).toBeNull();

    fireEvent.click(placeholder);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
