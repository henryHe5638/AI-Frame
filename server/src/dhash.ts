import sharp from "sharp";

/**
 * dHash（差异哈希）：解码后拉伸缩到 9x8 灰度，横向相邻像素比较得到 64bit，
 * 以 16 位十六进制字符串返回。sharp 支持 Immich 缩略图可能返回的
 * JPEG / WebP / PNG 等格式，解码失败返回 null。
 */
export async function computeDhash(buffer: Buffer): Promise<string | null> {
  let gray: Buffer;
  try {
    gray = await sharp(buffer, { limitInputPixels: 1e8 })
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();
  } catch {
    return null;
  }
  const W = 9, H = 8;
  if (gray.length < W * H) return null;

  // 横向比较：左 > 右 记 1，共 8 行 × 8 比较 = 64bit
  let bits = 0n;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits = (bits << 1n) | (gray[y * W + x] > gray[y * W + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

const hexCache = new Map<string, bigint>();

function toBigInt(hex: string): bigint {
  let v = hexCache.get(hex);
  if (v === undefined) {
    v = BigInt(`0x${hex}`);
    hexCache.set(hex, v);
  }
  return v;
}

/** 两个 16 位十六进制 dhash 的汉明距离 */
export function hammingDistance(hexA: string, hexB: string): number {
  let x = toBigInt(hexA) ^ toBigInt(hexB);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
