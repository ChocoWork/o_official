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
 *
 * 配送の追跡（グループ E-4）の E2E は、本物の 17TRACK ではなく手元の作り物（scripts/e2e/fake-17track.mjs。127.0.0.1:4017 だけ）を使う。
 * 作り物もアプリと同じく「親子関係を切って」起動し、テスト後も動いたまま残る。4017番の /__health が、契約版まで合う作り物の印を返す時だけ
 * 使い回し、別のプロセスが4017番にいれば止めずに失敗にする。ビルドの前に確かめる。
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const BASE_URL = "http://localhost:3000";
const READY_TIMEOUT_SECONDS = 180;
// 作り物の 17TRACK。port と鍵は scripts/e2e/environment.ts と同じ値（ずれは単体の試験が見つける）
const FAKE_17TRACK_PORT = 4017;
const FAKE_17TRACK_KEY = "e2e-fake-17track-key-0123456789";
const FAKE_ORIGIN = `http://127.0.0.1:${FAKE_17TRACK_PORT}`;
const FAKE_READY_TIMEOUT_SECONDS = 20;
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
 * 17TRACK の接続先が、手元の作り物（http・loopback・4017番・/track/v2.4 だけ）かを見る。安全なら null、そうでなければ止める理由。
 * 省略（アプリは本物の https://api.17track.net へ向かう）・本番・手元でない住所・別の道・別の port・URL の中の認証情報を拒む。
 * 理由には URL の中身を出さない（認証情報が入りうるため）。scripts/e2e/environment.ts の同名の見張りと同じ条件。
 */
function findUnsafeTrackingUrl(raw) {
  if (!raw || raw.trim() === "") return "TRACKING_17TRACK_BASE_URL が無い（省略すると本番の 17TRACK へ向かう）";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "TRACKING_17TRACK_BASE_URL が URL ではない（17TRACK の作り物の住所だけを受け付ける）";
  }
  if (url.username !== "" || url.password !== "") return "TRACKING_17TRACK_BASE_URL に認証情報が入っている";
  if (url.protocol !== "http:" || !LOCAL_HOSTNAMES.has(url.hostname)) {
    return "TRACKING_17TRACK_BASE_URL が手元の 17TRACK の作り物（http の loopback）ではない";
  }
  if (url.port !== String(FAKE_17TRACK_PORT)) {
    return `TRACKING_17TRACK_BASE_URL が 17TRACK の作り物の port（${FAKE_17TRACK_PORT}番）ではない`;
  }
  if (url.pathname.replace(/\/+$/, "") !== "/track/v2.4" || url.search !== "" || url.hash !== "") {
    return "TRACKING_17TRACK_BASE_URL が 17TRACK の作り物の道（/track/v2.4）ではない";
  }
  return null;
}

/**
 * 見張り（設計書 2026-10-05 グループ B の 7-3）。playwright.config.ts と同じ条件のうち、
 * 本番の DB・外へのメール・本物の 17TRACK につながるものを、ビルドの前にもう一度確かめる。
 * playwright.config.ts を通さずにこのスクリプトを直接動かしたときの守りでもある（17TRACK の接続先の省略もここで拒む）。
 */
function findUnsafeSettings(env) {
  const problems = [];
  if (!isLocalUrl(env.NEXT_PUBLIC_SUPABASE_URL)) problems.push("NEXT_PUBLIC_SUPABASE_URL が手元（localhost）ではない");
  if (!isLocalUrl(env.SUPABASE_URL)) problems.push("SUPABASE_URL が手元（localhost）ではない");
  if (!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "")) problems.push("STRIPE_SECRET_KEY がテスト用（sk_test_ / rk_test_）ではない");
  if (env.MAIL_PROVIDER !== "local") problems.push("MAIL_PROVIDER が local ではない");
  if (!isLocalUrl(env.MAIL_LOCAL_URL)) problems.push("MAIL_LOCAL_URL が手元（localhost）ではない");
  if (env.RESEND_API_KEY) problems.push("RESEND_API_KEY が空ではない");
  const trackingUrlProblem = findUnsafeTrackingUrl(env.TRACKING_17TRACK_BASE_URL);
  if (trackingUrlProblem) problems.push(trackingUrlProblem);
  // 鍵の値は理由に出さない
  if (env.TRACKING_17TRACK_API_KEY !== FAKE_17TRACK_KEY) {
    problems.push("TRACKING_17TRACK_API_KEY が E2E 用の作り物の鍵ではない（本物の 17TRACK の鍵かもしれない）");
  }
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

