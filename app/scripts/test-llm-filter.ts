/**
 * 独立测试脚本 — 验证 LLM 资讯筛选端到端流程
 *
 * 用法: npx tsx scripts/test-llm-filter.ts
 *
 * 流程:
 * 1. 初始化 SQLite + Provider
 * 2. 查看当前 pending 条目统计
 * 3. 调用 filterNewsByLlm 进行筛选
 * 4. 输出筛选结果统计（kept/dropped/duplicate）
 */
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { SqliteSessionStore } from "../src/session/store/sqlite.js";
import { OpenAICompatibleProvider } from "../src/llm/openai-compatible/client.js";
import { filterNewsByLlm } from "../src/tool/finance-news/news-filter-llm.js";

// 加载 .env
loadEnv({ path: resolve(import.meta.dirname, "../.env") });

const DASHSCOPE_API_KEY = process.env["DASHSCOPE_API_KEY"] ?? "";
const SUMMARY_MODEL = process.env["SUMMARY_MODEL"] ?? "qwen-plus";

async function main(): Promise<void> {
  console.log("=== LLM 资讯筛选测试 ===\n");

  // 1. 初始化 SQLite
  const dbPath = resolve(import.meta.dirname, "../data/froadclaw.db");
  const store = await SqliteSessionStore.create(dbPath);
  console.log(`✅ SQLite 已加载: ${dbPath}\n`);

  // 2. 查看 pending 统计
  const pending = store.getPendingNews(48, 200);
  console.log(`📋 当前 pending 条目: ${pending.length} 条`);
  if (pending.length === 0) {
    console.log("⚠️ 没有待筛选条目，请先运行数据采集");
    return;
  }

  // 按来源分组统计
  const sourceCount: Record<string, number> = {};
  for (const p of pending) {
    sourceCount[p.source] = (sourceCount[p.source] ?? 0) + 1;
  }
  console.log("   来源分布:", sourceCount);

  // 按重要度分组统计
  const impCount: Record<string, number> = {};
  for (const p of pending) {
    impCount[p.importance] = (impCount[p.importance] ?? 0) + 1;
  }
  console.log("   重要度分布:", impCount);
  console.log();

  // 3. 初始化 Provider
  const provider = new OpenAICompatibleProvider(
    "qwen",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    DASHSCOPE_API_KEY,
    [SUMMARY_MODEL],
  );
  console.log(`🤖 使用模型: ${SUMMARY_MODEL}\n`);

  // 4. 执行 LLM 筛选
  console.log("🔄 开始 LLM 筛选...\n");
  const startMs = Date.now();

  const processed = await filterNewsByLlm(
    { provider, model: SUMMARY_MODEL, store, batchSize: 50 },
    48,
  );

  const durationMs = Date.now() - startMs;
  console.log(`\n✅ 筛选完成: ${processed} 条, 耗时 ${(durationMs / 1000).toFixed(1)}s\n`);

  // 5. 查看筛选结果统计 — 通过 getDatabase() 直接查询
  const db = store.getDatabase();

  const statsStmt = db.prepare(
    `SELECT llm_status, count(*) AS cnt
     FROM news_cache
     WHERE published_at > datetime('now', '-48 hours')
     GROUP BY llm_status
     ORDER BY cnt DESC`,
  );
  console.log("📊 筛选后状态分布:");
  while (statsStmt.step()) {
    const row = statsStmt.getAsObject();
    console.log(`   ${row["llm_status"]}: ${row["cnt"]} 条`);
  }
  statsStmt.free();

  // 6. 打印被丢弃的条目（附原因）
  const droppedStmt = db.prepare(
    `SELECT id, source, title, llm_reason
     FROM news_cache
     WHERE llm_status = 'dropped' AND published_at > datetime('now', '-48 hours')
     ORDER BY id`,
  );
  const dropped: Array<{ id: number; source: string; title: string; llmReason: string | null }> = [];
  while (droppedStmt.step()) {
    const r = droppedStmt.getAsObject();
    dropped.push({
      id: r["id"] as number,
      source: r["source"] as string,
      title: r["title"] as string,
      llmReason: (r["llm_reason"] as string) ?? null,
    });
  }
  droppedStmt.free();

  if (dropped.length > 0) {
    console.log(`\n🗑️ 被丢弃的条目 (${dropped.length} 条):`);
    for (const d of dropped) {
      console.log(`   [ID:${d.id}] [${d.source}] ${d.title || "(无标题)"} — ${d.llmReason ?? "无原因"}`);
    }
  }

  // 7. 打印被标记 duplicate 的条目
  const dupStmt = db.prepare(
    `SELECT id, source, title, llm_reason
     FROM news_cache
     WHERE llm_status = 'duplicate' AND published_at > datetime('now', '-48 hours')
     ORDER BY id`,
  );
  const duplicates: Array<{ id: number; source: string; title: string; llmReason: string | null }> = [];
  while (dupStmt.step()) {
    const r = dupStmt.getAsObject();
    duplicates.push({
      id: r["id"] as number,
      source: r["source"] as string,
      title: r["title"] as string,
      llmReason: (r["llm_reason"] as string) ?? null,
    });
  }
  dupStmt.free();
  if (duplicates.length > 0) {
    console.log(`\n🔁 重复条目 (${duplicates.length} 条):`);
    for (const d of duplicates) {
      console.log(`   [ID:${d.id}] [${d.source}] ${d.title || "(无标题)"} — ${d.llmReason ?? "无原因"}`);
    }
  }

  // 8. 打印保留条目的前10条
  const kept = store.getKeptNews(48, 10);
  console.log(`\n✅ 保留条目 TOP 10 (共 ${kept.length} 条):`);
  for (const k of kept) {
    const time = new Date(k.publishedAt).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const impLabel = k.importance === "high" ? "🔴" : k.importance === "medium" ? "🟡" : "⚪";
    console.log(`   ${impLabel} [${time}] [${k.source}] ${k.title || "(快讯)"}`);
    console.log(`      ${k.summary.slice(0, 100)}`);
  }

  console.log("\n=== 测试完成 ===");
}

main().catch(console.error);
