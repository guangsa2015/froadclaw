const TRUNCATION_SUFFIX = "\n\n⚠️ [内容已截断，仅保留关键部分]";
const MIDDLE_OMISSION = "\n\n... [中间内容省略] ...\n\n";

/** 尾部是否包含重要信息 */
const IMPORTANT_TAIL_PATTERN =
  /error|exception|failed|fatal|traceback|panic|stack\s*trace|errno|exit\s*code|\}\s*$|total|summary|result/i;

/**
 * 截断工具执行结果（Head+Tail 策略）
 */
export function truncateToolResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const budget = maxChars - TRUNCATION_SUFFIX.length - MIDDLE_OMISSION.length;
  const MIN_KEEP = 200;

  const tail500 = text.slice(-500);
  if (IMPORTANT_TAIL_PATTERN.test(tail500) && budget > MIN_KEEP * 2) {
    const tailSize = Math.floor(budget * 0.3);
    const headSize = budget - tailSize;
    return text.slice(0, headSize) + MIDDLE_OMISSION + text.slice(-tailSize) + TRUNCATION_SUFFIX;
  }

  return text.slice(0, budget) + TRUNCATION_SUFFIX;
}
