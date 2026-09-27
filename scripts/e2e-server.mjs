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
 * 起動済みのサーバーを使い回す場合は、そのサーバーも SERVER_ENV と同じ環境変数を付けて
 * 起動しておくこと。付けずに npm run start したサーバーでは、checkout の E2E が
 * 決済開始 API の 429 で落ちうる。
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

async function isUp() {
  try {
    await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
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
  console.log(`${BASE_URL} は起動済み。そのまま使う。`);
} else {
  if (!useDevServer) await run("build");
  startDetached(useDevServer ? "dev" : "start");

  let ready = false;
  for (let i = 0; i < READY_TIMEOUT_SECONDS; i += 1) {
    if (await isUp()) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready) {
    console.error(
      `サーバーが ${READY_TIMEOUT_SECONDS} 秒以内に ${BASE_URL} で応答しませんでした。`,
    );
    process.exit(1);
  }
  console.log(`${BASE_URL} を起動した。テスト後も起動したまま残る。`);
}

// Playwright はこのプロセスの終了を「サーバーが落ちた」と見なすので、
// テストが終わって kill されるまで生かしておく。
setInterval(() => {}, 1 << 30);
