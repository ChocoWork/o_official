import { render, screen } from "@testing-library/react";
import { AuthResultScreen } from "@/components/AuthResultScreen";

// FREQ-377: 結果の画面はフォームと入れ替わって出る。押したボタンが消えてフォーカスが外れるので、
// 見出しへフォーカスを移して結果を読ませる。status と重ねて二重に読ませない。
describe("AuthResultScreen（FREQ-377）", () => {
  it("表示されたら見出しにフォーカスが移り、status の読み上げ領域は置かない", () => {
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
});
