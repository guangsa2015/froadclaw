/**
 * 临时脚本：清理 news_cache 中东方财富重复标题数据
 */
import initSqlJs from "sql.js";
import { readFileSync, writeFileSync } from "node:fs";

const SQL = await initSqlJs();
const buf = readFileSync("data/froadclaw.db");
const db = new SQL.Database(buf);

// 1. 查看当前重复情况
console.log("=== 清理前：东方财富重复标题 ===");
const dupBefore = db.exec(`
  SELECT title, count(*) as cnt
  FROM news_cache
  WHERE source = 'dfcf' AND title != ''
  GROUP BY title
  HAVING cnt > 1
  ORDER BY cnt DESC
`);
if (dupBefore.length > 0 && dupBefore[0]) {
  for (const row of dupBefore[0].values) {
    console.log(`  ${row[1]}x | ${row[0]}`);
  }
} else {
  console.log("  (无重复标题，已经干净)");
  db.close();
  process.exit(0);
}

// 2. 删除重复条目：每个标题只保留 id 最小（最早入库）的记录
const deleted = db.exec(`
  SELECT count(*) FROM news_cache
  WHERE source = 'dfcf' AND title != '' AND id NOT IN (
    SELECT min(id) FROM news_cache
    WHERE source = 'dfcf' AND title != ''
    GROUP BY title
  ) AND title IN (
    SELECT title FROM news_cache WHERE source = 'dfcf' AND title != ''
    GROUP BY title HAVING count(*) > 1
  )
`);
const toDelete = deleted[0]?.values[0]?.[0] ?? 0;
console.log(`\n将删除 ${toDelete} 条重复记录...`);

db.run(`
  DELETE FROM news_cache
  WHERE source = 'dfcf' AND title != '' AND id NOT IN (
    SELECT min(id) FROM news_cache
    WHERE source = 'dfcf' AND title != ''
    GROUP BY title
  ) AND title IN (
    SELECT title FROM news_cache WHERE source = 'dfcf' AND title != ''
    GROUP BY title HAVING count(*) > 1
  )
`);

// 3. 验证
console.log("\n=== 清理后：东方财富重复标题 ===");
const dupAfter = db.exec(`
  SELECT title, count(*) as cnt
  FROM news_cache
  WHERE source = 'dfcf' AND title != ''
  GROUP BY title
  HAVING cnt > 1
`);
if (dupAfter.length > 0 && dupAfter[0]) {
  for (const row of dupAfter[0].values) {
    console.log(`  ${row[1]}x | ${row[0]}`);
  }
} else {
  console.log("  ✅ 已无重复");
}

// 4. 统计
const stats = db.exec(`
  SELECT count(*) as total, count(DISTINCT title) as unique_titles
  FROM news_cache WHERE source = 'dfcf'
`);
if (stats.length > 0 && stats[0]) {
  const [total, uniqueTitles] = stats[0].values[0]!;
  console.log(`\n清理后总条数: ${total}, 唯一标题: ${uniqueTitles}`);
}

// 5. 持久化
const data = db.export();
writeFileSync("data/froadclaw.db", Buffer.from(data));
console.log("✅ 数据库已保存");
db.close();
