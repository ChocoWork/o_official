import { render, screen } from "@testing-library/react";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";

describe("LiveMessage（FREQ-376）", () => {
  it("案内が無いときも入れ物（role=alert）を置き、画面の見た目用のクラスは当てない", () => {
    render(<LiveMessage className="mt-2 text-red-600">{null}</LiveMessage>);

    const region = screen.getByRole("alert");
    expect(region).toBeEmptyDOMElement();
    expect(region).not.toHaveClass("mt-2");
    expect(region).toHaveClass("live-message--empty");
  });

  it("案内が出たら同じ入れ物に文言が入り、見た目用のクラスとスタイルが当たる", () => {
    const { rerender } = render(
      <LiveMessage className="mt-2 text-red-600" style={{ fontSize: "12px" }}>
        {""}
      </LiveMessage>,
    );
    const region = screen.getByRole("alert");

    rerender(
      <LiveMessage className="mt-2 text-red-600" style={{ fontSize: "12px" }}>
        メールアドレスまたはパスワードが違います。
      </LiveMessage>,
    );

    expect(screen.getByRole("alert")).toBe(region);
    expect(region).toHaveTextContent("メールアドレスまたはパスワードが違います。");
    expect(region).toHaveClass("mt-2", "text-red-600");
    expect(region).not.toHaveClass("live-message--empty");
    expect(region).toHaveStyle({ fontSize: "12px" });
  });

  it("案内が消えたら文言を外し、画面と余白から外す", () => {
    const { rerender } = render(<LiveMessage className="mt-2">送信に失敗しました。</LiveMessage>);
    const region = screen.getByRole("alert");

    rerender(<LiveMessage className="mt-2">{undefined}</LiveMessage>);

    expect(screen.getByRole("alert")).toBe(region);
    expect(region).toBeEmptyDOMElement();
    expect(region).toHaveClass("live-message--empty");
  });

  it("polite は割り込まない読み上げ領域（aria-live=polite）になり、role=alert にはならない", () => {
    render(
      <LiveMessage politeness="polite" id="city-error">
        市区町村を入力してください
      </LiveMessage>,
    );

    const region = screen.getByText("市区町村を入力してください");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).not.toHaveAttribute("role");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(region).toHaveAttribute("id", "city-error");
  });

  it("status は完了などの状況の案内として role=status の入れ物を置く（FREQ-377）", () => {
    const { rerender } = render(<LiveMessage politeness="status">{null}</LiveMessage>);
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();
    expect(region).toHaveClass("live-message--empty");

    rerender(<LiveMessage politeness="status">保存しました。</LiveMessage>);

    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("保存しました。");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("要素の種類を変えられ、id などの属性はそのまま渡る", () => {
    render(
      <LiveMessage as="span" id="prefecture-error" data-testid="prefecture-error">
        都道府県を選択してください
      </LiveMessage>,
    );

    const region = screen.getByTestId("prefecture-error");
    expect(region.tagName).toBe("SPAN");
    expect(region).toHaveAttribute("id", "prefecture-error");
  });
});
