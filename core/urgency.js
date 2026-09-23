// 气泡外观：把「还剩多久」和「事情多大」合成一个气泡要用的全部参数。
//
// v0.4 起两个通道彻底分开（见 docs/COUNTDOWN.md 与 docs/BUBBLE-DESIGN.md）：
//   **大小 ← 还剩多久**（core/countdown.js，连续曲线，自动）
//   **颜色 ← 事情多大**（core/level.js，四档，手选）
//   **通知强度 ← 还剩多久**（core/level.js 的 BAND_INTENSITY，自动）
//
// 老代码里 `magnitude`（1–100 的"事情多大"）已经被四档颜色取代，
// 但 `radiusForMagnitude` 之类的旧导出还留着，避免外部引用直接炸。
import { DAY_MS } from './time.js';
import * as stateOps from './state-ops.js';
import {
  URGENCY_TIERS, tierForHours, tierByKey, radiusForMagnitude, migrateImportance, hexToRgba,
} from './palette.js';
import {
  sizeRatioForRemaining, bandForRemaining, formatRemaining, NEUTRAL_SIZE, OVERDUE_SIZE,
  MINUTE_MS, HOUR_MS, WEEK_MS,
} from './countdown.js';
import {
  levelByKey, DEFAULT_LEVEL, levelFromLegacyMagnitude, intensityForBand,
  notifyStyleForIntensity, reminderPlanForBand,
} from './level.js';

// ---------------------------------------------------------------------------
// 连续紧迫度（保留）：只用于排序，不再决定气泡大小
// ---------------------------------------------------------------------------
export const URGENT_WINDOW_HOURS = 72;
export const NEAR_DECAY = 1.9;
export const FAR_DECAY = 0.11;
export const SCORE_FLOOR = 0.01;
export const SCORE_AT_WINDOW = 0.8 * Math.exp(-NEAR_DECAY);

/** 剩余小时数 → 0–1 的紧迫度（排序用） */
export function urgencyOf(start, now = new Date()) {
  const hours = (new Date(start).getTime() - now.getTime()) / 3_600_000;

  let score;
  if (hours <= 0) {
    score = 0.95;
  } else if (hours <= 1) {
    score = 0.8 + 0.19 * (1 - hours);
  } else if (hours <= URGENT_WINDOW_HOURS) {
    const t = (hours - 1) / (URGENT_WINDOW_HOURS - 1);
    score = 0.8 * Math.exp(-NEAR_DECAY * t);
  } else {
    score = Math.max(SCORE_FLOOR, SCORE_AT_WINDOW * Math.exp(-FAR_DECAY * ((hours - URGENT_WINDOW_HOURS) / 24)));
  }

  score = Math.min(1, Math.max(0, score));
  return { score, hours };
}

