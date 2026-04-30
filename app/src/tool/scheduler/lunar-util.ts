/**
 * 农历工具 — 基于 lunar-javascript 库
 * 提供农历↔公历转换、下一个农历日期计算等功能
 */
import { Solar } from "lunar-javascript";

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeapMonth: boolean;
}

/** 获取今天的农历日期 */
export function getTodayLunar(): LunarDate {
  const solar = Solar.fromDate(new Date());
  const lunar = solar.getLunar();
  return {
    year: lunar.getYear(),
    month: lunar.getMonth(),
    day: lunar.getDay(),
    isLeapMonth: false,
  };
}

/** 检查今天是否是指定的农历月日 */
export function isTodayLunar(lunarMonth: number, lunarDay: number): boolean {
  const today = getTodayLunar();
  return today.month === lunarMonth && today.day === lunarDay;
}

/**
 * 计算下一次指定农历月日对应的公历日期（ISO8601）
 * 从明天开始搜索，最多搜未来 400 天
 */
export function nextLunarDate(lunarMonth: number, lunarDay: number): string | null {
  const now = new Date();
  for (let offset = 0; offset <= 400; offset++) {
    const date = new Date(now.getTime() + offset * 86400_000);
    const solar = Solar.fromDate(date);
    const lunar = solar.getLunar();
    if (lunar.getMonth() === lunarMonth && lunar.getDay() === lunarDay) {
      return date.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
  }
  return null;
}

/** 把农历月日转成可读文本 */
export function lunarDateText(month: number, day: number): string {
  const monthNames = ["", "正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
  const dayNames = [
    "", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
    "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
    "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
  ];
  return `农历${monthNames[month] ?? month}月${dayNames[day] ?? day}`;
}
