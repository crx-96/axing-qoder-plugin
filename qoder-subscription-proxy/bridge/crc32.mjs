/** ZIP 与 PNG 共用的 IEEE CRC-32 查找表，按反射多项式 0xEDB88320 计算每个字节的余数。 */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

/** 返回输入字节的无符号 IEEE CRC-32，供容器完整性检查；核心来源另由固定 SHA256 认证。 */
export function crc32(bytes) {
  // 初始值和最终异或均为全一，按标准顺序迭代每个字节。
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
