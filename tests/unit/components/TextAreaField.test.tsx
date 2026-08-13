import { render, screen } from "@testing-library/react";
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
