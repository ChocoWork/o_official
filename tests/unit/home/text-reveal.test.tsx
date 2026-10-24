import React from "react";
import { act, render, screen } from "@testing-library/react";
import TextReveal from "@/components/animations/TextReveal";

type IoCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

type FakeObserver = {
  callback: IoCallback;
  options: IntersectionObserverInit | undefined;
  observe: jest.Mock;
  unobserve: jest.Mock;
  disconnect: jest.Mock;
};

type FakeQuery = {
  matches: boolean;
  media: string;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
};

let observers: FakeObserver[];
let query: FakeQuery;
let matchMediaMock: jest.Mock;

const originalMatchMedia = window.matchMedia;
const originalIntersectionObserver = window.IntersectionObserver;

function setupBrowser(reduceMotion: boolean) {
  observers = [];
  query = {
    matches: reduceMotion,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  matchMediaMock = jest.fn(() => query);
  window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;
  window.IntersectionObserver = jest.fn(function (callback: IoCallback, options?: IntersectionObserverInit) {
    const observer: FakeObserver = {
      callback,
      options,
      observe: jest.fn(),
      unobserve: jest.fn(),
      disconnect: jest.fn(),
    };
    observers.push(observer);
    return observer;
  }) as unknown as typeof window.IntersectionObserver;
}

function latestObserver(): FakeObserver {
  return observers[observers.length - 1];
}

function intersect(isIntersecting: boolean) {
  act(() => {
    latestObserver().callback([{ isIntersecting }]);
  });
}

function spans(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("span"));
}

function fireMotionChange(matches: boolean) {
  query.matches = matches;
  const handler = query.addEventListener.mock.calls[0][1] as () => void;
  act(() => {
    handler();
  });
}

