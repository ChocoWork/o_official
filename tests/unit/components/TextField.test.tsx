import { render, screen } from "@testing-library/react";
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
});
