import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { incrementCounterBy } from '@/features/auth/ratelimit';

const MEBIBYTE = 1024 * 1024;

export const MAX_LOOK_IMAGES_PER_REQUEST = 6;
export const MAX_LOOK_TOTAL_BYTES_PER_REQUEST = 20 * MEBIBYTE;
export const MAX_LOOK_TOTAL_BYTES_PER_HOUR = 60 * MEBIBYTE;

type MutationKind = 'create' | 'update' | 'status' | 'delete';

type RateLimitConfig = {
  limit: number;
  windowSeconds: number;
};

const mutationRateLimits: Record<MutationKind, RateLimitConfig> = {
  create: { limit: 10, windowSeconds: 600 },
  update: { limit: 15, windowSeconds: 600 },
  status: { limit: 30, windowSeconds: 600 },
  delete: { limit: 30, windowSeconds: 600 },
};

function buildHourlyBucketIso(windowSeconds: number): string {
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
}

function buildRateLimitErrorResponse(status: 429 | 503, message: string, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
  });
}

/**
 * 変更の種類ごとに、送り元と操作者の2段で回数を数え、超えたら断りの応答を返す。
 *
 * @impl IMPL-LOOK-144
 * @design DD-LOOK-066
 * @remarks 操作者の段を必ず持つので、盗まれた session が送り元の見出しを変えても同じ操作者は止まる（SEC-LOOK-011）。
 * 上限は、作成は重いので少なく、状態の切り替えと削除は軽いので多くする。
 */
export async function enforceAdminLookMutationRateLimit(input: {
  request: Request;
  actorId: string;
  kind: MutationKind;
}): Promise<Response | undefined> {
  const config = mutationRateLimits[input.kind];

  const ipLimited = await enforceRateLimit({
    request: input.request,
    endpoint: `admin:looks:${input.kind}`,
    limit: config.limit,
    windowSeconds: config.windowSeconds,
  });

  if (ipLimited) {
    return ipLimited;
  }

  const actorLimited = await enforceRateLimit({
    request: input.request,
    endpoint: `admin:looks:${input.kind}`,
    limit: config.limit,
    windowSeconds: config.windowSeconds,
    subject: input.actorId,
  });

  return actorLimited;
}

/**
 * 1回の要求の画像の枚数と合計の大きさを確かめ、誤りの文か null を返す。
 *
 * @impl IMPL-LOOK-145
 * @design DD-LOOK-067
 * @remarks 大きな画像を一度に上げて置き場と処理を使い切るのを止めるため、1枚ずつの検査の前に枚数と合計で断る。
 */
export function validateLookImageBatch(imageFiles: File[]): string | null {
  if (imageFiles.length > MAX_LOOK_IMAGES_PER_REQUEST) {
    return `A maximum of ${MAX_LOOK_IMAGES_PER_REQUEST} images is allowed per request`;
  }

  const totalBytes = imageFiles.reduce((sum, image) => sum + image.size, 0);

  if (totalBytes > MAX_LOOK_TOTAL_BYTES_PER_REQUEST) {
    return `Total image payload must be ${MAX_LOOK_TOTAL_BYTES_PER_REQUEST / MEBIBYTE}MB or less per request`;
  }

  return null;
}

/**
 * 操作者の1時間の画像の量を数え、超えた時と数え場所が使えない時は断りの応答を返す。
 *
 * @impl IMPL-LOOK-146
 * @design DD-LOOK-067
 * @remarks 数え場所が使えない時は通さずに 503 で断る（量の上限を素通りさせないため）。
 * 画像を付けない更新は量を使わないので、数え場所への書き込みを省いて数えない。
 */
export async function consumeAdminLookUploadQuota(input: {
  actorId: string;
  kind: Extract<MutationKind, 'create' | 'update'>;
  totalBytes: number;
}): Promise<Response | undefined> {
  if (input.totalBytes <= 0) {
    return undefined;
  }

  const windowSeconds = 60 * 60;
  const bucket = buildHourlyBucketIso(windowSeconds);

  try {
    const count = await incrementCounterBy({
      endpoint: `admin:looks:${input.kind}:upload-bytes`,
      bucket,
      increment: input.totalBytes,
      subject: input.actorId,
    });

    if (count > MAX_LOOK_TOTAL_BYTES_PER_HOUR) {
      return buildRateLimitErrorResponse(429, 'Upload quota exceeded', windowSeconds);
    }

    return undefined;
  } catch (error) {
    console.error('consumeAdminLookUploadQuota error:', error);
    return buildRateLimitErrorResponse(503, 'Rate limiter unavailable', windowSeconds);
  }
}