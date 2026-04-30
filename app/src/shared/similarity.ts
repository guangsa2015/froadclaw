/**
 * 文本相似度工具 — 基于 Jaccard 句子集合相似度
 * 纯本地计算，零 LLM 成本
 */

/**
 * 将文本按句拆分为集合（去空、去重）
 * 支持中文常见分隔符：换行、句号、分号、逗号+数字序号
 */
function splitSentences(text: string): Set<string> {
  const parts = text
    .split(/[\n。；;]|(?:\d+[.、)）])/)
    .map((s) => s.replace(/\s+/g, "").trim())
    .filter((s) => s.length > 2);
  return new Set(parts);
}

/**
 * 计算两段文本的 Jaccard 句子集合相似度
 * @returns 0~1，1 表示完全相同
 */
export function jaccardSimilarity(textA: string, textB: string): number {
  if (!textA && !textB) return 1;
  if (!textA || !textB) return 0;

  const setA = splitSentences(textA);
  const setB = splitSentences(textB);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const s of setA) {
    if (setB.has(s)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
