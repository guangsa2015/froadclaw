/**
 * 资讯后台定时刷新服务
 *
 * 职责：按 cron 表达式定时执行 "拉取 → 入库 → 攒批LLM筛选 → 清理"，
 * 仅做数据预热，不发送给用户。
 *
 * 与 finance_news 工具共享同一 news_cache 表，
 * 用户调用工具时直接查 kept 数据即可，响应更快。
 *
 * 启停状态和 cron 表达式持久化到 news_refresh_config 表，重启自动恢复。
 */
import cron from "node-cron";
import type { SessionStore } from "../../session/store/interface.js";
import type { Provider } from "../../llm/types.js";
import type { NewsSource } from "./types.js";
import { createClsSource } from "./cls/source-cls.js";
import { createEastmoneySource } from "./dfcf/source-eastmoney.js";
// import { createSinaSource } from "./sina/source-sina.js";  // 新浪源暂停使用，保留备用
import { createJin10Source } from "./jin10/source-jin10.js";
import { persistNewsItems } from "./news-store.js";
import { filterNewsByLlm } from "./news-filter-llm.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("news-refresh");

/** pending 累积到此数量时触发 LLM 筛选 */
const LLM_FILTER_THRESHOLD = 50;
/** 每次刷新每个渠道的拉取条数 */
const DEFAULT_FETCH_COUNT = 30;
/** 默认请求超时（ms） */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 旧数据清理阈值（小时） */
const CLEANUP_HOURS = 48;
/** LLM 筛选最大轮次 */
const MAX_FILTER_ROUNDS = 2;
/** LLM 单批筛选条数 */
const FILTER_BATCH_SIZE = 50;

/** 刷新服务配置 */
export interface NewsRefreshOptions {
  store: SessionStore;
  provider: Provider;
  filterModel: string;
  timeoutMs?: number;
  fetchCount?: number;
}

/** 刷新服务状态快照 */
export interface RefreshStatus {
  enabled: boolean;
  cronExpr: string;
  lastRefreshAt: string | null;
  isRefreshing: boolean;
}

export class NewsRefreshService {
  private sources: NewsSource[];
  private store: SessionStore;
  private provider: Provider;
  private filterModel: string;
  private timeoutMs: number;
  private fetchCount: number;
  private cronJob: cron.ScheduledTask | null = null;
  private currentCronExpr: string = "0 * * * *";
  private enabled: boolean = true;
  private refreshing = false;

  constructor(options: NewsRefreshOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.filterModel = options.filterModel;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchCount = options.fetchCount ?? DEFAULT_FETCH_COUNT;

    this.sources = [
      createClsSource(),
      createEastmoneySource(),
      // createSinaSource(),  // 新浪源暂停使用，保留备用
      createJin10Source(),
    ];
  }

  /** 启动定时刷新（从 DB 恢复配置） */
  start(): void {
    const config = this.store.getNewsRefreshConfig();
    this.enabled = config.enabled === 1;
    this.currentCronExpr = config.cronExpr;

    if (this.enabled) {
      this.scheduleCron(this.currentCronExpr);
      log.info({ cron: this.currentCronExpr }, "资讯定时刷新已启动: %s", this.currentCronExpr);
      // 启动时立即执行一次预热
      void this.refresh();
    } else {
      log.info("资讯定时刷新已暂停（DB配置 enabled=0）");
    }
  }

  /** 停止定时刷新 */
  stop(): void {
    this.cronJob?.stop();
    this.cronJob = null;
    this.enabled = false;
    this.store.updateNewsRefreshConfig({ enabled: 0 });
    log.info("资讯定时刷新已停止");
  }

  /** 恢复定时刷新 */
  resume(): void {
    this.enabled = true;
    this.store.updateNewsRefreshConfig({ enabled: 1 });
    this.scheduleCron(this.currentCronExpr);
    log.info({ cron: this.currentCronExpr }, "资讯定时刷新已恢复");
    // 恢复后立即执行一次
    void this.refresh();
  }