describe("TextReveal", () => {
  beforeEach(() => {
    setupBrowser(false);
  });

  afterAll(() => {
    window.matchMedia = originalMatchMedia;
    window.IntersectionObserver = originalIntersectionObserver;
  });

  it("DD-HOME-003 text だけ渡すと div で描かれ、名前が text で、文字数ぶんの span が全部 aria-hidden になる", () => {
    const { container } = render(<TextReveal text="Hello" />);

    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("DIV");
    expect(root.getAttribute("class")).toBe("");
    expect(root).toHaveAttribute("aria-label", "Hello");
    const chars = spans(container);
    expect(chars).toHaveLength(5);
    expect(chars.map((s) => s.textContent).join("")).toBe("Hello");
    chars.forEach((s) => {
      expect(s).toHaveAttribute("aria-hidden", "true");
      expect(s.style.display).toBe("inline-block");
    });
  });

  it("DD-HOME-003 as・className・delay・stagger・once を渡すとそのとおりに描かれ、3文字目の待ちが delay+2×stagger になる", () => {
    const { container } = render(
      <TextReveal text="abc" as="h1" className="hero-title" delay={100} stagger={50} once={false} />,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "abc" });
    expect(heading).toHaveClass("hero-title");
    const third = spans(container)[2];
    expect(third.style.transition).toContain("opacity 0.4s cubic-bezier(0.25,0.1,0.25,1) 200ms");
    expect(third.style.transition).toContain("transform 0.4s cubic-bezier(0.25,0.1,0.25,1) 200ms");
    expect(spans(container)[0].style.transition).toContain("100ms");
  });

  it.each(["h2", "h3", "p", "span"] as const)("DD-HOME-003 as=%s の要素で描かれる", (tag) => {
    const { container } = render(<TextReveal text="x" as={tag} />);

    expect((container.firstElementChild as HTMLElement).tagName).toBe(tag.toUpperCase());
  });

  it("DD-HOME-003 空白は NBSP にして詰まらない", () => {
    const { container } = render(<TextReveal text="a b" />);

    const chars = spans(container);
    expect(chars).toHaveLength(3);
    expect(chars[1].textContent).toBe("\u00a0");
    expect(chars[1].textContent).not.toBe(" ");
  });

  it("DD-HOME-003 描いた直後は全部の span が透明で下にずれ、移ろいが付く", () => {
    const { container } = render(<TextReveal text="ab" />);

    spans(container).forEach((s) => {
      expect(s.style.opacity).toBe("0");
      expect(s.style.transform).toBe("translateY(100%)");
      expect(s.style.transition).not.toBe("none");
      expect(s.style.transition).toContain("0.4s");
      expect(s.style.willChange).toBe("opacity, transform");
    });
  });

  it("DD-HOME-003 画面の見張りを1割で始め、要素を見張る", () => {
    const { container } = render(<TextReveal text="ab" />);

    expect(observers).toHaveLength(1);
    expect(latestObserver().options).toEqual({ threshold: 0.1 });
    expect(latestObserver().observe).toHaveBeenCalledWith(container.firstElementChild);
  });

  it("DD-HOME-003 画面に入ると（once 真）全部の span が見え、見張りをやめる", () => {
    const { container } = render(<TextReveal text="ab" />);

    intersect(true);

    spans(container).forEach((s) => {
      expect(s.style.opacity).toBe("1");
      expect(s.style.transform).toBe("translateY(0)");
    });
    expect(latestObserver().unobserve).toHaveBeenCalledWith(container.firstElementChild);
  });

  it("DD-HOME-003 画面から出ても（once 真）見えたままになる", () => {
    const { container } = render(<TextReveal text="ab" />);

    intersect(true);
    intersect(false);

    spans(container).forEach((s) => expect(s.style.opacity).toBe("1"));
  });

  it("DD-HOME-003 画面に入る前に出た通知（once 真）では見えない", () => {
    const { container } = render(<TextReveal text="ab" />);

    intersect(false);

    spans(container).forEach((s) => expect(s.style.opacity).toBe("0"));
    expect(latestObserver().unobserve).not.toHaveBeenCalled();
  });

  it("DD-HOME-003 画面に入ると（once 偽）見え、見張りはやめない", () => {
    const { container } = render(<TextReveal text="ab" once={false} />);

    intersect(true);

    spans(container).forEach((s) => expect(s.style.opacity).toBe("1"));
    expect(latestObserver().unobserve).not.toHaveBeenCalled();
  });

  it("DD-HOME-003 画面から出ると（once 偽）透明に戻る", () => {
    const { container } = render(<TextReveal text="ab" once={false} />);

    intersect(true);
    intersect(false);

    spans(container).forEach((s) => {
      expect(s.style.opacity).toBe("0");
      expect(s.style.transform).toBe("translateY(100%)");
    });
  });

  it("DD-HOME-003 動きを減らす設定が最初から有効なら、画面に入る前から見えて移ろいが none になる", () => {
    setupBrowser(true);
    const { container } = render(<TextReveal text="ab" />);

    expect(matchMediaMock).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    spans(container).forEach((s) => {
      expect(s.style.opacity).toBe("1");
      expect(s.style.transform).toBe("translateY(0)");
      expect(s.style.transition).toBe("none");
    });
  });

  it("DD-HOME-003 描いた後に動きを減らす設定へ変わると移ろいが none になり、戻すと移ろいが戻る", () => {
    const { container } = render(<TextReveal text="ab" />);
    expect(spans(container)[0].style.transition).not.toBe("none");
    expect(query.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    fireMotionChange(true);
    spans(container).forEach((s) => {
      expect(s.style.transition).toBe("none");
      expect(s.style.opacity).toBe("1");
    });

    fireMotionChange(false);
    spans(container).forEach((s) => {
      expect(s.style.transition).not.toBe("none");
      expect(s.style.opacity).toBe("0");
    });
  });

  it("DD-HOME-003 部品を外すと設定の購読をやめ、見張りを止める", () => {
    const { unmount } = render(<TextReveal text="ab" />);
    const handler = query.addEventListener.mock.calls[0][1];
    const observer = latestObserver();

    unmount();

    expect(query.removeEventListener).toHaveBeenCalledWith("change", handler);
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it("DD-HOME-003 once が変わると見張りを作り直す", () => {
    const { rerender } = render(<TextReveal text="ab" once />);
    const first = latestObserver();

    rerender(<TextReveal text="ab" once={false} />);

    expect(first.disconnect).toHaveBeenCalled();
    expect(observers).toHaveLength(2);
    expect(latestObserver()).not.toBe(first);
  });

  it("DD-HOME-003 要素の参照が取れないときは見張りを作らず、外してもエラーにならない", () => {
    const realUseRef = React.useRef;
    // 本物の useRef を呼んで hook の順番は保ちつつ、React が要素を入れても空のままの参照を返す
    const useRefSpy = jest.spyOn(React, "useRef").mockImplementation(((initial: unknown) => {
      realUseRef(initial);
      return {
        get current() {
          return null;
        },
        set current(_value: unknown) {},
      };
    }) as typeof React.useRef);

    try {
      const { container, unmount } = render(<TextReveal text="ab" />);

      expect(observers).toHaveLength(0);
      spans(container).forEach((s) => expect(s.style.opacity).toBe("0"));
      expect(() => unmount()).not.toThrow();
    } finally {
      useRefSpy.mockRestore();
    }
  });

  it("DD-HOME-003 HTML を含む文字列を要素にせず字として出す", () => {
    const { container } = render(<TextReveal text="<b>x</b>" />);

    expect(container.querySelector("b")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("aria-label", "<b>x</b>");
    expect(spans(container).map((s) => s.textContent).join("")).toBe("<b>x</b>");
  });
});
