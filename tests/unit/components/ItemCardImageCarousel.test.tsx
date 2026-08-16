import { fireEvent, render, screen } from "@testing-library/react";
import { ItemCardMedia } from "@/features/items/components/ItemCard";

// FREQ-272: desktop の ITEM カードは、画像3枚以上のときだけホバー中に下線を出し、
// ホバー中は2枚目を表示する。E2E では実データに3枚以上の商品が無いと検証できないため、
// ここでロジックを固定条件で検証する。

const frameOf = (urls: string[]) =>
  render(
    <ItemCardMedia imageUrl={urls[0]} imageUrls={urls} alt="テスト商品" />,
  );

beforeEach(() => {
  // lg 以上として扱う
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: query === "(min-width: 1024px)",
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;

  // jsdom は scrollTo を実装していない
  Element.prototype.scrollTo = jest.fn();
});

describe("ItemCardMedia の複数画像カルーセル", () => {
  it("FREQ-272-AC-01: 画像3枚以上ならホバー時だけ表示するクラスが付く", () => {
    frameOf(["/a.jpg", "/b.jpg", "/c.jpg"]);

    const indicator = screen.getByTestId("item-card-carousel-indicator");
    expect(indicator).toHaveClass("lg:invisible");
    expect(indicator).toHaveClass("lg:group-hover:visible");
  });

  it("FREQ-272-AC-02: 画像2枚なら desktop では表示しない", () => {
    frameOf(["/a.jpg", "/b.jpg"]);

    const indicator = screen.getByTestId("item-card-carousel-indicator");
    expect(indicator).toHaveClass("lg:invisible");
    expect(indicator).not.toHaveClass("lg:group-hover:visible");
  });

  it("FREQ-272-AC-03: ホバーで2枚目、離れると1枚目が選択される", () => {
    frameOf(["/a.jpg", "/b.jpg", "/c.jpg"]);

    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("data-active", "true");

    fireEvent.mouseEnter(
      screen.getByTestId("item-card-carousel").parentElement!,
    );
    expect(tabs[1]).toHaveAttribute("data-active", "true");

    fireEvent.mouseLeave(
      screen.getByTestId("item-card-carousel").parentElement!,
    );
    expect(tabs[0]).toHaveAttribute("data-active", "true");
  });

  it("FREQ-272-AC-04: 送りボタンのアイコンは 15x15 のシェブロン", () => {
    frameOf(["/a.jpg", "/b.jpg", "/c.jpg"]);

    const icon = screen
      .getByTestId("item-card-carousel-next")
      .querySelector("svg");
    expect(icon).toHaveAttribute("viewBox", "0 0 15 15");
  });

  it("FREQ-272-AC-05: ホバーの切り替えは即時、送りボタンはスライド", () => {
    frameOf(["/a.jpg", "/b.jpg", "/c.jpg"]);
    const scrollTo = Element.prototype.scrollTo as jest.Mock;
    const frame = screen.getByTestId("item-card-carousel").parentElement!;

    fireEvent.mouseEnter(frame);
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );

    fireEvent.click(screen.getByTestId("item-card-carousel-next"));
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );

    fireEvent.mouseLeave(frame);
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );
  });

  it("FREQ-273-AC-02: 画像2枚なら送りボタンを出さない", () => {
    frameOf(["/a.jpg", "/b.jpg"]);

    expect(screen.queryByTestId("item-card-carousel-next")).toBeNull();
    expect(screen.queryByTestId("item-card-carousel-prev")).toBeNull();
  });

  it("FREQ-273-AC-01: スクロール領域にスクロールバー非表示のクラスが付く", () => {
    frameOf(["/a.jpg", "/b.jpg"]);

    const scroller = screen.getByTestId("item-card-carousel");
    expect(scroller).toHaveClass("overflow-y-hidden");
    expect(scroller).toHaveClass("[scrollbar-width:none]");
    expect(scroller).toHaveClass("[&::-webkit-scrollbar]:hidden");
  });

  it("画像が1枚だけならカルーセルにしない", () => {
    frameOf(["/a.jpg"]);

    expect(screen.queryByTestId("item-card-carousel")).toBeNull();
    expect(screen.queryByTestId("item-card-carousel-indicator")).toBeNull();
  });
});
