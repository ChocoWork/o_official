import { act, renderHook, waitFor } from "@testing-library/react";
import { useTurnstileWidget } from "@/hooks/useTurnstileWidget";

type RenderOptions = {
  sitekey: string;
  size?: "normal" | "compact" | "flexible";
  callback: (token: string) => void;
};

const renderMock = jest.fn<string, [HTMLElement, RenderOptions]>();
const resetMock = jest.fn<void, [string]>();
const removeMock = jest.fn<void, [string]>();

function installTurnstile() {
  window.turnstile = { render: renderMock, reset: resetMock, remove: removeMock };
}

/** ResizeObserver の最小のスタブ。fit を手で呼べるように、コールバックと呼び出しを残す。 */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: () => void) {
    ResizeObserverStub.instances.push(this);
  }
}

/** jsdom は寸法を持たないので、採寸される値を要素ごとに固定する。 */
function fixSize(el: HTMLElement, key: "offsetHeight" | "clientWidth", value: number) {
  Object.defineProperty(el, key, { value, configurable: true });
}

function makeContainer(options: { width: number; widgetHeight: number | null }) {
  const container = document.createElement("div");
  fixSize(container, "clientWidth", options.width);
  let widget: HTMLElement | null = null;
  if (options.widgetHeight !== null) {
    widget = document.createElement("div");
    fixSize(widget, "offsetHeight", options.widgetHeight);
    container.appendChild(widget);
  }
  return { container, widget };
}

