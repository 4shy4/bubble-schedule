// 颜色等级（事情多大）+ 套娃层级 + 通知强度。
//
// v0.4 起两个视觉通道分工彻底分开：
//   **颜色 = 事情多大**（用户手选，四档固定顺序）
//   **大小 = 还剩多久**（自动，见 countdown.js）
//
// 套娃规则（用户口述）：进入"红色气泡"后，里面只能有黄/绿/蓝；
// 黄色里只能有绿/蓝；绿色里只能有蓝；蓝色双击只抖一下，进不去。
// 也就是**元素框的等级必须严于父容器**：红(3) > 黄(2) > 绿(1) > 蓝(0)。

import { TIME_BANDS, bandForRemaining } from './countdown.js';

/** 四档颜色与等级，rank 越大 = 事情越大 = 颜色越"重" */
export const LEVELS = [
  { key: 'sky', rank: 0, label: '小', color: '#38bdf8', colorName: '天蓝' },
  { key: 'emerald', rank: 1, label: '中', color: '#22c55e', colorName: '翠绿' },
  { key: 'amber', rank: 2, label: '大', color: '#f5b301', colorName: '黄' },
  { key: 'red', rank: 3, label: '重大', color: '#ef4444', colorName: '红' },
];

export const DEFAULT_LEVEL = 'sky';

const BY_KEY = new Map(LEVELS.map((l) => [l.key, l]));

export function levelByKey(key) {
  return BY_KEY.get(key) || BY_KEY.get(DEFAULT_LEVEL);
}

/** 等级序号：蓝 0 / 绿 1 / 黄 2 / 红 3 */
export function rankOf(key) {
  return levelByKey(key).rank;
}

/** 能不能把 `childKey` 放进 `parentKey` 里？必须**严于**父容器 */
export function canNestInside(parentKey, childKey) {
  return rankOf(childKey) < rankOf(parentKey);
}

/** 某个容器里允许出现哪些等级（用于编辑器里禁用不可选的颜色） */
export function allowedChildLevels(parentKey) {
  const p = rankOf(parentKey);
  return LEVELS.filter((l) => l.rank < p);
}

/** 是否为叶子等级（蓝色双击进不去） */
export function isLeafLevel(key) {
  return rankOf(key) === 0;
}

/**
 * 旧数据迁移：把老字段换算成等级。
 * 老版本 magnitude(1–100) 或 importance(1–5) 表示的其实也是"事情多大"，
 * 所以按区间映射成四档，信息不丢：
 *   ≥80 → 红   ／ 60–79 → 黄 ／ 40–59 → 绿 ／ <40 → 蓝
 *   importance 1–5 → 1 蓝 2 蓝 3 绿 4 黄 5 红
 */
export function levelFromLegacyMagnitude(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEVEL;
  if (n <= 5) {
    if (n >= 5) return 'red';
    if (n >= 4) return 'amber';
    if (n >= 3) return 'emerald';
    return 'sky';
  }
  if (n >= 80) return 'red';
  if (n >= 60) return 'amber';
  if (n >= 40) return 'emerald';
  return 'sky';
}

// ---------------------------------------------------------------------------
// 通知强度：改按**剩余时间档位**算（颜色已经不代表紧急度了）
// ---------------------------------------------------------------------------

/**
 * 剩余时间档位 → 强度 1–4。
 * 越接近截止越强，和"气泡越来越大"是同一个信号，语义一致。
 *
 * 时间还早（周/月/年）→ 1：只需准点提醒，别打扰；
 * 进入"日"→ 2；进入"小时"→ 3；进入"分/秒"→ 4（必看 + 闹铃）。
 */
export const BAND_INTENSITY = {
  year: 1,
  month: 1,
  week: 1,
  day: 2,
  hour: 3,
  minute: 4,
  second: 4,
};