  /** 更新 cron 表达式 */
  updateCron(cronExpr: string): boolean {
    if (!cron.validate(cronExpr)) {
      log.warn({ cronExpr }, "无效的 cron 表达式");
      return false;
    }
    this.currentCronExpr = cronExpr;
    this.store.updateNewsRefreshConfig({ cronExpr });

    // 如果当前是启用状态，重新注册
    if (this.enabled) {
      this.scheduleCron(cronExpr);
    }
    log.info({ cronExpr }, "资讯刷新间隔已更新: %s", cronExpr);
    return true;
  }

  /** 获取当前状态 */
  getStatus(): RefreshStatus {
    const config = this.store.getNewsRefreshConfig();
    return {
      enabled: this.enabled,
      cronExpr: this.currentCronExpr,
      lastRefreshAt: config.lastRefreshAt,
      isRefreshing: this.refreshing,
    };
  }

  /** 销毁服务（系统关闭时调用） */
  destroy(): void {
    this.cronJob?.stop();
    this.cronJob = null;
    log.info("资讯刷新服务已销毁");
  }

  /** 执行一次完整刷新流程 */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      log.debug("上一轮刷新尚未完成，跳过本次");
      return;
    }
    this.refreshing = true;
    const startMs = Date.now();

    try {
      log.info("开始后台资讯刷新...");

      // ── 1. 并发拉取所有渠道 ──
      const fetchResults = await Promise.all(
        this.sources.map(async (src) => {
          try {
            return await src.fetch({ count: this.fetchCount, timeoutMs: this.timeoutMs });
          } catch (err) {
            log.warn({ source: src.id, err }, "渠道 %s 拉取失败", src.name);
            return [];
          }
        }),
      );
      const allItems = fetchResults.flat();
      log.info({ totalRaw: allItems.length }, "后台刷新: 汇聚 %d 条", allItems.length);

      // ── 2. 入库 + 跨源哈希去重 ──
      const inserted = persistNewsItems(this.store, allItems);

      // ── 3. 检查 pending 是否达到阈值，达到则触发 LLM 筛选 ──
      let totalFiltered = 0;
      const pendingCount = this.store.countPendingNews(CLEANUP_HOURS);
      if (pendingCount >= LLM_FILTER_THRESHOLD) {
        log.info({ pendingCount }, "pending 达到阈值 %d，触发 LLM 筛选", pendingCount);
        try {
          for (let round = 0; round < MAX_FILTER_ROUNDS; round++) {
            const processed = await filterNewsByLlm(
              { provider: this.provider, model: this.filterModel, store: this.store, batchSize: FILTER_BATCH_SIZE },
              CLEANUP_HOURS,
            );
            totalFiltered += processed;
            if (processed === 0) break;
          }
        } catch (err) {
          log.warn({ err }, "后台 LLM 筛选异常");
        }
      }

      // ── 4. 清理旧数据 ──
      const cleaned = this.store.cleanupOldNews(CLEANUP_HOURS);

      // 更新上次刷新时间
      this.store.updateNewsRefreshConfig({ lastRefreshAt: new Date().toISOString() });

      const elapsed = Date.now() - startMs;
      log.info(
        { inserted, pendingCount, filtered: totalFiltered, cleaned, elapsedMs: elapsed },
        "后台刷新完成: 新增%d, pending%d, 筛选%d, 清理%d, 耗时%dms",
        inserted, pendingCount, totalFiltered, cleaned, elapsed,
      );
    } catch (err) {
      log.error({ err }, "后台资讯刷新异常");
    } finally {
      this.refreshing = false;
    }
  }

  // ────── 内部方法 ──────

  private scheduleCron(cronExpr: string): void {
    // 先停掉旧的
    this.cronJob?.stop();
    this.cronJob = cron.schedule(cronExpr, () => {
      void this.refresh();
    }, { timezone: "Asia/Shanghai" });
    this.cronJob.start();
  }
}
