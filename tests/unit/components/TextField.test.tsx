import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextField } from "@/components/ui/TextField/TextField";

describe("TextField", () => {
  it("Tailwindのtext系クラスを渡しても標準入力クラスを保持する", () => {
    render(
      <TextField
        aria-label="日付"
        shape="rounded"
        className="text-sm text-black"
      />,
    );

    const input = screen.getByLabelText("日付");
    expect(input).toHaveClass("text-field__input", "text-sm", "text-black");
  });

  it("required のとき必須マーカーを表示する", () => {
    render(<TextField label="氏名" name="fullName" required />);

    const marker = screen.getByText("*");
    expect(marker).toHaveClass("text-field__required");
    expect(marker).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByLabelText(/氏名/)).toBeRequired();
  });

  it("required でないとき必須マーカーを表示しない", () => {
    render(<TextField label="フリガナ" name="kanaName" />);

    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });
});

describe("TextField の見出し・案内とスクリーンリーダー（FREQ-375）", () => {
  it("案内を出しても、入力欄の名前は見出しだけになる（案内が名前に混ざらない）", () => {
    render(
      <TextField label="氏名" name="fullName" required errorText="氏名を入力してください" />,
    );

    expect(screen.getByRole("textbox")).toHaveAccessibleName("氏名");
  });

  it("案内は入力欄の説明になり、入力欄は誤りの状態になる", () => {
    render(<TextField label="氏名" name="fullName" errorText="氏名を入力してください" />);

    const input = screen.getByRole("textbox", { name: "氏名" });
    expect(input).toHaveAccessibleDescription("氏名を入力してください");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("案内が無いときも読み上げ用の入れ物（aria-live=polite）は空で置かれ、案内が出たら同じ入れ物に入る", () => {
    const { container, rerender } = render(<TextField label="氏名" name="fullName" />);

    const region = container.querySelector("#fullName-error");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
    const input = screen.getByRole("textbox", { name: "氏名" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveAccessibleDescription("");

    rerender(<TextField label="氏名" name="fullName" errorText="氏名を入力してください" />);

    expect(container.querySelector("#fullName-error")).toBe(region);
    expect(region).toHaveTextContent("氏名を入力してください");
  });

  it("欄ごとの誤りは割り込まない（role=alert にしない。一度に複数の欄で出ても順番に読まれる）", () => {
    render(<TextField label="氏名" name="fullName" errorText="氏名を入力してください" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("氏名を入力してください")).toHaveAttribute("aria-live", "polite");
  });

  it("右端のボタンを label の中に置かない（ボタン名が入力欄の名前に混ざらない）", () => {
    render(
      <TextField
        label="パスワード"
        name="password"
        type="text"
        trailingIcon={
          <button type="button" aria-label="パスワードを表示">
            <i aria-hidden="true" />
          </button>
        }
      />,
    );

    // Chromium は label の中のボタン名を入力欄の名前に足す（jsdom では再現しないので構造で確かめる）
    expect(screen.getByRole("button", { name: "パスワードを表示" }).closest("label")).toBeNull();
    expect(screen.getByRole("textbox")).toHaveAccessibleName("パスワード");
  });

  it("案内を label の中に置かない", () => {
    render(<TextField label="氏名" name="fullName" errorText="氏名を入力してください" />);

    expect(screen.getByText("氏名を入力してください").closest("label")).toBeNull();
  });

  it("leadingText だけで見出しを付けた欄は、今までどおりその文言が名前になる", () => {
    render(<TextField name="kanaName" leadingText="フリガナ" shape="underline" />);

    expect(screen.getByRole("textbox")).toHaveAccessibleName("フリガナ");
  });

  it("見出しを押すと入力欄にカーソルが移る", async () => {
    const user = userEvent.setup();
    render(<TextField label="市区町村" name="city" />);

    await user.click(screen.getByText("市区町村"));

    expect(screen.getByRole("textbox", { name: "市区町村" })).toHaveFocus();
  });

  it("id も name も無くても見出しが入力欄に結びつく", () => {
    render(<TextField label="メモ" />);

    expect(screen.getByRole("textbox")).toHaveAccessibleName("メモ");
  });

  it("補足文は案内が無いときだけ説明になる", () => {
    const { rerender } = render(
      <TextField label="郵便番号" name="postalCode" helperText="ハイフンなしで入力" />,
    );
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription("ハイフンなしで入力");

    rerender(
      <TextField
        label="郵便番号"
        name="postalCode"
        helperText="ハイフンなしで入力"
        errorText="郵便番号を入力してください"
      />,
    );
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription("郵便番号を入力してください");
  });
});
