import { render, screen } from "@testing-library/react";
import { HomeSectionViewAll } from "@/features/home/components/HomeSectionViewAll";

const DEFAULT_CLASSES = ["mt-8.5", "flex", "justify-center", "sm:mt-10.5", "md:mt-13.75"];

function renderButton(props: { href?: string; ariaLabel?: string; className?: string } = {}) {
  return render(
    <HomeSectionViewAll
      href={props.href ?? "/item"}
      ariaLabel={props.ariaLabel ?? "VIEW ALL ITEMS"}
      className={props.className}
    />,
  );
}

describe("HomeSectionViewAll", () => {
  it("DD-HOME-002 渡した名前のリンクが1つ描かれ、行き先と文字と data-testid が付く", () => {
    renderButton({ href: "/item", ariaLabel: "VIEW ALL ITEMS" });

    const links = screen.getAllByRole("link", { name: "VIEW ALL ITEMS" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/item");
    expect(links[0]).toHaveTextContent(/^VIEW ALL$/);
    expect(links[0]).toHaveAttribute("data-testid", "home-section-view-all");
  });

  it("DD-HOME-002 呼ぶ側ごとに行き先と名前が変わる（LOOK・NEWS）", () => {
    const { rerender } = renderButton({ href: "/look", ariaLabel: "VIEW ALL LOOKS" });
    expect(screen.getByRole("link", { name: "VIEW ALL LOOKS" })).toHaveAttribute("href", "/look");

    rerender(<HomeSectionViewAll href="/news" ariaLabel="VIEW ALL NEWS" />);
    expect(screen.getByRole("link", { name: "VIEW ALL NEWS" })).toHaveAttribute("href", "/news");
    expect(screen.queryByRole("link", { name: "VIEW ALL LOOKS" })).not.toBeInTheDocument();
  });

  it("DD-HOME-002 共通の Button の secondary の印が付き、矢印の図が無い", () => {
    renderButton();

    const link = screen.getByTestId("home-section-view-all");
    expect(link).toHaveAttribute("data-ui-button", "true");
    expect(link).toHaveAttribute("data-ui-button-variant", "secondary");
    expect(link).toHaveAttribute("data-ui-button-size", "3xs");
    expect(link).toHaveAttribute("data-ui-button-shape", "square");
    expect(link.querySelector("svg")).toBeNull();
    expect(link.querySelector("img")).toBeNull();
  });

  it("DD-HOME-002 className を渡すと外側の div に既定のクラスへ足され、同じ display の flex は hidden に置き換わる", () => {
    renderButton({ className: "hidden sm:flex" });

    const wrapper = screen.getByTestId("home-section-view-all").parentElement as HTMLElement;
    expect(wrapper.tagName).toBe("DIV");
    for (const cls of [...DEFAULT_CLASSES.filter((c) => c !== "flex"), "hidden", "sm:flex"]) {
      expect(wrapper).toHaveClass(cls);
    }
    expect(wrapper.className.split(/\s+/)).not.toContain("flex");
  });

  it("DD-HOME-002 display に当たらない className は既定のクラスを全部残して足される", () => {
    renderButton({ className: "mx-auto" });

    const wrapper = screen.getByTestId("home-section-view-all").parentElement as HTMLElement;
    for (const cls of [...DEFAULT_CLASSES, "mx-auto"]) {
      expect(wrapper).toHaveClass(cls);
    }
  });

  it("DD-HOME-002 className を渡さないと外側の div に既定のクラスだけ付く", () => {
    renderButton();

    const wrapper = screen.getByTestId("home-section-view-all").parentElement as HTMLElement;
    expect(wrapper.className.split(/\s+/).sort()).toEqual([...DEFAULT_CLASSES].sort());
    expect(wrapper).not.toHaveClass("hidden");
  });
});
