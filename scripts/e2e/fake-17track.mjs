/**
 * 作り物の 17TRACK（グループ E-4 の E2E 用。実装計画 Task 13、設計書の付録 v2.4）。
 *
 * - 127.0.0.1:4017 だけで待ち受ける。本物の 17TRACK へは転送しない（外へつなぐ処理は持たない）。
 * - 答えの形は共通の見本 tests/fixtures/17track/v2.4.json の写し。見本を複製して、番号・運送会社・時刻だけを差し替える
 *   （rejected の carrier は付録どおり 0）。
 * - 通常の口（/track/v2.4/register・retrack・gettrackinfo・stoptrack）は 17token の見出しが作り物の鍵と同じ時だけ答える。
 *   制御の口（/__control/*）は x-e2e-control の見出しが作り物の鍵と同じ時だけ答える。
 * - 受け取るのは配列の { number, carrier } だけ（40件まで）。ほかの項目（名前・住所など）が付いた要求は、答えずに断る。
 *   記録するのは、口の道・番号・運送会社の番号だけ。見出し・鍵・本文のほかの項目は記録しない。
 * - 状態は組（運送会社, 大文字の番号）ごと。制御の口は自分の組だけを変え・読み・消す（全件を消す口は作らない）。
 *
 * 制御の口:
 *   POST   /__control/state                       { carrier, number, responseKey, happenedAt?, deliveredAt? }
 *   GET    /__control/calls?carrier=&number=      その組への呼び出し [{ path, number, carrier }]
 *   DELETE /__control/state?carrier=&number=      その組の状態と記録を消す
 * responseKey は見本の responses の名前。見本に無い failure（Exception_Other）・attemptedDelivery（DeliveryFailure_NoBody）は、
 * inTransit の複製に状況の記号だけを替えた作り物の物（src/lib/orders/tracking/seventeen-track-status.ts の対応表に合わせる）。
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORT = 4017;
const MAX_BODY_BYTES = 1024 * 1024;
const CARRIERS = new Set([100062, 100040, 10021]);
const NUMBER_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/17track/v2.4.json', import.meta.url), 'utf8'));
const KEY = process.env.TRACKING_17TRACK_API_KEY;
if (!KEY) {
  console.error('[fake-17track] TRACKING_17TRACK_API_KEY（E2E 用の作り物の鍵）が無いので起動しない');
  process.exit(1);
}

/** 見本に無い状況の作り物。inTransit の複製の status / sub_status だけを替える */
const DERIVED = {
  failure: { status: 'Exception', sub_status: 'Exception_Other' },
  attemptedDelivery: { status: 'DeliveryFailure', sub_status: 'DeliveryFailure_NoBody' },
};

function responseOf(key) {
  if (Object.hasOwn(DERIVED, key)) {
    const base = structuredClone(fixture.responses.inTransit);
    Object.assign(base.data.accepted[0].track_info.latest_status, DERIVED[key]);
    return base;
  }
  return Object.hasOwn(fixture.responses, key) ? structuredClone(fixture.responses[key]) : null;
}

const isRejection = (response) => response.data.accepted.length === 0 && response.data.rejected.length > 0;
/** 登録の口でも断りを返せる見本の名前（番号が正しくない・口座ぜんたいの失敗） */
const REGISTER_REJECTIONS = new Set(['invalidNumber', 'accountQuota']);

