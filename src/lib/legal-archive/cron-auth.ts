import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function authorizeCronBearer(
  authorization: string | null,
  configuredSecret: string | undefined,
): boolean {
  if (!configuredSecret) return false;

  const expected = digest(`Bearer ${configuredSecret}`);
  const supplied = digest(authorization ?? '');
  return timingSafeEqual(expected, supplied);
}
