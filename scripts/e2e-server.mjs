/**
 * E2E 用のサーバーを用意する（playwright.config.ts の webServer から呼ばれる）。
 *
 * 既定は本番ビルド（next build && next start）。dev サーバーはリクエストのたびに
 * オンデマンドコンパイルするので、件数が増えると実装とは無関係な失敗を出す。
 * デバッグ目的で dev を使う場合のみ E2E_DEV_SERVER=1 を付ける。
 *
 * サーバーは「親子関係を切って」起動する。Playwright はテスト終了時に webServer の
 * プロセスツリーを落とすため、素直に子として起動するとサーバーも一緒に消えてしまう。
 * 切り離しておけば、テストが終わってもサーバーは動いたまま残る。
 *
 * 3000番で動いているアプリを使い回すのは、/api/e2e/server-info が返す印が
 * playwright.config.ts の作った印（E2E_SERVER_FINGERPRINT）と同じときだけ。
 * 印を返さないアプリ（普段の開発サーバーなど）や違う印のアプリなら、止めて理由を出す。
 * 起動を待つときも、応答ではなく印の一致で「起動した」と判断する。確かめ終わったら
 * 「[e2e-server] ready」を出し、playwright.config.ts の webServer.wait がそれを待つ。
 * E2E_STRICT=1 のときは、印が合っても起動済みのアプリを使い回さない。
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = "http://localhost:3000";
const READY_TIMEOUT_SECONDS = 180;
const useDevServer = process.env.E2E_DEV_SERVER === "1";

// E2E 用のサーバーにだけ渡す環境変数。
// E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER: E2E はすべて 127.0.0.1 から決済開始 API を呼ぶので、
// IP 単位の上限（本番は10秒10回・10分60回）をこの倍率で引き上げる。アプリ側で30倍までに丸め、
// Vercel 上では無視する（FREQ-362）。
const SERVER_ENV = { ...process.env, E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER: "30" };

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalUrl(raw) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * 見張り（設計書 2026-10-05 グループ B の 7-3）。playwright.config.ts と同じ条件のうち、
 * 本番の DB・外へのメールにつながるものを、ビルドの前にもう一度確かめる。
 * playwright.config.ts を通さずにこのスクリプトを直接動かしたときの守りでもある。
 */
function findUnsafeSettings(env) {
  const problems = [];
  if (!isLocalUrl(env.NEXT_PUBLIC_SUPABASE_URL)) problems.push("NEXT_PUBLIC_SUPABASE_URL が手元（localhost）ではない");
  if (!isLocalUrl(env.SUPABASE_URL)) problems.push("SUPABASE_URL が手元（localhost）ではない");
  if (!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "")) problems.push("STRIPE_SECRET_KEY がテスト用（sk_test_ / rk_test_）ではない");
  if (env.MAIL_PROVIDER !== "local") problems.push("MAIL_PROVIDER が local ではない");
  if (!isLocalUrl(env.MAIL_LOCAL_URL)) problems.push("MAIL_LOCAL_URL が手元（localhost）ではない");
  if (env.RESEND_API_KEY) problems.push("RESEND_API_KEY が空ではない");
  if (!env.E2E_SERVER_FINGERPRINT) problems.push("E2E_SERVER_FINGERPRINT が無い（playwright.config.ts を通さずに起動した）");
  return problems;
}

const problems = findUnsafeSettings(process.env);
if (problems.length > 0) {
  console.error(`[e2e-server] 見張り: 本番につながるおそれがあるので起動しない。\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

/** 3000番のアプリが返す印。印を返さないアプリなら null。 */
async function runningFingerprint() {
  try {
    const res = await fetch(`${BASE_URL}/api/e2e/server-info`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.fingerprint === "string" ? body.fingerprint : null;
  } catch {
    return null;
  }
}

async function isUp() {
  try {
    await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch (error) {
    // scripts/e2e/environment.ts の probeServer と同じく、接続拒否だけを「空き」とする。
    const cause = error && typeof error === "object" ? error.cause : null;
    if (!cause || typeof cause !== "object") return true;
    if (cause instanceof AggregateError) {
      return !(cause.errors.length > 0 && cause.errors.every(
        (item) => item && typeof item === "object" && item.code === "ECONNREFUSED",
      ));
    }
    return cause.code !== "ECONNREFUSED";
  }
}

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script], {
      stdio: "inherit",
      shell: true,
    });
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`npm run ${script} が終了コード ${code} で失敗`)),
    );
  });
}

/** Playwright のプロセスツリー kill から外れるように起動する。 */
function startDetached(script) {
  if (process.platform === "win32") {
    // cmd 自体はすぐ終わるので、起動したサーバーは孤児になりツリーから外れる。
    spawn("cmd", ["/c", "start", "/b", "npm", "run", script], {
      stdio: "ignore",
      windowsHide: true,
      env: SERVER_ENV,
    }).unref();
    return;
  }
  spawn("npm", ["run", script], { stdio: "ignore", detached: true, env: SERVER_ENV }).unref();
}

if (await isUp()) {
  if (process.env.E2E_STRICT === "1") {
    console.error(
      `[e2e-server] 見張り: E2E_STRICT=1 では起動済みのアプリを使い回さない。${BASE_URL} のアプリを止めてから流して。`,
    );
    process.exit(1);
  }
  if ((await runningFingerprint()) !== process.env.E2E_SERVER_FINGERPRINT) {
    console.error(
      `[e2e-server] 見張り: ${BASE_URL} で、この E2E が手元の設定で起動したものではないアプリが動いている。止めてから流して。`,
    );
    process.exit(1);
  }
  console.log(`${BASE_URL} は E2E 用に起動済み。そのまま使う。`);
} else {
  if (!useDevServer) await run("build");
  startDetached(useDevServer ? "dev" : "start");

  // 応答があるだけでは「起動した」と見なさない。ビルドの間にほかのアプリが 3000番を取ると、
  // 自分のサーバーはポートの使用中で起動できず、ほかのアプリが応答する。印が合うまで待つ。
  const deadline = Date.now() + READY_TIMEOUT_SECONDS * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    if ((await runningFingerprint()) === process.env.E2E_SERVER_FINGERPRINT) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready) {
    if (await isUp()) {
      console.error(
        `[e2e-server] 見張り: ${BASE_URL} で、この E2E が起動したものではないアプリが応答している（自分のサーバーはポートの使用中で起動できなかったおそれがある）。止めてから流して。`,
      );
    } else {
      console.error(
        `サーバーが ${READY_TIMEOUT_SECONDS} 秒以内に ${BASE_URL} で応答しませんでした。`,
      );
    }
    process.exit(1);
  }
  console.log(`${BASE_URL} を起動した。テスト後も起動したまま残る。`);
}

// playwright.config.ts の webServer.wait がこの1行を待つ。印を確かめ終わってから出すこと。
console.log("[e2e-server] ready");

// Playwright はこのプロセスの終了を「サーバーが落ちた」と見なすので、
// テストが終わって kill されるまで生かしておく。
setInterval(() => {}, 1 << 30);