/** 剩余小时 → 人话（列表/详情里还在用） */
export function describeTimeLeft(hours) {
  if (hours <= -24) return `${Math.floor(-hours / 24)} 天前`;
  if (hours < 0) return `${Math.max(1, Math.round(-hours))} 小时前已过`;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟后`;
  if (hours < 24) return `${Math.round(hours)} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

// ---------------------------------------------------------------------------
// 事件的"截止时刻"与"还剩多久"
// ---------------------------------------------------------------------------

/**
 * 截止时刻（毫秒）。
 * 优先级：`deadline`（真正的期限）> `end` > `start`。
 * 需要一个"没有期限"的表达时，用 `hasDeadline()` 判断，不要靠 0。
 *
 * ⚠️ 这里**转调** core/state-ops.js 的唯一实现（方案 C：到期 = 这件事结束了）。
 *    自己留一份是历史遗留，曾导致"自己变紫按 start、容器变紫按 end"。
 */
export function deadlineMsOf(event) {
  return stateOps.deadlineMsOf(event);
}

export function remainingMsOf(event, now = new Date()) {
  const d = deadlineMsOf(event);
  if (d == null) return null;
  return d - now.getTime();
}

/** 事件等级（颜色）：显式 level > 旧 tier > 旧 magnitude/importance > 默认 */
export function levelOf(event) {
  if (event && event.level) return levelByKey(event.level).key;
  if (event && event.tier) return levelByKey(event.tier).key;
  if (event && event.magnitude != null) return levelFromLegacyMagnitude(event.magnitude);
  if (event && event.importance != null) return levelFromLegacyMagnitude(event.importance);
  return DEFAULT_LEVEL;
}

// ---------------------------------------------------------------------------
// 合成气泡样式
// ---------------------------------------------------------------------------

/**
 * @param {{event:object,start:Date,end:Date,deadline?:Date}} item
 * @param {{
 *   now?:Date, minRadius?:number, maxRadius?:number, fuzzy?:boolean,
 *   forceOverdue?:boolean  // 母气泡过期时，子气泡也跟着变紫（用户要求）
 * }} opts
 */
export function bubbleStyle(item, opts = {}) {
  const now = opts.now || new Date();
  const ev = item.event || {};
  // ⚠️ 优先用 **item.deadline**（这次发生的截止时刻），而不是事件自己的。
  //
  // 为什么：重复事件一周勾了周一到周日时，7 次发生各有各的截止日期。
  // 用事件自己的 deadline 会让 7 个气泡算出同一个剩余时间 —— 看起来一模一样
  // （用户报"我勾了 7 天，你给我蹦 7 个一样的气泡"）。
  // `expandRange` 现在会给每个 item 算好 `deadline`。
  const remaining = item.deadline instanceof Date && Number.isFinite(item.deadline.getTime())
    ? item.deadline.getTime() - now.getTime()
    : remainingMsOf(ev, now);

  // 过期判定分两种：
  //   · 自己过期      → remaining ≤ 0
  //   · 母气泡过期    → opts.forceOverdue（母泡泡变紫时，子泡泡一起变紫）
  // 注意 `remaining == null`（未设期限）**不算过期**，否则没填期限的会全变紫。
  const ownOverdue = remaining != null && remaining <= 0;
  const overdue = ownOverdue || !!opts.forceOverdue;

  // 大小通道：只由"还剩多久"决定（连续曲线，档内加速）
  const band = bandForRemaining(remaining == null ? Infinity : remaining);
  // 尺寸只在**自己**过期时才拉满；"因为母气泡过期才变紫"的子气泡**保持自己的尺寸**。
  //   ⚠️ 一开始让继承的也拉满，结果一个容器里几个子气泡全变成最大，
  //      在那个空间里根本挤不开（实测 overlap=2 maxOv=123，文字叠在一起看不清）。
  //      用户要的是"变紫"，不是"变大"。
  const ratio = ownOverdue ? OVERDUE_SIZE : sizeRatioForRemaining(remaining);

  const min = Number.isFinite(opts.minRadius) ? opts.minRadius : 26;
  const max = Number.isFinite(opts.maxRadius) ? opts.maxRadius : 104;
  let radius = min + (max - min) * ratio;

  const done = !!ev.done;
  // 已完成/已戳破的缩到 55%，让位但还在
  if (done) radius *= 0.55;

  // 颜色通道：事情多大
  const levelKey = levelOf(ev);
  const level = levelByKey(levelKey);

  // 通知强度：看还剩多久（不看颜色）
  const intensity = remaining == null ? 1 : (ownOverdue ? 4 : intensityForBand(band.key));

  return {
    // 兼容旧字段
    urgency: { score: urgencyOf(ev.start, now).score, hours: (remaining == null ? NaN : remaining / 3_600_000) },
    magnitude: level.rank * 33 + 1,           // 旧字段：给老组件一个近似值
    tier: level,                              // 颜色档位（现在是"事情多大"）
    tierKey: levelKey,
    level,
    levelKey,
    // 新字段
    remaining,
    /**
     * ⚠️ 这两个用 **ownOverdue**，不用 `overdue`。
     *
     * `overdue` 含"从祖先继承"（母气泡过期 → 子泡泡一起变紫，用户当初要求的）。
     * 但**继承来的那一颗自己并没有到期**，它的 `timeText` 是"剩余 N 天"。
     * 如果这里也写"已过期"，同一颗泡泡上就会同时出现
     * 「已过期」和「剩余 3 天」—— 用户报的正是这个矛盾。
     *
     * 所以：档位/文字只陈述自己（ownOverdue）；
     * "容器过期了"这件事交给 `overdueInherited` 标记，由渲染层用**另一种视觉**表达
     * （现在画成一圈暗紫虚线环，而不是整颗变紫）。
     */
    band: ownOverdue ? 'second' : band.key,
    bandLabel: ownOverdue ? '已过期' : band.label,
    overdue,
    ownOverdue,
    overdueInherited: overdue && !ownOverdue, // 因为母气泡过期才变紫
    radius,
    radiusRatio: ratio,
    done,
    intensity,
    // 文本
    timeText: countdownTextOf(remaining, opts.fuzzy),
    countdownText: countdownTextOf(remaining, opts.fuzzy),
    // 需要"更细的读数"时（气泡大、且在一周以内）才带上分钟/秒
    detailText: detailTextFor(remaining, now, opts.fuzzy),
    /**
     * 这次发生是星期几（'一'…'日'）；单次日程给 null。
     *
     * 只有**重复事件**才需要它：一周勾了 7 天时，7 个泡泡的标题一样、
     * 剩余时间也各自不同但还是容易看混，只有"周几"能一眼区分是哪一天。
     * 单次日程显示周几是噪音，所以按 `item.start` 是否来自展开来判定 ——
     * 调用方通过 opts.showWeekday 传入（气泡视图里重复事件才传 true）。
     */
    weekdayLabel: opts.showWeekday
      ? '日一二三四五六'[(item.start instanceof Date ? item.start : new Date(item.start)).getDay()]
      : null,
  };
}

/** 倒数文本：过期就说"已过 X"，别显示"剩余 0 秒" */
export function countdownTextOf(remaining, fuzzy) {
  if (remaining == null) return '未设期限';
  if (remaining <= 0) return `已过 ${formatRemaining(-remaining, { prefix: false })}`;
  return formatRemaining(remaining, fuzzy ? { prefix: true } : { prefix: true });
}

/** 气泡第二行用的细读数：一周内显示到"天/时/分"，更远就只给天级 */
function detailTextFor(remaining, now, fuzzy) {
  if (fuzzy) return '';
  const abs = Math.abs(remaining);
  if (abs >= WEEK_MS) return '';
  if (remaining <= 0) return `已过 ${formatRemaining(-remaining, { prefix: false })}`;
  return formatRemaining(remaining, { prefix: false });
}

// ---------------------------------------------------------------------------
// 通知强度（前端也用它显示图例/预览）
// ---------------------------------------------------------------------------

/** 事件类型 → 默认"事情多大"（四档颜色） */
export const TYPE_DEFAULT_LEVEL = {
  exam: 'red',        // 考试：重大
  task: 'amber',      // 任务：大事
  course: 'emerald',  // 课程：中等
  activity: 'emerald',
  personal: 'sky',    // 个人：小事
  other: 'sky',
};

export function defaultLevelForType(type) {
  return TYPE_DEFAULT_LEVEL[type] || DEFAULT_LEVEL;
}

/** @deprecated 用 defaultLevelForType：事情多大现在是四档颜色，不是 1–100 的连续值 */
export function defaultMagnitudeForType(type) {
  const lv = defaultLevelForType(type);
  return levelByKey(lv).rank * 33 + 1;
}

/** @deprecated 颜色不再决定通知强度；保留是为了老调用不炸 */
export const TIER_REMINDER_PLAN = {};

/** @deprecated 用 reminderPlanForBand */
export function reminderPlanForTier(tierKey) {
  return reminderPlanForBand(tierByKey(tierKey).key);
}

/** @deprecated 用 notifyStyleForIntensity */
export function notificationStyleForTier(tierKey) {
  const t = tierByKey(tierKey);
  return { ...notifyStyleForIntensity(t.intensity), color: t.color, label: t.label, key: t.key };
}

/** 给界面/自检用的一张总表 */
export function tierOverview() {
  return URGENCY_TIERS.map((t) => ({
    ...t,
    notification: notifyStyleForIntensity(t.intensity),
    reminderPlan: reminderPlanForBand('day'),
  }));
}

export {
  URGENCY_TIERS, tierForHours, tierByKey, radiusForMagnitude, migrateImportance, DAY_MS,
  hexToRgba, sizeRatioForRemaining, bandForRemaining, formatRemaining,
  NEUTRAL_SIZE, OVERDUE_SIZE, MINUTE_MS, HOUR_MS, WEEK_MS,
  levelByKey, DEFAULT_LEVEL, levelFromLegacyMagnitude, intensityForBand,
  notifyStyleForIntensity, reminderPlanForBand,
};
