import { md5 } from '@/shared/utils/md5';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52
];

function getMixinKey(originKey: string): string {
  return MIXIN_KEY_ENC_TAB.map((index) => originKey[index]).join('').slice(0, 32);
}

function sanitizeValue(value: string): string {
  return value.replace(/[!'()*]/g, '');
}

/**
 * 生成 WBI 签名参数：用于调用要求 w_rid / wts 的空间投稿接口。
 */
export function signWbiParams(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string
): Record<string, string> {
  const mixinKey = getMixinKey(`${imgKey}${subKey}`);
  const wts = Math.floor(Date.now() / 1000).toString();

  const normalizedParams: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    wts
  };

  const sortedKeys = Object.keys(normalizedParams).sort();
  const query = sortedKeys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(sanitizeValue(normalizedParams[key]))}`)
    .join('&');

  const wRid = md5(query + mixinKey);

  return {
    ...normalizedParams,
    w_rid: wRid
  };
}

export function extractWbiKey(url: string): string {
  const pathname = new URL(url).pathname;
  const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
  return filename.split('.')[0] ?? '';
}
