import { render } from "@testing-library/react";
import { ArticleBody } from "@/features/news/components/ArticleBody";

function renderBody(content: string) {
  return render(<ArticleBody content={content} />).container;
}

function tagNames(container: HTMLElement) {
  return Array.from(container.children).map((el) => el.tagName);
}

describe("ArticleBody", () => {
  it("DD-NEWS-034 空の本文は何も描かない", () => {
    const container = renderBody("");

    expect(container.childElementCount).toBe(0);
  });

  it("DD-NEWS-034 CRLF を改行として扱い、空行で段落を分け、段落の行を空白で結ぶ", () => {
    const container = renderBody("a\r\nb\n\nc");

    expect(tagNames(container)).toEqual(["P", "P"]);
    expect(container.children[0].textContent).toBe("a b");
    expect(container.children[1].textContent).toBe("c");
  });

  it("DD-NEWS-034 # ・## ・### を h2・h3・h4 にする", () => {
    const container = renderBody("# h1\n## h2\n### h3");

    expect(tagNames(container)).toEqual(["H2", "H3", "H4"]);
    expect(container.children[0].textContent).toBe("h1");
    expect(container.children[1].textContent).toBe("h2");
    expect(container.children[2].textContent).toBe("h3");
  });

  it("DD-NEWS-034 #### 以上は見出しにせず段落の文字にする", () => {
    const container = renderBody("#### h4");

    expect(tagNames(container)).toEqual(["P"]);
    expect(container.children[0].textContent).toBe("#### h4");
  });

  it("DD-NEWS-034 - ・* ・+ で始まる行を1つの箇条書きにまとめる", () => {
    const container = renderBody("- a\n* b\n+ c");

    expect(tagNames(container)).toEqual(["UL"]);
    const items = container.querySelectorAll("li");
    expect(Array.from(items).map((li) => li.textContent)).toEqual(["a", "b", "c"]);
  });

  it("DD-NEWS-034 記号の後に空白が無い行は箇条書きにしない", () => {
    const container = renderBody("-a");

    expect(tagNames(container)).toEqual(["P"]);
    expect(container.children[0].textContent).toBe("-a");
  });

  it("DD-NEWS-034 段落と箇条書きが続く時はそれぞれを閉じて順に並べる", () => {
    const container = renderBody("p1\n- a\np2");

    expect(tagNames(container)).toEqual(["P", "UL", "P"]);
    expect(container.children[0].textContent).toBe("p1");
    expect(container.children[1].textContent).toBe("a");
    expect(container.children[2].textContent).toBe("p2");
  });

  it("DD-NEWS-034 箇条書きの後の見出しは箇条書きを閉じてから描く", () => {
    const container = renderBody("- a\n# h");

    expect(tagNames(container)).toEqual(["UL", "H2"]);
  });

  it("DD-NEWS-034 段落の後の見出しは段落を閉じてから描く", () => {
    const container = renderBody("p\n## h");

    expect(tagNames(container)).toEqual(["P", "H3"]);
  });

  it("DD-NEWS-034 本文の最後に溜まった箇条書きを閉じる", () => {
    const container = renderBody("p\n\n- a\n- b");

    expect(tagNames(container)).toEqual(["P", "UL"]);
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("DD-NEWS-034 画像の記法を img にし、前後の文字を残す", () => {
    const container = renderBody("前 ![alt](/x.png) 後");

    const paragraph = container.children[0];
    const img = paragraph.querySelector("img");
    expect(img).toHaveAttribute("src", "/x.png");
    expect(img).toHaveAttribute("alt", "alt");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(paragraph.childNodes[0].textContent).toBe("前 ");
    expect(paragraph.childNodes[2].textContent).toBe(" 後");
  });

  it("DD-NEWS-034 外部のリンクは新しいタブで開き opener を渡さない", () => {
    const container = renderBody("[外](https://a.example)");

    const paragraph = container.children[0];
    const link = paragraph.querySelector("a");
    expect(paragraph.childNodes).toHaveLength(1);
    expect(link).toHaveTextContent("外");
    expect(link).toHaveAttribute("href", "https://a.example");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("DD-NEWS-034 サイトの中のリンクは同じタブで開く", () => {
    const container = renderBody("[中](/news)");

    const link = container.querySelector("a");
    expect(link).toHaveAttribute("href", "/news");
    expect(link).not.toHaveAttribute("target");
    expect(link).not.toHaveAttribute("rel");
  });

  it("DD-NEWS-034 ** と __ で囲んだ文字を strong にする", () => {
    const container = renderBody("**b** __c__");

    const strong = container.querySelectorAll("strong");
    expect(Array.from(strong).map((el) => el.textContent)).toEqual(["b", "c"]);
  });

  it("DD-NEWS-034 * と _ で囲んだ文字を em にする", () => {
    const container = renderBody("*i* _j_");

    const em = container.querySelectorAll("em");
    expect(Array.from(em).map((el) => el.textContent)).toEqual(["i", "j"]);
  });

  it("DD-NEWS-034 見出しと箇条書きの中の記法も解釈する", () => {
    const container = renderBody("# **強い**題\n- [中](/a)");

    expect(container.querySelector("h2 strong")).toHaveTextContent("強い");
    expect(container.querySelector("li a")).toHaveAttribute("href", "/a");
  });

  it("DD-NEWS-034 同じ本文を2回描いても同じ結果になる", () => {
    const content = "前 **b** [l](/x) 後\n- *i*";

    const first = renderBody(content).innerHTML;
    const second = renderBody(content).innerHTML;

    expect(second).toBe(first);
    expect(first).toContain("<strong");
  });

  it("DD-NEWS-034 生の HTML は文字として出し要素を作らない", () => {
    const container = renderBody("<script>alert(1)</script>");

    expect(container.querySelector("script")).toBeNull();
    expect(container.children[0].textContent).toBe("<script>alert(1)</script>");
  });

  it("DD-NEWS-034 javascript: のリンクは元の URL のまま href に入らない（今の動きの記録）", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const container = renderBody("[x](javascript:history.back)");

      const link = container.querySelector("a");
      expect(link).not.toBeNull();
      expect(link?.getAttribute("href")).not.toBe("javascript:history.back");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
