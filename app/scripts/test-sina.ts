/**
 * 临时脚本：三源拉取 → 入库 → 查看结果
 */
import { createClsSource } from "../src/tool/finance-news/cls/source-cls.js";
import { createEastmoneySource } from "../src/tool/finance-news/dfcf/source-eastmoney.js";
import { createSinaSource } from "../src/tool/finance-news/sina/source-sina.js";
import { persistNewsItems } from "../src/tool/finance-news/news-store.js";
import { SqliteSessionStore } from "../src/session/store/sqlite.js";

const DB_PATH = "data/froadclaw.db";
const FETCH_COUNT = 15;

// 1. 初始化数据库
const store = await SqliteSessionStore.create(DB_PATH);
console.log("✅ 数据库已连接\n");

// 2. 并发拉取三源
const sources = [createClsSource(), createEastmoneySource(), createSinaSource()];
const results = await Promise.all(
  sources.map(async (src) => {
    const items = await src.fetch({ count: FETCH_COUNT });
    console.log(`📡 ${src.name}(${src.id}): 拉取到 ${items.length} 条`);
    return { source: src, items };
  }),
);

// 3. 合并入库
const allItems = results.flatMap((r) => r.items);
console.log(`\n📦 合计 ${allItems.length} 条，开始入库...`);

const inserted = persistNewsItems(store, allItems);
console.log(`✅ 新增 ${inserted} 条（已存在的自动跳过）\n`);

// 4. 查看各源在库中的统计
const db = store.getDatabase();
const stats = db.exec(`
  SELECT source, count(*) as cnt,
    sum(CASE WHEN llm_status='pending' THEN 1 ELSE 0 END) as pending,
    sum(CASE WHEN llm_status='duplicate' THEN 1 ELSE 0 END) as dup,
    sum(CASE WHEN llm_status='kept' THEN 1 ELSE 0 END) as kept
  FROM news_cache
  GROUP BY source
  ORDER BY source
`);
if (stats.length > 0 && stats[0]) {
  console.log("=== news_cache 各源统计 ===");
  console.log("  source | total | pending | duplicate | kept");
  for (const row of stats[0].values) {
    console.log(`  ${row[0]}     | ${row[1]}     | ${row[2]}       | ${row[3]}         | ${row[4]}`);
  }
}

// 5. 打印新浪最新入库的 5 条
const sinaRows = db.exec(`
  SELECT title, summary, importance, tags, published_at
  FROM news_cache
  WHERE source = 'sina'
  ORDER BY published_at DESC
  LIMIT 5
`);
if (sinaRows.length > 0 && sinaRows[0]) {
  console.log("\n=== 新浪最新 5 条入库记录 ===");
  for (const row of sinaRows[0].values) {
    const title = row[0] || "(快讯)";
    const summary = String(row[1]).slice(0, 80);
    console.log(`  [${row[2]}] ${row[4]} | ${title}`);
    console.log(`    ${summary}...`);
  }
}

// 6. 持久化
store.close();
console.log("\n✅ 数据库已保存并关闭");
