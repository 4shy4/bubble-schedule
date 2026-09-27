// 颜色等级（事情多大）+ 套娃层级 + 通知强度。
//
// v0.4 起两个视觉通道分工彻底分开：
//   **颜色 = 事情多大**（用户手选，四档固定顺序）
//   **大小 = 还剩多久**（自动，见 countdown.js）
//
// 套娃规则（用户口述）：进入"红色气泡"后，里面只能有黄/绿/蓝；
// 黄色里只能有绿/蓝；绿色里只能有蓝；蓝色双击只抖一下，进不去。
// 也就是**元素框的等级必须严于父容器**：红(3) > 黄(2) > 绿(1) > 蓝(0)。

import { TIME_BANDS, bandForRemaining, UNSET_BAND } from './countdown.js';

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
  /**
   * 「未设期限」（`core/countdown.js` 的 `UNSET_BAND`）→ **1 = 不催**。
   *
   * 为什么是 1，而不是"和秒档一样 4"：
   *   强度表表达的是"越接近截止越该打扰"，而"没期限"根本没有截止时刻，
   *   这条规则对它无从谈起 —— 它只能是中性的那一个值。
   *
   * 为什么要有**显式**一条、而不是靠下面 `|| 1` 的兜底：三处口径必须写在一起看得见，
   * 免得哪天有人把兜底改成"往最高档倒"（那种故障用户只会觉得"App 乱响"）：
   *   · 这里 → 1
   *   · `core/urgency.js` 的 `bubbleStyle()`：`remaining == null` → 强度硬写 1
   *   · `core/state-ops.js` 的 `bandForEvent()`：没期限 → `intensity: 1`
   */
  unset: 1,
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

/**
 * 档位键 → 通知强度 1–4。
 *
 * ⚠️ 认不出来的键（脏数据给的野档位名）一律兜底成 **1（不催）**。
 *    强度是"打扰用户"的许可：宁可少响一次，也别因为一个不认识的键把提醒拉到必看+闹铃那一档。
 *    （"未设期限"在表里有自己的一条 1，不走这个兜底。）
 */
export function intensityForBand(bandKey) {
  return BAND_INTENSITY[bandKey] || 1;
}

export function reminderPlanForBand(bandKey) {
  // ⚠️ 「未设期限」不在这张表里 → 落到 year 档那份最不打扰的 [10, 0]。
  //    真实提醒不走这里：core/state-ops.js 的 effectiveReminders() 对"没期限"**直接返回 [0]**
  //    （只准点提醒一次）。这条兜底只是保证任何查表的调用方都有一个明确的、不催的答案，
  //    而不是 undefined（undefined 展开就抛）。
  const plan = BAND_REMINDER_PLAN[bandKey] || BAND_REMINDER_PLAN.year;
  return [...new Set(plan)].sort((a, b) => b - a);
}

/**
 * 剩余时间（毫秒） → 该用多强的提醒。
 * @returns {{band:string, intensity:number, plan:number[], overdue:boolean}}
 */
export function notificationPlanForRemaining(remainingMs) {
  /**
   * ⚠️ 「没设期限」（null / undefined）→ **中性**：不催，只准点提醒一次。
   *
   * 这一支是必须的，别删。以前 null 会掉进下面的 `!(null > 0)` → 被当成**已过期**：
   * 强度 4 + "截止后追问"的计划。而**真正会响**的那份计划来自
   * `core/state-ops.js` 的 `effectiveReminders()` —— 它对没期限的事件返回 `[0]`。
   * 两者矛盾，表现就是编辑器里那句「**马上到期** · 强度 4」紧挨着"没有截止时间"
   * （同一屏自相矛盾）。现在两处口径一致：档位 'unset'、强度 1、计划 `[0]`、不算过期。
   *
   * 这么改**不会动到真正的通知行为**（已逐条核过调用方）：
   *   · `core/notify-plan.js` 排未来提醒时喂进来的是 `anchor - fireAt`（有限数），永远不是 null
   *   · `core/state-ops.js` 的 `effectiveReminders()` / `bandForEvent()` 在到达这里之前就把 null 挡住了
   *   · `web/adapter/reminder.js`、`web/adapter/native.js` 传的也是有限数
   *   唯一真的会传 null 的是编辑器的提醒预览（只显示，不排提醒），它现在说的才是真话。
   */
  if (remainingMs == null) {
    return { band: UNSET_BAND.key, intensity: 1, plan: [0], overdue: false };
  }
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

/**
 * 给界面/自检用的一张总表：档位 → 尺寸区间 + 通知强度（按"最不紧迫 → 最紧迫"排列）。
 *
 * ⚠️ 只有**七档**（`TIME_BANDS`）。「未设期限」故意不进来：
 *    它没有尺寸区间（走 `NEUTRAL_SIZE`）、也不在紧迫度刻度上，混进来会让
 *    "七档"这张表变成八行，读表的人分不清哪一档是真的时间刻度。
 *    它自己的中性值在 `BAND_INTENSITY.unset`（1）和 `UNSET_BAND`（'unset'/'未设期限'）里。
 */
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
