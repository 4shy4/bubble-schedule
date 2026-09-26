// 时间工具。所有日期都以「本地墙上时间」为准，不带时区后缀。
export const DAY_MS = 86_400_000;
export const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const WEEK_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

export function pad(n) { return String(n).padStart(2, '0'); }

/** Date -> "2026-03-02" */
export function toDateKey(d) {
  const x = asDate(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** Date -> "2026-03-02T08:00:00"（本地时间） */
export function toLocalStamp(d) {
  const x = asDate(d);
  return `${toDateKey(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}:00`;
}

export function asDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    // 兼容 "2026-03-02" 与 "2026-03-02T08:00"
    return new Date(v.length === 10 ? `${v}T00:00:00` : v);
  }
  return new Date(v);
}

export function startOfDay(d) {
  const x = asDate(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

export function addDays(d, n) {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addMonths(d, n) {
  const x = asDate(d);
  return new Date(x.getFullYear(), x.getMonth() + n, 1);
}

/** 周一为一周之始 */
export function mondayOf(d) {
  const x = startOfDay(d);
  const dow = x.getDay();
  x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow));
  return x;
}

export function weekDates(anyDayInWeek) {
  const m = mondayOf(anyDayInWeek);
  return Array.from({ length: 7 }, (_, i) => addDays(m, i));
}

export function isSameDay(a, b) { return toDateKey(a) === toDateKey(b); }

export function isToday(d) { return isSameDay(d, new Date()); }

export function hhmm(d) {
  const x = asDate(d);
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

export function minutesOfDay(d) {
  const x = asDate(d);
  return x.getHours() * 60 + x.getMinutes();
}

/** 相对日期描述：今天 / 明天 / 周三 / 3月5日 */
/**
 * 「今天 / 明天 / 后天 / 周四 / 9月24日」。
 *
 * ⚠️ `today` 参数是**为了能钉住时间**（默认还是真实时钟，老调用方不受影响）。
 *    踩过的坑：core/share-plan.js 用 `opts.now` 算窗口，表头却调这里的默认真实时钟 ——
 *    于是 `buildSharePlan(events, { now: 某个固定时刻 })` 出来的表头**和窗口不一致**，
 *    对应的单测也只能"碰运气通过"（真实日期一走远就红）。
 *    凡是"算一段时间的文本"，都必须把同一个 now 传到底。
 */
export function friendlyDay(d, today = new Date()) {
  const x = startOfDay(d);
  const t0 = startOfDay(today);
  const diff = Math.round((x - t0) / DAY_MS);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  if (diff > 2 && diff < 7) return WEEK_CN[x.getDay()];
  return `${x.getMonth() + 1}月${x.getDate()}日`;
}

export function monthTitle(d) {
  const x = asDate(d);
  return `${x.getFullYear()} 年 ${x.getMonth() + 1} 月`;
}

/** 学期第几周（1 起）。termStart 为空时返回 null */
export function weekOfTerm(day, termStart) {
  if (!termStart) return null;
  const m = mondayOf(asDate(termStart));
  const target = mondayOf(day);
  return Math.floor((target - m) / (7 * DAY_MS)) + 1;
}

/** 从 a 到 b 的整天数（b - a） */
export function dayDiff(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
}

/**
 * 反推：已知「本周是第 N 周」，求出学期第一周的周一。
 *
 * 为什么要反推（这是用户报的问题）：
 *   应用**无法自己知道**第一周是哪天，只能让用户填。而"第一周的周一"这个日期
 *   很多人记不住 —— 但"今天第几周了"几乎人人都知道。
 *   所以让用户填第几周、由它反推日期，比让他去翻教务系统容易得多。
 *
 *   termStart = 本周一 − (N − 1) 周
 *
 * ⚠️ 与 `weekOfTerm` 互为逆运算：`weekOfTerm(day, termStartFromWeek(day, n)) === n`。
 *    测试就是用这个往返关系钉住它的（"差一周"这种错最容易悄悄发生）。
 *
 * @returns {Date|null} 周次非法时返回 null
 */
export function termStartFromWeek(day, week) {
  const n = Number(week);
  if (!Number.isFinite(n) || n < 1) return null;
  return addDays(mondayOf(day), -(Math.floor(n) - 1) * 7);
}

export function relativeTime(from, now = new Date()) {
  const diff = asDate(from) - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const suffix = diff >= 0 ? '后' : '前';
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟${suffix}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时${suffix}`;
  return `${Math.floor(hours / 24)} 天${suffix}`;
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