/** 組（運送会社, 大文字の番号）ごとの状態 */
const pairs = new Map();
const keyOf = (carrier, number) => `${carrier}:${String(number).toUpperCase()}`;
function stateOf(carrier, number) {
  const key = keyOf(carrier, number);
  let state = pairs.get(key);
  if (!state) {
    state = { registered: false, stopped: false, retrackUsed: false, control: null, calls: [] };
    pairs.set(key, state);
  }
  return state;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 要求の本文が「{ number, carrier } だけの配列（40件まで）」か。ほかの項目が付いていれば null（断る） */
function parsePairs(body) {
  if (!Array.isArray(body) || body.length === 0 || body.length > 40) return null;
  const result = [];
  for (const item of body) {
    if (!isPlainObject(item)) return null;
    const keys = Object.keys(item).sort();
    if (keys.length !== 2 || keys[0] !== 'carrier' || keys[1] !== 'number') return null;
    if (typeof item.number !== 'string' || !NUMBER_PATTERN.test(item.number)) return null;
    if (!Number.isInteger(item.carrier) || !CARRIERS.has(item.carrier)) return null;
    result.push({ number: item.number, carrier: item.carrier });
  }
  return result;
}

const acceptedRow = (pair) => ({ number: pair.number, carrier: pair.carrier });

/** 見本の rejected の1行を複製して番号だけ差し替える（carrier は見本どおり 0）。code を渡せば付録に無い code の行にも使う */
function rejectedRow(templateKey, number, code) {
  const row = structuredClone(fixture.responses[templateKey].data.rejected[0]);
  row.number = number;
  if (code !== undefined) row.error.code = code;
  return row;
}

function applyTimes(trackInfo, happenedAt, deliveredAt) {
  const toIso = (value) => new Date(value).toISOString();
  const toUtc = (value) => toIso(value).slice(0, 19).replace('T', ' ');
  if (trackInfo.latest_event) {
    trackInfo.latest_event.time_iso = toIso(happenedAt);
    trackInfo.latest_event.time_utc = toUtc(happenedAt);
  }
  for (const milestone of trackInfo.milestone ?? []) {
    const at = milestone.key_stage === 'Delivered' ? deliveredAt ?? happenedAt : happenedAt;
    milestone.time_iso = toIso(at);
    if ('time_utc' in milestone) milestone.time_utc = toUtc(at);
  }
}

/** 1つの組への答え。{ accepted: 行 | null, rejected: 行 | null } */
function answerFor(method, pair) {
  const state = stateOf(pair.carrier, pair.number);
  state.calls.push({ path: `/track/v2.4/${method}`, number: pair.number, carrier: pair.carrier });
  if (state.calls.length > 200) state.calls.shift();
  const control = state.control;

  if (method === 'register') {
    if (control && REGISTER_REJECTIONS.has(control.responseKey)) {
      return { rejected: rejectedRow(control.responseKey, pair.number) };
    }
    if (state.registered) return { rejected: rejectedRow('alreadyRegistered', pair.number) };
    state.registered = true;
    state.stopped = false;
    return { accepted: acceptedRow(pair) };
  }
  if (method === 'retrack') {
    if (!state.registered) return { rejected: rejectedRow('notRegistered', pair.number) };
    // 追跡中の組のやり直しは -18019904、止めた組は1回だけ成功、2回目は -18019905
    if (!state.stopped) return { rejected: rejectedRow('alreadyRegistered', pair.number, -18019904) };
    if (state.retrackUsed) return { rejected: rejectedRow('retrackExhausted', pair.number) };
    state.retrackUsed = true;
    state.stopped = false;
    return { accepted: acceptedRow(pair) };
  }
  if (method === 'stoptrack') {
    if (!state.registered) return { rejected: rejectedRow('notRegistered', pair.number) };
    if (state.stopped) return { rejected: rejectedRow('alreadyRegistered', pair.number, -18019906) };
    state.stopped = true;
    return { accepted: acceptedRow(pair) };
  }

  // gettrackinfo
  if (!state.registered) return { rejected: rejectedRow('notRegistered', pair.number) };
  const response = control ? responseOf(control.responseKey) : null;
  if (!response) return { rejected: rejectedRow('noInformation', pair.number) };
  if (isRejection(response)) return { rejected: rejectedRow(control.responseKey, pair.number) };
  const row = response.data.accepted[0];
  row.number = pair.number;
  row.carrier = pair.carrier;
  if (row.track_info) applyTimes(row.track_info, control.happenedAt ?? new Date().toISOString(), control.deliveredAt);
  return { accepted: row };
}

async function handleTrack(req, res, method) {
  if (req.headers['17token'] !== KEY) {
    sendJson(res, 401, { code: -18010001, data: null });
    return;
  }
  let pairsOfRequest = null;
  try {
    pairsOfRequest = parsePairs(await readJson(req));
  } catch {
    pairsOfRequest = null;
  }
  if (!pairsOfRequest) {
    // 渡してよいのは伝票番号と運送会社の番号だけ。名前・住所などが付いた要求や、形の違う要求は記録せずに断る
    sendJson(res, 400, { code: -18010002, data: null });
    return;
  }
  const accepted = [];
  const rejected = [];
  for (const pair of pairsOfRequest) {
    const answer = answerFor(method, pair);
    if (answer.accepted) accepted.push(answer.accepted);
    if (answer.rejected) rejected.push(answer.rejected);
  }
  sendJson(res, 200, { code: 0, data: { accepted, rejected } });
}

function pairFromQuery(url) {
  const carrier = Number(url.searchParams.get('carrier'));
  const number = url.searchParams.get('number');
  if (!Number.isInteger(carrier) || !CARRIERS.has(carrier) || !number || !NUMBER_PATTERN.test(number)) return null;
  return { carrier, number };
}

async function handleControl(req, res, url) {
  if (req.headers['x-e2e-control'] !== KEY) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__control/state') {
    let input;
    try {
      input = await readJson(req);
    } catch {
      sendJson(res, 400, { error: 'invalid body' });
      return;
    }
    const valid = isPlainObject(input)
      && Number.isInteger(input.carrier) && CARRIERS.has(input.carrier)
      && typeof input.number === 'string' && NUMBER_PATTERN.test(input.number)
      && typeof input.responseKey === 'string' && responseOf(input.responseKey) !== null
      && (input.happenedAt === undefined || (typeof input.happenedAt === 'string' && !Number.isNaN(Date.parse(input.happenedAt))))
      && (input.deliveredAt === undefined || (typeof input.deliveredAt === 'string' && !Number.isNaN(Date.parse(input.deliveredAt))));
    if (!valid) {
      sendJson(res, 400, { error: 'invalid state' });
      return;
    }
    // 時刻を渡さなければ、読まれた時刻にする（gettrackinfo の答えを作る時）。発送を作る前に答えを決めておいても、
    // 出来事の時刻が発送の時刻より前にならず、読むたびに新しい状況の時刻が前の状況より後になる。読んだ時刻より後にもならない
    stateOf(input.carrier, input.number).control = {
      responseKey: input.responseKey,
      happenedAt: input.happenedAt,
      deliveredAt: input.deliveredAt,
    };
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__control/calls') {
    const pair = pairFromQuery(url);
    if (!pair) {
      sendJson(res, 400, { error: 'invalid pair' });
      return;
    }
    sendJson(res, 200, stateOf(pair.carrier, pair.number).calls.map((call) => ({ ...call })));
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/__control/state') {
    const pair = pairFromQuery(url);
    if (!pair) {
      sendJson(res, 400, { error: 'invalid pair' });
      return;
    }
    pairs.delete(keyOf(pair.carrier, pair.number));
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

const TRACK_PREFIX = '/track/v2.4/';
const METHODS = new Set(['register', 'retrack', 'gettrackinfo', 'stoptrack']);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const run = async () => {
    if (req.method === 'GET' && url.pathname === '/__health') {
      sendJson(res, 200, { fake: fixture.contract });
      return;
    }
    if (url.pathname.startsWith('/__control/')) {
      await handleControl(req, res, url);
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith(TRACK_PREFIX) && METHODS.has(url.pathname.slice(TRACK_PREFIX.length))) {
      await handleTrack(req, res, url.pathname.slice(TRACK_PREFIX.length));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  };
  run().catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: 'fake failed' });
    else res.end();
  });
});

server.on('error', (error) => {
  console.error(`[fake-17track] 起動できない: ${error.code ?? 'unknown'}`);
  process.exit(1);
});
server.listen(PORT, HOST);
