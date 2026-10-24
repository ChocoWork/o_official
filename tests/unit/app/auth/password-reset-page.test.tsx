import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import PasswordResetPage from "@/app/auth/password-reset/page";
import {
  ResetRequestSchema,
  ResetSessionConfirmSchema,
} from "@/features/auth/schemas/password-reset";

// Script は読み込みを走らせず、渡された props だけ記録する
const mockScriptProps: { current: Record<string, unknown> | null } = { current: null };
jest.mock("next/script", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockScriptProps.current = props;
    return <div data-testid="turnstile-script" />;
  },
}));

// フックの中身は DD-AUTH-012 の単体テストで見る。ここでは頁との受け渡しだけを見る
const mockContainerRef = jest.fn();
const mockRenderWidget = jest.fn();
const mockResetWidget = jest.fn();
const mockHookState: { onToken: (token: string) => void; siteKey: string } = {
  onToken: () => {},
  siteKey: "",
};
jest.mock("@/hooks/useTurnstileWidget", () => ({
  useTurnstileWidget: (siteKey: string, onToken: (token: string) => void) => {
    mockHookState.onToken = onToken;
    mockHookState.siteKey = siteKey;
    return {
      containerRef: mockContainerRef,
      renderWidget: mockRenderWidget,
      resetWidget: mockResetWidget,
    };
  },
}));

const SESSION_URL = "/api/auth/password-reset/session";
const REQUEST_URL = "/api/auth/password-reset/request";
const CONFIRM_URL = "/api/auth/password-reset/confirm";

type ResponseInitLike = {
  ok?: boolean;
  status?: number;
  retryAfter?: string | null;
  badJson?: boolean;
};

function res(body: unknown, init: ResponseInitLike = {}) {
  const { ok = true, status = ok ? 200 : 400, retryAfter = null, badJson = false } = init;
  return {
    ok,
    status,
    headers: { get: (name: string) => (name === "Retry-After" ? retryAfter : null) },
    json: async () => {
      if (badJson) throw new Error("not json");
      return body;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res_, rej_) => {
    resolve = res_;
    reject = rej_;
  });
  return { promise, resolve, reject };
}

const routes = {
  session: jest.fn(),
  request: jest.fn(),
  confirm: jest.fn(),
};
const fetchMock = jest.fn();
const originalFetch = globalThis.fetch;

const LONG_PASSWORD = "a-very-long-password-1234";

/** Promise の連鎖を数段ぶん流す。タイマーは進めない。 */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

async function renderPage() {
  const view = render(<PasswordResetPage />);
  await flush();
  return view;
}

function formOf(buttonName: string | RegExp) {
  return screen.getByRole("button", { name: buttonName }).closest("form") as HTMLFormElement;
}

async function submit(buttonName: string | RegExp) {
  await act(async () => {
    fireEvent.submit(formOf(buttonName));
  });
  await flush();
}

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
  await flush();
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function bodyOf(mock: jest.Mock, call = 0) {
  return JSON.parse((mock.mock.calls[call][0] as { body: string }).body);
}

