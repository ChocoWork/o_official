import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextAreaField } from "@/components/ui/TextAreaField/TextAreaField";

describe("TextAreaField", () => {
  it("追加クラスを渡しても標準入力クラスを保持する", () => {
    render(
      <TextAreaField
        aria-label="メモ"
        shape="rounded"
        className="text-sm text-black"
      />,
    );

    const input = screen.getByLabelText("メモ");
    expect(input).toHaveClass(
      "text-area-field__input",
      "text-sm",
      "text-black",
    );
  });
});

describe("TextAreaField の見出し・案内とスクリーンリーダー（FREQ-376）", () => {
  it("案内や補足文を出しても、入力欄の名前は見出しだけになる", () => {
    render(
      <TextAreaField
        label="メッセージ"
        name="message"
        helperText="500文字まで"
        errorText="メッセージを入力してください"
      />,
    );

    expect(screen.getByRole("textbox")).toHaveAccessibleName("メッセージ");
  });

  it("案内は入力欄の説明になり、入力欄は誤りの状態になる", () => {
    render(<TextAreaField label="メッセージ" name="message" errorText="メッセージを入力してください" />);

    const textarea = screen.getByRole("textbox", { name: "メッセージ" });
    expect(textarea).toHaveAccessibleDescription("メッセージを入力してください");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
  });

  it("案内の入れ物（aria-live=polite）は最初から空で置かれ、案内が出たら同じ入れ物に入る", () => {
    const { container, rerender } = render(<TextAreaField label="メッセージ" name="message" />);

    const region = container.querySelector("#message-error");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();

    rerender(<TextAreaField label="メッセージ" name="message" errorText="メッセージを入力してください" />);

    expect(container.querySelector("#message-error")).toBe(region);
    expect(region).toHaveTextContent("メッセージを入力してください");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("案内と補足文を label の中に置かない", () => {
    const { rerender } = render(
      <TextAreaField label="メッセージ" name="message" helperText="500文字まで" />,
    );
    expect(screen.getByText("500文字まで").closest("label")).toBeNull();

    rerender(<TextAreaField label="メッセージ" name="message" errorText="メッセージを入力してください" />);
    expect(screen.getByText("メッセージを入力してください").closest("label")).toBeNull();
  });

  it("補足文は案内が無いときだけ説明になる", () => {
    render(<TextAreaField label="メッセージ" name="message" helperText="500文字まで" />);

    expect(screen.getByRole("textbox")).toHaveAccessibleDescription("500文字まで");
  });

  it("見出しを押すと入力欄にカーソルが移る", async () => {
    const user = userEvent.setup();
    render(<TextAreaField label="返信内容" name="reply" />);

    await user.click(screen.getByText("返信内容"));

    expect(screen.getByRole("textbox", { name: "返信内容" })).toHaveFocus();
  });

  it("id も name も無くても見出しが入力欄に結びつく", () => {
    render(<TextAreaField label="メモ" />);

    expect(screen.getByRole("textbox")).toHaveAccessibleName("メモ");
  });
});