describe("useTurnstileWidget", () => {
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

  beforeEach(() => {
    jest.clearAllMocks();
    renderMock.mockReset();
    renderMock.mockReturnValue("widget-1");
    ResizeObserverStub.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
    installTurnstile();
    delete window.onTurnstileSuccess;
  });

  afterEach(() => {
    delete window.turnstile;
    delete window.onTurnstileSuccess;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  });

  describe("描画", () => {
    it("DD-AUTH-012 鍵・入れ物・窓の turnstile があれば flexible で描き、2 回目は描かない", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container } = makeContainer({ width: 320, widgetHeight: null });

      act(() => result.current.containerRef(container));

      expect(renderMock).toHaveBeenCalledTimes(1);
      expect(renderMock).toHaveBeenCalledWith(
        container,
        expect.objectContaining({ sitekey: "site-key", size: "flexible" }),
      );

      act(() => result.current.renderWidget());
      expect(renderMock).toHaveBeenCalledTimes(1);
    });

    it("DD-AUTH-012 鍵が無ければ描かない", () => {
      const { result } = renderHook(() => useTurnstileWidget("", jest.fn()));
      const { container } = makeContainer({ width: 320, widgetHeight: null });

      act(() => result.current.containerRef(container));
      act(() => result.current.renderWidget());

      expect(renderMock).not.toHaveBeenCalled();
    });

    it("DD-AUTH-012 入れ物が無ければ描かない", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));

      act(() => result.current.renderWidget());

      expect(renderMock).not.toHaveBeenCalled();
    });

    it("DD-AUTH-012 窓の turnstile が無いうちは描かず、Script の読み終わりに renderWidget を呼ぶと描く", () => {
      delete window.turnstile;
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container } = makeContainer({ width: 320, widgetHeight: null });

      act(() => result.current.containerRef(container));
      expect(renderMock).not.toHaveBeenCalled();

      installTurnstile();
      act(() => result.current.renderWidget());

      expect(renderMock).toHaveBeenCalledTimes(1);
    });

    it("DD-AUTH-012 入れ物が付け替わっても renderWidget は同じ関数のままで、新しい入れ物に描ける", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const firstRenderWidget = result.current.renderWidget;
      const first = makeContainer({ width: 320, widgetHeight: null }).container;
      const second = makeContainer({ width: 320, widgetHeight: null }).container;

      act(() => result.current.containerRef(first));
      act(() => result.current.containerRef(null));
      renderMock.mockClear();
      act(() => result.current.containerRef(second));

      expect(result.current.renderWidget).toBe(firstRenderWidget);
      expect(renderMock).toHaveBeenCalledWith(second, expect.anything());
    });

    it("DD-AUTH-012 入れ物が差し替わったら、前の描画を消して描き直す", () => {
      renderMock.mockReturnValueOnce("widget-1").mockReturnValueOnce("widget-2");
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const first = makeContainer({ width: 320, widgetHeight: null }).container;
      const second = makeContainer({ width: 320, widgetHeight: null }).container;

      act(() => result.current.containerRef(first));
      act(() => result.current.containerRef(second));

      expect(removeMock).toHaveBeenCalledWith("widget-1");
      expect(renderMock).toHaveBeenCalledTimes(2);
      expect(renderMock).toHaveBeenLastCalledWith(second, expect.anything());
    });

    it("DD-AUTH-012 描いた後の onToken には、最新の関数が呼ばれる", () => {
      const firstOnToken = jest.fn();
      const nextOnToken = jest.fn();
      const { result, rerender } = renderHook(
        ({ onToken }) => useTurnstileWidget("site-key", onToken),
        { initialProps: { onToken: firstOnToken } },
      );
      const { container } = makeContainer({ width: 320, widgetHeight: null });
      act(() => result.current.containerRef(container));
      const options = renderMock.mock.calls[0][1];

      rerender({ onToken: nextOnToken });
      options.callback("fresh-token");

      expect(nextOnToken).toHaveBeenCalledWith("fresh-token");
      expect(firstOnToken).not.toHaveBeenCalled();
    });
  });

  describe("onTurnstileSuccess", () => {
    it("DD-AUTH-012 鍵があれば窓に置き、呼ぶと最新の onToken にトークンが渡る", () => {
      const onToken = jest.fn();
      renderHook(() => useTurnstileWidget("site-key", onToken));

      expect(window.onTurnstileSuccess).toBeInstanceOf(Function);
      window.onTurnstileSuccess?.("injected-token");

      expect(onToken).toHaveBeenCalledWith("injected-token");
    });

    it("DD-AUTH-012 鍵が無ければ置かない", () => {
      renderHook(() => useTurnstileWidget("", jest.fn()));

      expect(window.onTurnstileSuccess).toBeUndefined();
    });

    it("DD-AUTH-012 外す時に消す", () => {
      const { unmount } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      expect(window.onTurnstileSuccess).toBeDefined();

      unmount();

      expect(window.onTurnstileSuccess).toBeUndefined();
    });

    it("DD-AUTH-012 外す時に既に無くても落ちない", () => {
      const { unmount } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      delete window.onTurnstileSuccess;

      expect(() => unmount()).not.toThrow();
      expect(window.onTurnstileSuccess).toBeUndefined();
    });
  });

  describe("引き直し", () => {
    it("DD-AUTH-012 描いていれば、トークンを空にして窓の turnstile で引き直す", () => {
      const onToken = jest.fn();
      const { result } = renderHook(() => useTurnstileWidget("site-key", onToken));
      const { container } = makeContainer({ width: 320, widgetHeight: null });
      act(() => result.current.containerRef(container));

      act(() => result.current.resetWidget());

      expect(onToken).toHaveBeenCalledWith("");
      expect(resetMock).toHaveBeenCalledWith("widget-1");
    });

    it("DD-AUTH-012 描いていなければ、トークンを空にするだけで窓の turnstile は呼ばない", () => {
      const onToken = jest.fn();
      const { result } = renderHook(() => useTurnstileWidget("site-key", onToken));

      act(() => result.current.resetWidget());

      expect(onToken).toHaveBeenCalledWith("");
      expect(resetMock).not.toHaveBeenCalled();
    });

    it("DD-AUTH-012 描いた後に窓の turnstile が無くなっていても落ちず、トークンは空にする", () => {
      const onToken = jest.fn();
      const { result } = renderHook(() => useTurnstileWidget("site-key", onToken));
      const { container } = makeContainer({ width: 320, widgetHeight: null });
      act(() => result.current.containerRef(container));
      delete window.turnstile;

      expect(() => act(() => result.current.resetWidget())).not.toThrow();

      expect(onToken).toHaveBeenCalledWith("");
      expect(resetMock).not.toHaveBeenCalled();
    });
  });

  describe("外す時", () => {
    it("DD-AUTH-012 描いていれば消す", () => {
      const { result, unmount } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container } = makeContainer({ width: 320, widgetHeight: null });
      act(() => result.current.containerRef(container));

      unmount();

      expect(removeMock).toHaveBeenCalledWith("widget-1");
    });

    it("DD-AUTH-012 描いていなければ消す呼び出しをしない", () => {
      const { unmount } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));

      unmount();

      expect(removeMock).not.toHaveBeenCalled();
    });

    it("DD-AUTH-012 描いた後に窓の turnstile が無くなっていても落ちない", () => {
      const { result, unmount } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container } = makeContainer({ width: 320, widgetHeight: null });
      act(() => result.current.containerRef(container));
      delete window.turnstile;

      expect(() => unmount()).not.toThrow();
      expect(removeMock).not.toHaveBeenCalled();
    });

    it("DD-AUTH-012 消した後は id が戻るので、同じ入れ物が戻ると描き直せる", () => {
      renderMock.mockReturnValueOnce("widget-1").mockReturnValueOnce("widget-2");
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const first = makeContainer({ width: 320, widgetHeight: null }).container;
      act(() => result.current.containerRef(first));

      act(() => result.current.containerRef(null));
      expect(removeMock).toHaveBeenCalledWith("widget-1");
      act(() => result.current.containerRef(first));

      expect(renderMock).toHaveBeenCalledTimes(2);
      act(() => result.current.resetWidget());
      expect(resetMock).toHaveBeenCalledWith("widget-2");
    });
  });

  describe("狭い入れ物での縮め", () => {
    it("DD-AUTH-012 入れ物のはみ出しを隠し、最小の幅を 0 にして、見張りを始める", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container } = makeContainer({ width: 320, widgetHeight: null });

      act(() => result.current.containerRef(container));

      expect(container.style.overflow).toBe("hidden");
      expect(container.style.minWidth).toBe("0");
      expect(ResizeObserverStub.instances).toHaveLength(1);
      expect(ResizeObserverStub.instances[0].observe).toHaveBeenCalledWith(container);
    });

    it("DD-AUTH-012 幅 200px なら幅の比で縮め、高さを合わせる", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container, widget } = makeContainer({ width: 200, widgetHeight: 65 });

      act(() => result.current.containerRef(container));

      const scale = 200 / 300;
      expect(widget?.style.transformOrigin).toBe("0 0");
      expect(widget?.style.transform).toBe(`scale(${scale})`);
      expect(container.style.height).toBe(`${65 * scale}px`);
    });

    it("DD-AUTH-012 幅 320px なら縮めず、変形を消して元の高さにする", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container, widget } = makeContainer({ width: 320, widgetHeight: 65 });
      (widget as HTMLElement).style.transform = "scale(0.5)";

      act(() => result.current.containerRef(container));

      expect(widget?.style.transform).toBe("");
      expect(container.style.height).toBe("65px");
    });

    it("DD-AUTH-012 入れ物に子が無ければ測らない", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container } = makeContainer({ width: 200, widgetHeight: null });

      act(() => result.current.containerRef(container));

      expect(container.style.height).toBe("");
      // 子が無いので、子の見張りは付けない（入れ物の見張りだけ）
      expect(ResizeObserverStub.instances[0].observe).toHaveBeenCalledTimes(1);
    });

    it("DD-AUTH-012 子の高さが 0 なら測らない", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container, widget } = makeContainer({ width: 200, widgetHeight: 0 });

      act(() => result.current.containerRef(container));

      expect(container.style.height).toBe("");
      expect(widget?.style.transform).toBe("");
      expect(ResizeObserverStub.instances[0].observe).toHaveBeenCalledTimes(1);
    });

    it("DD-AUTH-012 入れ物の幅が 0 なら測らない", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container, widget } = makeContainer({ width: 0, widgetHeight: 65 });

      act(() => result.current.containerRef(container));

      expect(container.style.height).toBe("");
      expect(widget?.style.transform).toBe("");
    });

    it("DD-AUTH-012 鍵が無ければ縮めず、見張りも付けない", () => {
      const { result } = renderHook(() => useTurnstileWidget("", jest.fn()));
      const { container, widget } = makeContainer({ width: 200, widgetHeight: 65 });

      act(() => result.current.containerRef(container));

      expect(ResizeObserverStub.instances).toHaveLength(0);
      expect(container.style.overflow).toBe("");
      expect(widget?.style.transform).toBe("");
    });

    it("DD-AUTH-012 入れ物が無ければ縮めず、見張りも付けない", () => {
      renderHook(() => useTurnstileWidget("site-key", jest.fn()));

      expect(ResizeObserverStub.instances).toHaveLength(0);
    });

    it("DD-AUTH-012 子の高さが前と同じなら、入れ物の高さを書き直さない", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container } = makeContainer({ width: 200, widgetHeight: 65 });
      let heightWrites = 0;
      let currentHeight = "";
      Object.defineProperty(container.style, "height", {
        configurable: true,
        get: () => currentHeight,
        set: (value: string) => {
          heightWrites += 1;
          currentHeight = value;
        },
      });

      act(() => result.current.containerRef(container));
      expect(heightWrites).toBe(1);

      // 同じ寸法のまま見張りが呼ばれても、書き直さない
      act(() => ResizeObserverStub.instances[0].callback());

      expect(heightWrites).toBe(1);
      expect(currentHeight).toBe(`${65 * (200 / 300)}px`);
    });

    it("DD-AUTH-012 幅が変わって見張りが呼ばれたら新しい幅で縮め直し、同じ子は 1 回しか見張らない", () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container, widget } = makeContainer({ width: 200, widgetHeight: 65 });
      act(() => result.current.containerRef(container));
      expect(widget?.style.transform).toBe(`scale(${200 / 300})`);

      fixSize(container, "clientWidth", 150);
      act(() => ResizeObserverStub.instances[0].callback());

      expect(widget?.style.transform).toBe(`scale(${150 / 300})`);
      expect(container.style.height).toBe(`${65 * (150 / 300)}px`);
      const observeCalls = ResizeObserverStub.instances[0].observe.mock.calls.filter(
        ([target]) => target === widget,
      );
      expect(observeCalls).toHaveLength(1);
    });

    it("DD-AUTH-012 子が差し替わったら、前の子の見張りを外して新しい子を見張る", async () => {
      const { result } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container, widget } = makeContainer({ width: 200, widgetHeight: 65 });
      act(() => result.current.containerRef(container));
      const observer = ResizeObserverStub.instances[0];
      const nextWidget = document.createElement("div");
      fixSize(nextWidget, "offsetHeight", 80);

      container.replaceChildren(nextWidget);

      await waitFor(() => expect(observer.observe).toHaveBeenCalledWith(nextWidget));
      expect(observer.unobserve).toHaveBeenCalledWith(widget);
      expect(nextWidget.style.transform).toBe(`scale(${200 / 300})`);
      expect(container.style.height).toBe(`${80 * (200 / 300)}px`);
    });

    it("DD-AUTH-012 外す時に見張りを止める", () => {
      const { result, unmount } = renderHook(() => useTurnstileWidget("site-key", jest.fn()));
      const { container } = makeContainer({ width: 200, widgetHeight: 65 });
      act(() => result.current.containerRef(container));

      unmount();

      expect(ResizeObserverStub.instances[0].disconnect).toHaveBeenCalled();
    });
  });
});
