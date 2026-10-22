// 電話番号の下4桁。DB の private.order_status_phone_last_four と同じ直し方にする
// （全角の数字0〜9だけを半角にして、数字以外を取り除く。それ以外の文字を数字として読まない）。
// 比べるのは DB の中だけ。ここでは保存済みの電話と入力を比べない。
const MAX_INPUT_LENGTH = 64;

function digitsOf(value: string): string {
  return value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, '');
}

/** 保存済みの電話番号の末尾4桁。数字が4桁に満たなければ null */
export function extractOrderStatusLastFour(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') {
    return null;
  }
  const digits = digitsOf(phone);
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** 入力された下4桁。1〜64字の文字列で、数字にそろえた結果がちょうど4桁の時だけ受ける */
export function parseOrderStatusLastFour(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_INPUT_LENGTH) {
    return null;
  }
  const digits = digitsOf(value);
  return digits.length === 4 ? digits : null;
}
