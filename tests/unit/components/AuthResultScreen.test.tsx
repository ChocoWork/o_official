import { render, screen } from "@testing-library/react";
import {
  AuthResultScreen,
  MailSentIcon,
  PasswordUpdatedIcon,
} from "@/components/AuthResultScreen";

// FREQ-377: 結果の画面はフォームと入れ替わって出る。押したボタンが消えてフォーカスが外れるので、
// 見出しへフォーカスを移して結果を読ませる。status と重ねて二重に読ませない。
describe("AuthResultScreen（FREQ-377）", () => {
  it("DD-AUTH-011 表示されたら見出しにフォーカスが移り、status の読み上げ領域は置かない", () => {
    render(
      <AuthResultScreen
        icon={<span>icon</span>}
        title="再設定メールを送信しました"
        detail={<span className="block">メール内のリンクから再設定してください。</span>}
      />,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "再設定メールを送信しました" });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("DD-AUTH-011 図と題だけを渡すと、詳細・注意書き・操作・リンクは出さない", () => {
    render(<AuthResultScreen icon={<span data-testid="icon">icon</span>} title="結果" />);

    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "結果" })).toBeInTheDocument();
    expect(screen.queryByTestId("auth-result-note")).not.toBeInTheDocument();
    const body = screen.getByTestId("auth-result-body");
    // 図と題を包む 1 つの列だけで、詳細の枠は付かない
    expect(body.children).toHaveLength(1);
    // 親の直下には本文のかたまりだけが残る（操作・リンクの枠が無い）
    expect(body.parentElement?.children).toHaveLength(1);
  });

  it("DD-AUTH-011 detail を渡すと詳細を本文のかたまりの中に出す", () => {
    render(
      <AuthResultScreen icon={<span />} title="結果" detail={<span>詳細の文</span>} />,
    );

    const detail = screen.getByText("詳細の文");
    expect(screen.getByTestId("auth-result-body")).toContainElement(detail);
  });

  it("DD-AUTH-011 detail を渡さないと詳細の枠を出さない", () => {
    render(<AuthResultScreen icon={<span />} title="結果" />);

    // 本文のかたまりの子は、図と題を包む列だけ
    expect(screen.getByTestId("auth-result-body").children).toHaveLength(1);
  });

  it("DD-AUTH-011 note を渡すと、情報のアイコンつきの注意書きのパネルを本文の外に出す", () => {
    render(
      <AuthResultScreen icon={<span />} title="結果" note={<span>届かない場合の注意</span>} />,
    );

    const panel = screen.getByTestId("auth-result-note");
    expect(panel).toContainElement(screen.getByText("届かない場合の注意"));
    expect(panel.querySelector("i.ri-information-line")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("auth-result-body")).not.toContainElement(panel);
  });

  it("DD-AUTH-011 note を渡さないと注意書きのパネルを出さない", () => {
    render(<AuthResultScreen icon={<span />} title="結果" />);

    expect(screen.queryByTestId("auth-result-note")).not.toBeInTheDocument();
  });

  it("DD-AUTH-011 action を渡すと主の操作を出す", () => {
    render(
      <AuthResultScreen
        icon={<span />}
        title="結果"
        action={<button type="button">主の操作</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "主の操作" })).toBeInTheDocument();
  });

  it("DD-AUTH-011 action を渡さないと主の操作の枠を出さない", () => {
    const { container } = render(
      <AuthResultScreen icon={<span />} title="結果" links={<a href="/x">リンク</a>} />,
    );

    // 本文のかたまりとリンクの枠だけで、操作の枠は無い
    expect((container.firstElementChild as HTMLElement).children).toHaveLength(2);
  });

  it("DD-AUTH-011 links を渡すと補助のリンクを横並びの枠に出す", () => {
    render(
      <AuthResultScreen
        icon={<span />}
        title="結果"
        links={
          <>
            <a href="/a">リンクA</a>
            <a href="/b">リンクB</a>
          </>
        }
      />,
    );

    const linkA = screen.getByRole("link", { name: "リンクA" });
    expect(screen.getByRole("link", { name: "リンクB" })).toBeInTheDocument();
    expect(linkA.parentElement).toHaveClass("flex", "justify-center");
  });

  it("DD-AUTH-011 links を渡さないと補助リンクの枠を出さない", () => {
    const { container } = render(
      <AuthResultScreen icon={<span />} title="結果" action={<button type="button">操作</button>} />,
    );

    // 本文のかたまりと操作の枠だけで、リンクの枠は無い
    expect((container.firstElementChild as HTMLElement).children).toHaveLength(2);
  });

  it("DD-AUTH-011 全部の項目を渡すと本文・注意書き・操作・リンクの順に並べる", () => {
    const { container } = render(
      <AuthResultScreen
        icon={<MailSentIcon />}
        title="結果"
        detail={<span>詳細</span>}
        note={<span>注意</span>}
        action={<button type="button">操作</button>}
        links={<a href="/x">リンク</a>}
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    const order = Array.from(root.children).map((child) => child.textContent);
    expect(order).toHaveLength(4);
    expect(order[0]).toContain("結果");
    expect(order[0]).toContain("詳細");
    expect(order[1]).toContain("注意");
    expect(order[2]).toBe("操作");
    expect(order[3]).toBe("リンク");
  });

  it("DD-AUTH-011 MailSentIcon は封筒の図を読み上げ対象から外して描く", () => {
    render(<MailSentIcon />);

    const icon = screen.getByTestId("auth-result-icon-mail");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("focusable", "false");
    // 封筒の枠と折り目、完了バッジの円 2 つとチェック
    expect(icon.querySelectorAll("rect")).toHaveLength(1);
    expect(icon.querySelectorAll("circle")).toHaveLength(2);
  });

  it("DD-AUTH-011 PasswordUpdatedIcon は南京錠の図を読み上げ対象から外して描く", () => {
    render(<PasswordUpdatedIcon />);

    const icon = screen.getByTestId("auth-result-icon-password");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("focusable", "false");
    expect(icon.querySelectorAll("rect")).toHaveLength(1);
    expect(icon.querySelectorAll("circle")).toHaveLength(2);
  });
});