/** 剩余时间档位 → 提醒提前量（分钟）。负值 = 截止之后追问。 */
export const BAND_REMINDER_PLAN = {
  year: [10, 0],
  month: [10, 0],
  week: [30, 0],
  day: [60, 30, 10, 0],
  hour: [60, 30, 10, 0, -5],
  minute: [30, 10, 0, -5, -15],
  second: [10, 0, -5, -15, -25],
};

export function intensityForBand(bandKey) {
  return BAND_INTENSITY[bandKey] || 1;
}

export function reminderPlanForBand(bandKey) {
  const plan = BAND_REMINDER_PLAN[bandKey] || BAND_REMINDER_PLAN.year;
  return [...new Set(plan)].sort((a, b) => b - a);
}

/**
 * 剩余时间（毫秒） → 该用多强的提醒。
 * @returns {{band:string, intensity:number, plan:number[], overdue:boolean}}
 */
export function notificationPlanForRemaining(remainingMs) {
  const overdue = !(remainingMs > 0);
  const band = bandForRemaining(remainingMs).key;
  return {
    band,
    intensity: overdue ? 4 : intensityForBand(band),
    plan: overdue ? BAND_REMINDER_PLAN.minute : reminderPlanForBand(band),
    overdue,
  };
}

/** 弹窗强度表：停留时长、是否必看、是否发声、重复次数、音量 */
export const NOTIFY_INTENSITY = {
  1: { durationMs: 5000, requireInteraction: false, sound: true, repeats: 0, volume: 0.06 },
  2: { durationMs: 8000, requireInteraction: false, sound: true, repeats: 0, volume: 0.12 },
  3: { durationMs: 12000, requireInteraction: false, sound: true, repeats: 1, volume: 0.2 },
  4: { durationMs: 20000, requireInteraction: true, sound: true, repeats: 3, volume: 0.3 },
};

/** 强度夹到 1–4（非法值给 1，不要因为一个坏值把提醒弄哑） */
export function clampIntensity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(1, Math.round(n)));
}

/**
 * 把「用户设置」和「按剩余时间自动算出的强度」合成最终强度。
 *
 * 为什么两者都要（用户报"提醒力度不够大"）：
 *   强度原本是**按剩余时间自动算**的（越临近截止越强，见 intensityForBand）。
 *   这个规则合理，但它意味着"下周的课"永远只有最弱那档 —— 用户觉得不够，
 *   却没有任何旋钮可以调。所以加一个设置：
 *
 *     'auto'（默认）→ 用自动算出来的
 *     1 / 2 / 3 / 4  → **强制**用这一档（"我就是想让所有提醒都很响"）
 *
 *   非法值一律退回 auto —— 宁可回到默认行为，也不要因为设置里一个脏值
 *   让所有提醒变成最弱档（那种故障几乎不可能被联想到是设置问题）。
 *
 * @param {'auto'|number|string} setting settings.notify.intensity
 * @param {number} autoIntensity 按剩余时间算出的强度（1–4）
 */
export function resolveIntensity(setting, autoIntensity) {
  const auto = clampIntensity(autoIntensity);
  if (setting === 'auto' || setting === '' || setting === null || setting === undefined) return auto;
  const n = Number(setting);
  if (!Number.isFinite(n)) return auto;
  return clampIntensity(n);
}

export function notifyStyleForIntensity(level) {
  const i = Math.min(4, Math.max(1, Math.round(Number(level) || 1)));
  return { ...NOTIFY_INTENSITY[i], intensity: i };
}

/** 给界面/自检用的一张总表：档位 → 尺寸区间 + 通知强度（按"最不紧迫 → 最紧迫"排列） */
export function bandOverview() {
  return TIME_BANDS.map((b) => ({
    band: b.key,
    label: b.label,
    sizeLo: b.lo,
    sizeHi: b.hi,
    intensity: intensityForBand(b.key),
    reminders: reminderPlanForBand(b.key),
    notify: notifyStyleForIntensity(intensityForBand(b.key)),
  }));
}
