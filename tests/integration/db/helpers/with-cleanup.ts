/**
 * 試験の後始末（finally）が、本当の失敗を隠さないための道具（G-2 Task 9 のレビュー M9）。
 * body が通った時は、後始末の失敗をそのまま投げる（後始末が壊れたことを黙らせない）。
 * body が失敗した時は、後始末を試みるが、その失敗は投げない（本当の失敗を上書きしない）。
 * 後始末の失敗は、名前とあれば code だけを警告に出す（DB の生の文・値は出さない）。
 */
export async function withCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (failure) {
    try {
      await cleanup();
    } catch (cleanupFailure) {
      const { name = 'Error', code = null } = (typeof cleanupFailure === 'object' && cleanupFailure !== null ? cleanupFailure : {}) as { name?: string; code?: unknown };
      console.warn(`[withCleanup] cleanup failed after the test body failed: ${name} ${String(code)}`);
    }
    throw failure;
  }
  await cleanup();
  return result;
}
