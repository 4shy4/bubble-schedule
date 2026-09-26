// 公历 → 农历（只做一件事：给定公历日期，说出它的农历月/日/闰月）。
//
// ⚠️ 为什么需要它：中国传统节日（春节/元宵/端午/七夕/中秋/重阳/腊八/小年…）都是**农历**日期，
//    要放进月历、要在气泡区按"还剩几天"浮动，就必须能把公历换算成农历。
//
// ⚠️ 数据来源（不是我凭记忆写的 —— 农历表一个 bit 错，某年的春节就会差一天）：
//    `solarlunar` 的 `const/lunarInfo.js`（1900-2100 的闰大小信息表），
//    那套表又源自 jjonline 的经典实现（公开通行几十年）。抓取日期 2026-09-25。
//    这里只取 **1900–2049**（150 项）：覆盖未来 20 多年足够了，再往后的年份返回 null，
//    调用方按"没有农历信息"处理，绝不猜。
//
// ⚠️ `tools/holidays.test.mjs` 用**一组已知的春节/中秋/端午日期**逐个核对 ——
//    这类表最怕"看着对、某一年差一天"，所以宁可多写几条断言。

/**
 * 农历 1900–2049 的闰大小信息表（每项一个 0x 数）：
 *   bit 0–3   ：闰月是哪个月（0 = 不闰）
 *   bit 4–15  ：1–12 月是大月（30 天）还是小月（29 天），最高位对应正月
 *   bit 16    ：闰月是大月（30 天）
 */
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
];

/** 这张表能算到哪一年（含）；超出去就返回 null，不猜 */
export const LUNAR_MAX_YEAR = 2049;
const MIN_YEAR = 1900;
/** 1900-01-31 是农历 1900 年正月初一（整张表的起点） */
const BASE_UTC = Date.UTC(1900, 0, 31);

const DAY_MS = 86_400_000;

function infoOf(y) {
  return LUNAR_INFO[y - MIN_YEAR];
}

/** 农历 y 年闰哪个月（0 = 不闰） */
export function leapMonth(y) {
  return infoOf(y) & 0xf;
}

/** 农历 y 年闰月的天数（0 = 那年没闰月） */
export function leapDays(y) {
  if (!leapMonth(y)) return 0;
  return (infoOf(y) & 0x10000) ? 30 : 29;
}

/** 农历 y 年 m 月（非闰）的天数 */
export function lunarMonthDays(y, m) {
  if (m < 1 || m > 12) return -1;
  return (infoOf(y) & (0x10000 >> m)) ? 30 : 29;
}

/** 农历 y 年一共多少天（含闰月） */
export function lunarYearDays(y) {
  let sum = 348;                      // 12 个月 × 29 天
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    if (infoOf(y) & i) sum += 1;
  }
  return sum + leapDays(y);
}

/**
 * 公历 → 农历。
 *
 * @returns {null | {year:number, month:number, day:number, isLeap:boolean}}
 *          `year` = 农历年；超出 1900–2049 或日期非法 → **null**
 */
export function solarToLunar(y, m, d) {
  const Y = Number(y);
  const M = Number(m);
  const D = Number(d);
  if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
  if (Y < MIN_YEAR || Y > LUNAR_MAX_YEAR || M < 1 || M > 12 || D < 1 || D > 31) return null;

  let offset = (Date.UTC(Y, M - 1, D) - BASE_UTC) / DAY_MS;
  if (!Number.isFinite(offset) || offset < 0) return null;

  // 先减掉整年
  let i;
  let temp = 0;
  for (i = MIN_YEAR; i <= LUNAR_MAX_YEAR && offset > 0; i += 1) {
    temp = lunarYearDays(i);
    offset -= temp;
  }
  if (offset < 0) { offset += temp; i -= 1; }
  const year = i;

  // 再减掉整月（⚠️ 闰月那一段的逻辑要照原实现，不能"简化"）
  const leap = leapMonth(year);
  let isLeap = false;
  for (i = 1; i < 13 && offset > 0; i += 1) {
    if (leap > 0 && i === leap + 1 && isLeap === false) {
      i -= 1;
      isLeap = true;
      temp = leapDays(year);
    } else {
      temp = lunarMonthDays(year, i);
    }
    if (isLeap === true && i === leap + 1) isLeap = false;
    offset -= temp;
  }
  // 正好落在闰月开头那天
  if (offset === 0 && leap > 0 && i === leap + 1) {
    if (isLeap) { isLeap = false; } else { isLeap = true; i -= 1; }
  }
  if (offset < 0) { offset += temp; i -= 1; }

  return { year, month: i, day: offset + 1, isLeap };
}

/**
 * 农历 → 公历（"某年正月初一是哪天"）。
 * 用来把农历节日铺成一串年份里的公历日期。
 *
 * @returns {null | {y:number, m:number, d:number}}
 */
export function lunarToSolar(ly, lm, ld, isLeapMonth = false) {
  const Y = Number(ly);
  const M = Number(lm);
  const D = Number(ld);
  if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
  if (Y < MIN_YEAR || Y > LUNAR_MAX_YEAR || M < 1 || M > 12 || D < 1 || D > 30) return null;
  const leap = leapMonth(Y);
  if (isLeapMonth && leap !== M) return null;      // 那年这个月不闰
  if (D > lunarMonthDays(Y, M)) return null;

  // 从正月初一往后数天数偏移
  let offset = 0;
  for (let y = MIN_YEAR; y < Y; y += 1) offset += lunarYearDays(y);
  for (let m = 1; m < M; m += 1) {
    offset += lunarMonthDays(Y, m);
    if (leap === m) offset += leapDays(Y);         // 闰月在它后面
  }
  if (isLeapMonth) offset += lunarMonthDays(Y, M); // 闰月本身排在正常月之后
  offset += D - 1;

  const t = BASE_UTC + offset * DAY_MS;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 农历月/日的汉字说法（"正月初一" / "八月十五"），备注和气泡文字要用 */
const MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const DAY_NAMES_1 = ['初', '十', '廿', '卅'];
const DAY_NAMES_2 = ['十', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function lunarDayName(day) {
  const n = Number(day);
  if (!Number.isFinite(n) || n < 1 || n > 30) return '';
  if (n === 10) return '初十';
  if (n === 20) return '二十';
  if (n === 30) return '三十';
  return DAY_NAMES_1[Math.floor(n / 10)] + DAY_NAMES_2[n % 10];
}

export function lunarMonthName(month, isLeap = false) {
  const n = Number(month);
  if (!Number.isFinite(n) || n < 1 || n > 12) return '';
  return (isLeap ? '闰' : '') + MONTH_NAMES[n - 1] + '月';
}

/** 「八月十五」这样一整句（节日表里用得着，也方便测试断言之类） */
export function lunarDateName(month, day, isLeap = false) {
  return lunarMonthName(month, isLeap) + lunarDayName(day);
}
