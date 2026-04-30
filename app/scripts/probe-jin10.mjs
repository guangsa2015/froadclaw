/**
 * 探测金十数据 API 接口
 *
 * 金十数据有两个核心板块：
 * 1. 7x24 快讯流
 * 2. 财经日历（经济数据发布时间表）
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

// ═══════════════════════════════════
// 1. 快讯流 API 探测
// ═══════════════════════════════════

async function probeFlash() {
  console.log("=== 1. 金十快讯流 API 探测 ===\n");

  // 已知的几个可能的快讯接口
  const endpoints = [
    // 快讯列表
    { name: "flash_list_v1", url: "https://flash-api.jin10.com/get_flash_list" },
    { name: "flash_list_v2", url: "https://reference-api.jin10.com/flash/get_flash_list" },
    // 可能带参数
    { name: "flash_list_params", url: "https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=0&max_time=&t=" + Date.now() },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep.url, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
          "Referer": "https://www.jin10.com/",
          "Origin": "https://www.jin10.com",
          "x-app-id": "bVBF4FyRTn5NJF5n",
          "x-version": "1.0.0",
        },
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[${ep.name}] status=${resp.status} content-type=${resp.headers.get("content-type")}`);
      if (resp.ok) {
        const text = await resp.text();
        // 只打印前 2000 字符
        console.log(text.slice(0, 2000));
        console.log("...(截断)\n");
      }
    } catch (err) {
      console.log(`[${ep.name}] ERROR: ${err.message}\n`);
    }
  }
}

// ═══════════════════════════════════
// 2. 财经日历 API 探测
// ═══════════════════════════════════

async function probeCalendar() {
  console.log("\n=== 2. 金十财经日历 API 探测 ===\n");

  const today = new Date().toISOString().slice(0, 10); // "2026-03-26"

  const endpoints = [
    // 财经日历
    { name: "calendar_v1", url: `https://cdn-rili.jin10.com/web_data/${today.replace(/-/g, "")}/economics.json` },
    { name: "calendar_v2", url: `https://rili-api.jin10.com/get_calendar_list?date=${today}` },
    { name: "calendar_v3", url: `https://cdn-rili.jin10.com/data/ALL/${today.replace(/-/g, "")}.json` },
    // 大事预告
    { name: "calendar_event", url: `https://cdn-rili.jin10.com/web_data/${today.replace(/-/g, "")}/event.json` },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep.url, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
          "Referer": "https://rili.jin10.com/",
        },
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[${ep.name}] status=${resp.status}`);
      if (resp.ok) {
        const text = await resp.text();
        console.log(text.slice(0, 3000));
        console.log("...(截断)\n");
      }
    } catch (err) {
      console.log(`[${ep.name}] ERROR: ${err.message}\n`);
    }
  }
}

// ═══════════════════════════════════
// 3. 主站页面 API 探测（从 Network 常见路径）
// ═══════════════════════════════════

async function probeMainSite() {
  console.log("\n=== 3. 金十主站 API 探测 ===\n");

  const endpoints = [
    { name: "flash_latest", url: "https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=0" },
    { name: "flash_channel_8201", url: "https://flash-api.jin10.com/get_flash_list?channel=-8201&vip=0" },
    { name: "flash_imp", url: "https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1" },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep.url, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
          "Referer": "https://www.jin10.com/",
          "Origin": "https://www.jin10.com",
          "x-app-id": "bVBF4FyRTn5NJF5n",
          "x-version": "1.0.0",
        },
        signal: AbortSignal.timeout(10000),
      });
      console.log(`[${ep.name}] status=${resp.status}`);
      if (resp.ok) {
        const text = await resp.text();
        console.log(text.slice(0, 2000));
        console.log("...(截断)\n");
      }
    } catch (err) {
      console.log(`[${ep.name}] ERROR: ${err.message}\n`);
    }
  }
}

async function main() {
  await probeFlash();
  await probeCalendar();
  await probeMainSite();
}

main().catch(console.error);
