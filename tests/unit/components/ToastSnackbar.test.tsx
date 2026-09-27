import { render, screen } from "@testing-library/react";
import { ToastSnackbar } from "@/components/ui/ToastSnackbar/ToastSnackbar";

describe("ToastSnackbar（FREQ-376）", () => {
  it("トースト自体は読み上げ領域を持たない（外側の LiveMessage と入れ子にしない）", () => {
    const { container } = render(
      <ToastSnackbar message="削除に失敗しました" variant="error" actionLabel="閉じる" onAction={() => {}} />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(screen.getByText("削除に失敗しました")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "閉じる" })).toBeInTheDocument();
  });
});
