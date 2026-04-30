/** 保守估算 token 数（中英混合场景，~4字符≈1token，1.2倍安全系数） */
export function estimateTokens(text: string): number {
  const CHARS_PER_TOKEN = 4;
  const SAFETY_FACTOR = 1.2;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_FACTOR);
}