/** 申請の見せ方で宛先を入れて送り、送った結果まで進める。 */
async function sendRequestMail(email = "user@example.com") {
  type("Email", email);
  await submit("再設定メールを送信");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScriptProps.current = null;
  mockHookState.siteKey = "";
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "";
  // 本物のフックと同じく、引き直しはトークンを空にする
  mockResetWidget.mockImplementation(() => mockHookState.onToken(""));
  routes.session.mockImplementation(async () => res({ ready: false }));
  routes.request.mockImplementation(async () => res({}));
  routes.confirm.mockImplementation(async () => res({}));
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === SESSION_URL) return routes.session(init);
    if (url === REQUEST_URL) return routes.request(init);
    if (url === CONFIRM_URL) return routes.confirm(init);
    throw new Error(`unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  window.history.replaceState(null, "", "/auth/password-reset");
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
  delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
});

describe("PasswordResetPage リンクの失敗の理由", () => {
  it("DD-AUTH-003 error が link_expired なら期限切れの文を出し、URL を道だけに置き換える", async () => {
    window.history.replaceState(null, "", "/auth/password-reset?error=link_expired");
    const replaceSpy = jest.spyOn(window.history, "replaceState");

    await renderPage();

    expect(
      screen.getByText(
        "リンクの有効期限が切れているか、すでに使用されています。お手数ですが、再度メールを送信してください。",
      ),
    ).toBeInTheDocument();
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/auth/password-reset");
    expect(window.location.search).toBe("");
  });

  it("DD-AUTH-003 error がほかの値なら正しくない旨の文を出し、URL を置き換える", async () => {
    window.history.replaceState(null, "", "/auth/password-reset?error=link_invalid");
    const replaceSpy = jest.spyOn(window.history, "replaceState");

    await renderPage();

    expect(
      screen.getByText("リンクが正しくありません。お手数ですが、再度メールを送信してください。"),
    ).toBeInTheDocument();
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/auth/password-reset");
    expect(window.location.search).toBe("");
  });

  it("DD-AUTH-003 error が無ければ文を出さず、URL も置き換えない", async () => {
    const replaceSpy = jest.spyOn(window.history, "replaceState");

    await renderPage();

    expect(screen.queryByText(/リンク/)).not.toBeInTheDocument();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 申請を送り始めるとリンクの失敗の文を消す", async () => {
    window.history.replaceState(null, "", "/auth/password-reset?error=link_expired");
    await renderPage();
    expect(screen.getByText(/リンクの有効期限が切れている/)).toBeInTheDocument();

    await sendRequestMail();

    expect(screen.queryByText(/リンクの有効期限が切れている/)).not.toBeInTheDocument();
  });
});

describe("PasswordResetPage 再設定の段の確認", () => {
  it("DD-AUTH-003 確認が終わるまでは宛先の欄を無効にして、送信ボタンを「確認中...」で押せなくする", async () => {
    const pending = deferred<ReturnType<typeof res>>();
    routes.session.mockImplementation(() => pending.promise);

    render(<PasswordResetPage />);
    await flush();

    expect(screen.getByRole("button", { name: "確認中..." })).toBeDisabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();

    await act(async () => {
      pending.resolve(res({ ready: false }));
    });
    await flush();

    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeEnabled();
  });

  it("DD-AUTH-003 状態の窓口へキャッシュなしの GET で聞く", async () => {
    await renderPage();

    expect(fetchMock).toHaveBeenCalledWith(
      SESSION_URL,
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("DD-AUTH-003 ready が真で宛先が文字列なら、新しいパスワードの見せ方にしてメールの欄を出さない", async () => {
    routes.session.mockImplementation(async () => res({ ready: true, email: "user@example.com" }));

    await renderPage();

    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.getByLabelText("New Password (16+ characters)")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm New Password (16+ characters)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "パスワードを更新" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 ready が真で宛先が文字列でなくても、新しいパスワードの見せ方にする", async () => {
    routes.session.mockImplementation(async () => res({ ready: true, email: 123 }));

    await renderPage();

    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "パスワードを更新" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 ready が偽なら申請の見せ方にする", async () => {
    routes.session.mockImplementation(async () => res({ ready: false }));

    await renderPage();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("New Password (16+ characters)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 状態の窓口が 200 以外なら申請の見せ方のまま、確認中を外す", async () => {
    routes.session.mockImplementation(async () => res({ ready: true }, { ok: false, status: 500 }));

    await renderPage();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 本文が JSON でなければ何もせず申請の見せ方のまま、確認中を外す", async () => {
    routes.session.mockImplementation(async () => res(null, { badJson: true }));

    await renderPage();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 通信が投げても申請の見せ方にして、確認中を外す", async () => {
    routes.session.mockImplementation(async () => {
      throw new Error("network");
    });

    await renderPage();

    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 頁が閉じた後に応答が来ても、何も更新しない", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<ReturnType<typeof res>>();
    routes.session.mockImplementation(() => pending.promise);
    const { unmount } = render(<PasswordResetPage />);
    await flush();

    unmount();
    await act(async () => {
      pending.resolve(res({ ready: true, email: "user@example.com" }));
    });
    await flush();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 頁が閉じた後に通信が投げても、何も更新しない", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const pending = deferred<ReturnType<typeof res>>();
    routes.session.mockImplementation(() => pending.promise);
    const { unmount } = render(<PasswordResetPage />);
    await flush();

    unmount();
    await act(async () => {
      pending.reject(new Error("network"));
    });
    await flush();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("PasswordResetPage 申請", () => {
  it("DD-AUTH-003 申請の成功で送った結果を出し、頁の見出しと宛先を描かない", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "パスワード再設定" })).toBeInTheDocument();

    await sendRequestMail("user@example.com");

    expect(
      screen.getByRole("heading", { level: 1, name: "再設定メールを送信しました" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "パスワード再設定" })).not.toBeInTheDocument();
    expect(screen.getByText("メール内のリンクから再設定してください。")).toBeInTheDocument();
    expect(screen.getByText("迷惑メールフォルダをご確認ください")).toBeInTheDocument();
    expect(screen.getByText("再送信すると前回のリンクは無効です")).toBeInTheDocument();
    expect(screen.queryByText(/user@example\.com/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ログインへ" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("button", { name: "別のアドレスで送信" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("DD-AUTH-003 申請は POST で宛先を JSON に入れて送り、鍵が無ければトークンを入れない", async () => {
    await renderPage();

    await sendRequestMail("User@Example.com");

    expect(routes.request).toHaveBeenCalledTimes(1);
    const init = routes.request.mock.calls[0][0] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(bodyOf(routes.request)).toEqual({ email: "User@Example.com" });
  });

  it("DD-AUTH-003 送ったら 60 秒の待ちを始め、再送の操作の代わりに残り時間を出す", async () => {
    await renderPage();

    await sendRequestMail();

    expect(screen.getByText("1分 00秒後に再送可能")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再送信する" })).not.toBeInTheDocument();
  });

  it("DD-AUTH-003 送信中はボタンを押せなくして、終わったら Turnstile を引き直す", async () => {
    const pending = deferred<ReturnType<typeof res>>();
    routes.request.mockImplementation(() => pending.promise);
    await renderPage();
    type("Email", "user@example.com");

    await submit("再設定メールを送信");
    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeDisabled();
    expect(mockResetWidget).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(res({}));
    });
    await flush();

    expect(mockResetWidget).toHaveBeenCalledTimes(1);
  });

  it("DD-AUTH-003 メールの欄が空なら送信ボタンを押せない", async () => {
    await renderPage();

    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeDisabled();
    type("Email", "user@example.com");
    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeEnabled();
  });

  it("DD-AUTH-003 メールの形が誤りなら誤りの文を出し、送らない", async () => {
    await renderPage();

    await sendRequestMail("not-an-email");

    expect(screen.getByText("メールアドレスの形式が正しくありません")).toBeInTheDocument();
    expect(routes.request).not.toHaveBeenCalled();
    expect(mockResetWidget).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 形の確かめが zod 以外の誤りを投げたら「入力に誤りがあります」を出す", async () => {
    jest.spyOn(ResetRequestSchema, "parse").mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    await renderPage();

    await sendRequestMail();

    expect(screen.getByText("入力に誤りがあります")).toBeInTheDocument();
    expect(routes.request).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 鍵があり Turnstile が済んでいなければ「ボット検証を完了してください」を出し、送らない", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    await renderPage();

    await sendRequestMail();

    expect(screen.getByText("ボット検証を完了してください")).toBeInTheDocument();
    expect(routes.request).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 鍵があり Turnstile が済んでいれば、トークンを入れて送る", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    await renderPage();
    act(() => mockHookState.onToken("token-1"));

    await sendRequestMail();

    expect(bodyOf(routes.request)).toEqual({ email: "user@example.com", turnstileToken: "token-1" });
    expect(screen.getByRole("heading", { name: "再設定メールを送信しました" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 申請が 429 なら上限の文を出し、Turnstile を引き直す", async () => {
    routes.request.mockImplementation(async () =>
      res({ error: "窓口の文" }, { ok: false, status: 429 }),
    );
    await renderPage();

    await sendRequestMail();

    expect(
      screen.getByText("送信回数の上限に達しました。しばらく時間をおいてからお試しください。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("窓口の文")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "再設定メールを送信しました" })).not.toBeInTheDocument();
    expect(mockResetWidget).toHaveBeenCalledTimes(1);
  });

  it("DD-AUTH-003 申請がほかの失敗なら窓口の文を出す", async () => {
    routes.request.mockImplementation(async () =>
      res({ error: "窓口の文" }, { ok: false, status: 403 }),
    );
    await renderPage();

    await sendRequestMail();

    expect(screen.getByText("窓口の文")).toBeInTheDocument();
    expect(mockResetWidget).toHaveBeenCalledTimes(1);
  });

  it("DD-AUTH-003 申請の失敗に窓口の文が無ければ「送信に失敗しました」を出す", async () => {
    routes.request.mockImplementation(async () => res({}, { ok: false, status: 500 }));
    await renderPage();

    await sendRequestMail();

    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();
  });

  it("DD-AUTH-003 申請の失敗の本文が JSON でない、または error が文字列でなければ「送信に失敗しました」を出す", async () => {
    routes.request.mockImplementationOnce(async () => res(null, { ok: false, status: 500, badJson: true }));
    await renderPage();

    await sendRequestMail();
    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();

    routes.request.mockImplementationOnce(async () => res({ error: 42 }, { ok: false, status: 500 }));
    await submit("再設定メールを送信");

    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });

  it("DD-AUTH-003 申請の通信が投げたら「送信に失敗しました」を出し、Turnstile を引き直す", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    routes.request.mockImplementation(async () => {
      throw new Error("network");
    });
    await renderPage();

    await sendRequestMail();

    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
    expect(mockResetWidget).toHaveBeenCalledTimes(1);
  });
});

describe("PasswordResetPage 再送と待ち", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("DD-AUTH-003 待ちの時刻が無いうちは時計を回さない", async () => {
    const setIntervalSpy = jest.spyOn(globalThis, "setInterval");
    await renderPage();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    await sendRequestMail();

    // 待ちを始めた時だけ、1 秒ごとの時計を回す
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it("DD-AUTH-003 残り時間は 1 秒ごとに減り、明けたら再送の操作が出て時計が止まる", async () => {
    const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");
    await renderPage();
    await sendRequestMail();

    await advance(1000);
    expect(screen.getByText("0分 59秒後に再送可能")).toBeInTheDocument();

    await advance(58000);
    expect(screen.getByText("0分 01秒後に再送可能")).toBeInTheDocument();

    await advance(1000);
    expect(screen.queryByText(/後に再送可能/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再送信する" })).toBeEnabled();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("DD-AUTH-003 頁を閉じると時計を止める", async () => {
    const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");
    const { unmount } = await renderPage();
    await sendRequestMail();
    clearIntervalSpy.mockClear();

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("DD-AUTH-003 再送が成功したら同じ申請を送り、待ちをやり直して Turnstile を引き直す", async () => {
    await renderPage();
    await sendRequestMail("user@example.com");
    await advance(60000);
    mockResetWidget.mockClear();

    await click(screen.getByRole("button", { name: "再送信する" }));

    expect(routes.request).toHaveBeenCalledTimes(2);
    expect(bodyOf(routes.request, 1)).toEqual({ email: "user@example.com" });
    expect(screen.getByText("1分 00秒後に再送可能")).toBeInTheDocument();
    expect(mockResetWidget).toHaveBeenCalledTimes(1);
  });

  it("DD-AUTH-003 再送の送信中は「送信中...」で押せない", async () => {
    await renderPage();
    await sendRequestMail();
    await advance(60000);
    const pending = deferred<ReturnType<typeof res>>();
    routes.request.mockImplementationOnce(() => pending.promise);

    await click(screen.getByRole("button", { name: "再送信する" }));
    expect(screen.getByRole("button", { name: "送信中..." })).toBeDisabled();

    await act(async () => {
      pending.resolve(res({}));
    });
    await flush();
    expect(screen.queryByRole("button", { name: "送信中..." })).not.toBeInTheDocument();
  });

  it("DD-AUTH-003 再送が 429 なら上限の印を立て、Retry-After の秒数だけ待たせる", async () => {
    await renderPage();
    await sendRequestMail();
    await advance(60000);
    routes.request.mockImplementationOnce(async () =>
      res({}, { ok: false, status: 429, retryAfter: "120" }),
    );

    await click(screen.getByRole("button", { name: "再送信する" }));

    const limitText = "送信回数の上限に達しました。しばらく時間をおいてからお試しください。";
    expect(screen.getByText(limitText)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再送信する" })).not.toBeInTheDocument();
    expect(screen.queryByText(/後に再送可能/)).not.toBeInTheDocument();

    await advance(119000);
    expect(screen.getByText(limitText)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再送信する" })).not.toBeInTheDocument();

    await advance(1000);
    expect(screen.queryByText(limitText)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再送信する" })).toBeInTheDocument();
  });

  it.each([
    ["Retry-After が無い", null],
    ["Retry-After が数でない", "soon"],
    ["Retry-After が 0", "0"],
    ["Retry-After が負", "-5"],
  ])("DD-AUTH-003 再送が 429 で %s なら 3600 秒を待たせる", async (_name, retryAfter) => {
    await renderPage();
    await sendRequestMail();
    await advance(60000);
    routes.request.mockImplementationOnce(async () =>
      res({}, { ok: false, status: 429, retryAfter }),
    );
    await click(screen.getByRole("button", { name: "再送信する" }));
    const limitText = "送信回数の上限に達しました。しばらく時間をおいてからお試しください。";

    await advance(3599000);
    expect(screen.getByText(limitText)).toBeInTheDocument();

    await advance(1000);
    expect(screen.queryByText(limitText)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再送信する" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 再送がほかの失敗なら窓口の文を出し、再送の操作は残す", async () => {
    await renderPage();
    await sendRequestMail();
    await advance(60000);
    routes.request.mockImplementationOnce(async () =>
      res({ error: "窓口の文" }, { ok: false, status: 403 }),
    );

    await click(screen.getByRole("button", { name: "再送信する" }));

    expect(screen.getByText("窓口の文")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再送信する" })).toBeInTheDocument();
    expect(mockResetWidget).toHaveBeenCalled();
  });

  it("DD-AUTH-003 再送の失敗に窓口の文が無ければ「送信に失敗しました」を出す", async () => {
    await renderPage();
    await sendRequestMail();
    await advance(60000);
    routes.request.mockImplementationOnce(async () => res({}, { ok: false, status: 500 }));

    await click(screen.getByRole("button", { name: "再送信する" }));

    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();
  });

  it("DD-AUTH-003 再送の通信が投げたら「送信に失敗しました」を出す", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await renderPage();
    await sendRequestMail();
    await advance(60000);
    routes.request.mockImplementationOnce(async () => {
      throw new Error("network");
    });

    await click(screen.getByRole("button", { name: "再送信する" }));

    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("DD-AUTH-003 再送を押すたびに前の誤りを消す", async () => {
    await renderPage();
    await sendRequestMail();
    await advance(60000);
    routes.request.mockImplementationOnce(async () => res({}, { ok: false, status: 500 }));
    await click(screen.getByRole("button", { name: "再送信する" }));
    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();

    await click(screen.getByRole("button", { name: "再送信する" }));

    expect(screen.queryByText("送信に失敗しました")).not.toBeInTheDocument();
  });

  it("DD-AUTH-003 鍵があれば再送の操作に Turnstile の入れ物を描き、済むまで再送を押せない", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    await renderPage();
    act(() => mockHookState.onToken("token-1"));
    await sendRequestMail();
    mockContainerRef.mockClear();

    await advance(60000);

    expect(mockContainerRef).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    // 送信で Turnstile を引き直した後なので、トークンが空のあいだは押せない
    expect(screen.getByRole("button", { name: "再送信する" })).toBeDisabled();

    act(() => mockHookState.onToken("token-2"));
    expect(screen.getByRole("button", { name: "再送信する" })).toBeEnabled();
  });

  it("DD-AUTH-003 鍵が無ければ再送の操作に Turnstile の入れ物を描かない", async () => {
    await renderPage();
    await sendRequestMail();
    mockContainerRef.mockClear();

    await advance(60000);

    expect(mockContainerRef).not.toHaveBeenCalledWith(expect.any(HTMLDivElement));
    expect(screen.getByRole("button", { name: "再送信する" })).toBeEnabled();
  });

  it("DD-AUTH-003 「別のアドレスで送信」で送った時刻・待ち・上限・誤り・トークンを消してフォームへ戻す", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    await renderPage();
    act(() => mockHookState.onToken("token-1"));
    await sendRequestMail();
    await advance(60000);
    act(() => mockHookState.onToken("token-2"));
    routes.request.mockImplementationOnce(async () =>
      res({}, { ok: false, status: 429, retryAfter: "300" }),
    );
    await click(screen.getByRole("button", { name: "再送信する" }));
    expect(
      screen.getByText("送信回数の上限に達しました。しばらく時間をおいてからお試しください。"),
    ).toBeInTheDocument();

    await click(screen.getByRole("button", { name: "別のアドレスで送信" }));

    expect(screen.getByRole("heading", { level: 1, name: "パスワード再設定" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再設定メールを送信" })).toBeInTheDocument();
    expect(screen.queryByText(/送信回数の上限/)).not.toBeInTheDocument();
    // トークンを消したので、Turnstile をやり直すまで送れない
    type("Email", "other@example.com");
    await submit("再設定メールを送信");
    expect(screen.getByText("ボット検証を完了してください")).toBeInTheDocument();
    expect(routes.request).toHaveBeenCalledTimes(2);

    // 待ちも消えている。送り直すと 60 秒の待ちが最初から始まる
    act(() => mockHookState.onToken("token-3"));
    await submit("再設定メールを送信");
    expect(screen.getByText("1分 00秒後に再送可能")).toBeInTheDocument();
  });

  it("DD-AUTH-003 「別のアドレスで送信」で再送の誤りの文も消える", async () => {
    await renderPage();
    await sendRequestMail();
    await advance(60000);
    routes.request.mockImplementationOnce(async () => res({}, { ok: false, status: 500 }));
    await click(screen.getByRole("button", { name: "再送信する" }));
    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();

    await click(screen.getByRole("button", { name: "別のアドレスで送信" }));

    expect(screen.queryByText("送信に失敗しました")).not.toBeInTheDocument();
  });
});

describe("PasswordResetPage 新しいパスワード", () => {
  beforeEach(() => {
    routes.session.mockImplementation(async () => res({ ready: true, email: "user@example.com" }));
  });

  async function fillAndSubmit(password: string, confirmation: string) {
    type("New Password (16+ characters)", password);
    type("Confirm New Password (16+ characters)", confirmation);
    await submit("パスワードを更新");
  }

  it("DD-AUTH-003 2つの欄が空なら更新ボタンを押せず、どちらかが空でも押せない", async () => {
    await renderPage();
    const button = () => screen.getByRole("button", { name: "パスワードを更新" });
    expect(button()).toBeDisabled();

    type("New Password (16+ characters)", LONG_PASSWORD);
    expect(button()).toBeDisabled();

    type("Confirm New Password (16+ characters)", LONG_PASSWORD);
    expect(button()).toBeEnabled();

    type("New Password (16+ characters)", "");
    expect(button()).toBeDisabled();
  });

  it("DD-AUTH-003 成功したら新しいパスワードだけを送り、変えた結果を出して頁の見出しを描かない", async () => {
    await renderPage();

    await fillAndSubmit(LONG_PASSWORD, LONG_PASSWORD);

    const init = routes.confirm.mock.calls[0][0] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(bodyOf(routes.confirm)).toEqual({ new_password: LONG_PASSWORD });
    expect(
      screen.getByRole("heading", { level: 1, name: "パスワードを更新しました" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "パスワード再設定" })).not.toBeInTheDocument();
    expect(screen.getByText("新しいパスワードでログインしてください。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ログインへ" })).toHaveAttribute("href", "/login");
    expect(screen.queryByLabelText("New Password (16+ characters)")).not.toBeInTheDocument();
    expect(screen.queryByText(/user@example\.com/)).not.toBeInTheDocument();
  });

  it("DD-AUTH-003 16 文字に満たなければ長さの文を出し、送らない", async () => {
    await renderPage();

    await fillAndSubmit("short", "different");

    expect(screen.getByText("パスワードは16文字以上で入力してください")).toBeInTheDocument();
    // 長さで弾いたので、一致の確かめには進まない
    expect(screen.queryByText("パスワードが一致しません")).not.toBeInTheDocument();
    expect(routes.confirm).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 短いパスワードを2回同じに打っても、一致の前に長さで弾く", async () => {
    await renderPage();

    await fillAndSubmit("short", "short");

    expect(screen.getByText("パスワードは16文字以上で入力してください")).toBeInTheDocument();
    expect(routes.confirm).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 形の確かめが zod 以外の誤りを投げたら「入力に誤りがあります」を出す", async () => {
    jest.spyOn(ResetSessionConfirmSchema, "parse").mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    await renderPage();

    await fillAndSubmit(LONG_PASSWORD, LONG_PASSWORD);

    expect(screen.getByText("入力に誤りがあります")).toBeInTheDocument();
    expect(routes.confirm).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 2つの欄が違えば「パスワードが一致しません」を出し、送らない", async () => {
    await renderPage();

    await fillAndSubmit(LONG_PASSWORD, `${LONG_PASSWORD}x`);

    expect(screen.getByText("パスワードが一致しません")).toBeInTheDocument();
    expect(routes.confirm).not.toHaveBeenCalled();
  });

  it("DD-AUTH-003 確定が失敗したら窓口の文を出し、フォームを残す", async () => {
    routes.confirm.mockImplementation(async () =>
      res({ error: "窓口の文" }, { ok: false, status: 400 }),
    );
    await renderPage();

    await fillAndSubmit(LONG_PASSWORD, LONG_PASSWORD);

    expect(screen.getByText("窓口の文")).toBeInTheDocument();
    expect(screen.getByLabelText("New Password (16+ characters)")).toHaveValue(LONG_PASSWORD);
    expect(screen.queryByRole("heading", { name: "パスワードを更新しました" })).not.toBeInTheDocument();
  });

  it("DD-AUTH-003 確定の失敗に窓口の文が無ければ「再設定に失敗しました」を出す", async () => {
    routes.confirm.mockImplementation(async () => res({}, { ok: false, status: 500 }));
    await renderPage();

    await fillAndSubmit(LONG_PASSWORD, LONG_PASSWORD);

    expect(screen.getByText("再設定に失敗しました")).toBeInTheDocument();
  });

  it("DD-AUTH-003 確定の失敗の本文が JSON でなくても「再設定に失敗しました」を出す", async () => {
    routes.confirm.mockImplementation(async () => res(null, { ok: false, status: 500, badJson: true }));
    await renderPage();

    await fillAndSubmit(LONG_PASSWORD, LONG_PASSWORD);

    expect(screen.getByText("再設定に失敗しました")).toBeInTheDocument();
  });

  it("DD-AUTH-003 確定の通信が投げたら「再設定に失敗しました」を出す", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    routes.confirm.mockImplementation(async () => {
      throw new Error("network");
    });
    await renderPage();

    await fillAndSubmit(LONG_PASSWORD, LONG_PASSWORD);

    expect(screen.getByText("再設定に失敗しました")).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("DD-AUTH-003 確定の送信中は更新ボタンを押せない", async () => {
    const pending = deferred<ReturnType<typeof res>>();
    routes.confirm.mockImplementation(() => pending.promise);
    await renderPage();

    await fillAndSubmit(LONG_PASSWORD, LONG_PASSWORD);
    expect(screen.getByRole("button", { name: "パスワードを更新" })).toBeDisabled();

    await act(async () => {
      pending.resolve(res({}));
    });
    await flush();
    expect(screen.getByRole("heading", { name: "パスワードを更新しました" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 新しいパスワードの表示切替で、欄の種類・読み上げの名前・アイコンを切り替える", async () => {
    await renderPage();
    const field = () => screen.getByLabelText("New Password (16+ characters)");

    expect(field()).toHaveAttribute("type", "password");
    const show = screen.getByRole("button", { name: "パスワードを表示" });
    expect(show).toHaveAttribute("aria-pressed", "false");
    expect(show.querySelector("i")).toHaveClass("ri-eye-off-line");

    await click(show);

    expect(field()).toHaveAttribute("type", "text");
    const hide = screen.getByRole("button", { name: "パスワードを非表示" });
    expect(hide).toHaveAttribute("aria-pressed", "true");
    expect(hide.querySelector("i")).toHaveClass("ri-eye-line");

    await click(hide);

    expect(field()).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "パスワードを表示" })).toBeInTheDocument();
  });

  it("DD-AUTH-003 確認用の表示切替で、欄の種類・読み上げの名前・アイコンを切り替える", async () => {
    await renderPage();
    const field = () => screen.getByLabelText("Confirm New Password (16+ characters)");

    expect(field()).toHaveAttribute("type", "password");
    const show = screen.getByRole("button", { name: "確認用パスワードを表示" });
    expect(show).toHaveAttribute("aria-pressed", "false");
    expect(show.querySelector("i")).toHaveClass("ri-eye-off-line");

    await click(show);

    expect(field()).toHaveAttribute("type", "text");
    const hide = screen.getByRole("button", { name: "確認用パスワードを非表示" });
    expect(hide).toHaveAttribute("aria-pressed", "true");
    expect(hide.querySelector("i")).toHaveClass("ri-eye-line");
    // もう1つの欄は切り替わらない
    expect(screen.getByLabelText("New Password (16+ characters)")).toHaveAttribute("type", "password");

    await click(hide);
    expect(field()).toHaveAttribute("type", "password");
  });

  it("DD-AUTH-003 新しいパスワードの見せ方では Turnstile の入れ物を描かない", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    await renderPage();

    // 確認の間は申請の見せ方で入れ物が付くが、新しいパスワードの見せ方に変わると外れる
    const lastCall = mockContainerRef.mock.calls[mockContainerRef.mock.calls.length - 1];
    expect(lastCall[0]).toBeNull();
  });
});

describe("PasswordResetPage Turnstile の Script", () => {
  it("DD-AUTH-003 鍵があれば Script と入れ物を描き、読み終わりにフックの描画を渡す", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";

    await renderPage();

    expect(screen.getByTestId("turnstile-script")).toBeInTheDocument();
    expect(mockScriptProps.current).toEqual(
      expect.objectContaining({
        id: "turnstile-reset-script",
        src: "https://challenges.cloudflare.com/turnstile/v0/api.js",
        strategy: "afterInteractive",
        onReady: mockRenderWidget,
      }),
    );
    expect(mockHookState.siteKey).toBe("site-key");
    expect(mockContainerRef).toHaveBeenCalledWith(expect.any(HTMLDivElement));
  });

  it("DD-AUTH-003 鍵が無ければ Script も入れ物も描かない", async () => {
    await renderPage();

    expect(screen.queryByTestId("turnstile-script")).not.toBeInTheDocument();
    expect(mockContainerRef).not.toHaveBeenCalledWith(expect.any(HTMLDivElement));
    expect(mockHookState.siteKey).toBe("");
  });

  it("DD-AUTH-003 Turnstile のトークンはフックから頁の状態に渡る", async () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "site-key";
    await renderPage();
    act(() => mockHookState.onToken("token-9"));

    await sendRequestMail();

    expect(bodyOf(routes.request).turnstileToken).toBe("token-9");
  });
});