/** 4017番の答えから、作り物を起こす・使い回す・止めるを決める。作り物の印（/__health の fake）が契約版まで合う時だけ使い回す。 */
function decideFake(probe, contract) {
  if (probe.kind === "down") return "start";
  return probe.fake === contract ? "reuse" : "conflict";
}

/** 接続拒否（その port に何もいない）だけを「空き」とする。isUp と同じ分類 */
function isRefused(error) {
  const cause = error && typeof error === "object" ? error.cause : null;
  if (!cause || typeof cause !== "object") return false;
  if (cause instanceof AggregateError) {
    return cause.errors.length > 0 && cause.errors.every(
      (item) => item && typeof item === "object" && item.code === "ECONNREFUSED",
    );
  }
  return cause.code === "ECONNREFUSED";
}

/** 4017番の /__health を読む。作り物の印を返さないもの（別のプロセス）は fake が null */
async function probeFake() {
  try {
    const res = await fetch(`${FAKE_ORIGIN}/__health`, { signal: AbortSignal.timeout(2000) });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { kind: "up", fake: body !== null && typeof body === "object" && typeof body.fake === "string" ? body.fake : null };
  } catch (error) {
    return isRefused(error) ? { kind: "down" } : { kind: "up", fake: null };
  }
}

/** アプリと同じく Playwright のプロセスツリー kill から外れるように、作り物を隠れた別プロセスで起こす（本物の 17TRACK へは転送しない） */
function startFakeDetached() {
  const script = fileURLToPath(new URL("./e2e/fake-17track.mjs", import.meta.url));
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "/b", "node", script], { stdio: "ignore", windowsHide: true, env: SERVER_ENV }).unref();
    return;
  }
  spawn(process.execPath, [script], { stdio: "ignore", detached: true, env: SERVER_ENV }).unref();
}

function failFake(reason) {
  console.error(`[e2e-server] 見張り: ${reason}`);
  process.exit(1);
}

/** 作り物の 17TRACK を使える状態にする。別のプロセスが4017番にいれば、止めずに失敗にする */
async function ensureFake() {
  // 共通の見本と同じ契約版を、作り物の印として使う（作り物もこの見本を読む）
  const contract = JSON.parse(
    readFileSync(fileURLToPath(new URL("../tests/fixtures/17track/v2.4.json", import.meta.url)), "utf8"),
  ).contract;
  const conflict = `${FAKE_17TRACK_PORT}番で、この E2E の 17TRACK の作り物ではないプロセスが動いている（契約版が違う古い作り物かもしれない）。止めてから流して。`;
  const first = decideFake(await probeFake(), contract);
  if (first === "conflict") failFake(conflict);
  if (first === "reuse") {
    console.log(`17TRACK の作り物は起動済み（${FAKE_ORIGIN}）。そのまま使う。`);
    return;
  }
  startFakeDetached();
  const deadline = Date.now() + FAKE_READY_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const next = decideFake(await probeFake(), contract);
    if (next === "reuse") {
      console.log(`17TRACK の作り物を起動した（${FAKE_ORIGIN}）。テスト後も起動したまま残る。`);
      return;
    }
    if (next === "conflict") failFake(conflict);
    await sleep(250);
  }
  failFake(`17TRACK の作り物が ${FAKE_READY_TIMEOUT_SECONDS} 秒以内に ${FAKE_ORIGIN} で応答しなかった。`);
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
  await ensureFake();
  console.log(`${BASE_URL} は E2E 用に起動済み。そのまま使う。`);
} else {
  // 長いビルドの前に、4017番の状態を確かめる（別のプロセスがいれば、ビルドせずに失敗にする）
  await ensureFake();
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
