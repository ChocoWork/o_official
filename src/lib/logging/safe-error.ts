const SAFE_NAME = /^[A-Za-z0-9_$.-]{1,64}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,32}$/;

/** 記録に残してよい誤りの項目。message・details・hint・stack・入力の値は残さない。name は /^[A-Za-z0-9_$.-]{1,64}$/ に合う時だけ（Error 以外は 'UnknownError'）、code は /^[A-Za-z0-9_.-]{1,32}$/ に合う文字か整数だけ（無ければ null）。 */
export function describeErrorForLog(error: unknown): { name: string; code: string | null } {
  let name = 'UnknownError';
  let code: string | null = null;
  try {
    if (error instanceof Error && typeof error.name === 'string' && SAFE_NAME.test(error.name)) {
      name = error.name;
    }
    if (typeof error === 'object' && error !== null) {
      const raw = (error as { code?: unknown }).code;
      if (typeof raw === 'number' && Number.isInteger(raw)) {
        code = String(raw);
      } else if (typeof raw === 'string' && SAFE_CODE.test(raw)) {
        code = raw;
      }
    }
  } catch {
    // getter が投げても記録の側は止めない
  }
  return { name, code };
}
