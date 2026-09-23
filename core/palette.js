// 颜色档位与配色。
//
// v0.4 起含义变了：**颜色 = 事情多大**（不再是紧急度）。
//
//   天蓝 sky     = 小事
//   翠绿 emerald = 中等
//   黄色 amber   = 大事
//   红色 red     = 重大
//
// 仍然是"交通灯式的有序语义"（小 → 大），用户不用看说明就懂；
// 而且**颜色不是唯一线索**：气泡里还会显示档位标签，
// 大小（= 还剩多久）与颜色完全解耦，不靠颜色区分紧急度。
//
// 参考：状态色（status color）在仪表盘/看板中的通行做法是
//   蓝/灰 = neutral、绿 = good、黄 = warning、红 = critical。
//   这里把蓝用于"小事"（neutral 信息态），符合该惯例。
//
// ⚠️ 紧急度（还剩多久）现在是**另一条通道**，定义在 core/countdown.js，
//    不要再往这里加"什么算急"的阈值。

/** 四档颜色。顺序即"事情多大"，index 0 最小。 */
export const URGENCY_TIERS = [
  {
    key: 'sky',
    label: '小事',
    description: '顺手就办的事',
    color: '#38bdf8',      // 天蓝
    colorDeep: '#0284c7',
    intensity: 1,
    notification: '到点前提醒一次',
  },
  {
    key: 'emerald',
    label: '中等',
    description: '需要安排的日常',
    color: '#22c55e',      // 翠绿
    colorDeep: '#15803d',
    intensity: 2,
    notification: '提前半小时 + 准点',
  },
  {
    key: 'amber',
    label: '大事',
    description: '得提前动手的事',
    color: '#f5b301',      // 黄
    colorDeep: '#b45309',
    intensity: 3,
    notification: '提前一小时起多次提醒',
  },
  {
    key: 'red',
    label: '重大',
    description: '不能出错的事',
    color: '#ef4444',      // 红
    colorDeep: '#b91c1c',
    intensity: 4,
    notification: '前一天起 + 临近时反复催',
  },
];

export const TIER_BY_KEY = Object.fromEntries(URGENCY_TIERS.map((t) => [t.key, t]));
export const MAX_INTENSITY = 4;

/**
 * @deprecated 紧急度不再看时间阈值，改看"还剩多久"的档位。
 * 保留一个空对象只是为了让老代码不炸；新代码请用 core/countdown.js 的 bandForRemaining。
 */
export const TIER_THRESHOLDS_HOURS = {};

/** 兼容旧签名：按小时数给一个"最接近"的档（已不用于紧急度，仅少量旧代码还在用） */
export function tierForHours(hours) {
  if (!Number.isFinite(hours)) return URGENCY_TIERS[0];
  if (hours <= 6) return URGENCY_TIERS[3];
  if (hours <= 24) return URGENCY_TIERS[2];
  if (hours <= 72) return URGENCY_TIERS[1];
  return URGENCY_TIERS[0];
}

export function tierByKey(key) {
  return TIER_BY_KEY[key] || URGENCY_TIERS[0];
}

export function tierColor(key) {
  return tierByKey(key).color;
}

export function tierIntensity(key) {
  return tierByKey(key).intensity;
}

/** 颜色 → 带透明度（气泡填充用） */
export function tierFill(key, alpha = 0.86) {
  return hexToRgba(tierByKey(key).color, alpha);
}

export function tierStroke(key, alpha = 1) {
  return hexToRgba(tierByKey(key).colorDeep, alpha);
}

/** 气泡里该用白字还是深字（保证对比度） */
export function tierTextColor(key) {
  return luminance(tierByKey(key).color) > 0.45 ? 'rgba(22, 28, 42, 0.94)' : '#ffffff';
}

export function hexToRgba(hex, alpha = 1) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

export function luminance(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(((num >> 16) & 255) / 255)
    + 0.7152 * lin(((num >> 8) & 255) / 255)
    + 0.0722 * lin((num & 255) / 255);
}

// ---------------------------------------------------------------------------
// 大小通道：由「事情多大」决定（用户用滑动条调），与颜色通道解耦。
// ---------------------------------------------------------------------------

export const MAGNITUDE_MIN = 1;
export const MAGNITUDE_MAX = 100;

/** 旧数据里 importance 是 1–5，换算到 1–100 */
export function migrateImportance(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 50;
  if (n <= 5) return Math.round(20 * n); // 1→20 2→40 3→60 4→80 5→100
  return Math.min(MAGNITUDE_MAX, Math.max(MAGNITUDE_MIN, Math.round(n)));
}

export const MAGNITUDE_PRESETS = [
  { value: 20, label: '小事' },
  { value: 40, label: '一般' },
  { value: 60, label: '要紧' },
  { value: 80, label: '重要' },
  { value: 100, label: '头等大事' },
];

/** 事情多大（1–100）→ 气泡基础半径 */
export const RADIUS_MIN = 26;
export const RADIUS_MAX = 104;

/**
 * 按画布大小算合理的半径区间。
 *
 * 为什么需要：手机上画布只有约 330×370 CSS 像素。若最大半径固定 104，
 * 最大气泡直径就是 208px，占掉屏幕宽度的 63%，几个气泡必然挤成一团，
 * 还会被画布边缘裁掉（真机实测确认过）。所以上限跟着画布短边缩放。
 */
export const RADIUS_MIN_FLOOR = 13;
export const RADIUS_MAX_RATIO = 0.165;  // 最大气泡半径 ≈ 画布短边的 16.5%（比第一版小 25%）
export const BUBBLE_AREA_BUDGET = 0.42; // 全部气泡面积之和 ≈ 画布的 42%（留出漂浮空隙）

export function radiusRangeForCanvas(width, height) {
  const short = Math.max(1, Math.min(width || 0, height || 0));
  const max = Math.min(RADIUS_MAX, Math.max(30, short * RADIUS_MAX_RATIO));
  const min = Math.min(RADIUS_MIN, Math.max(RADIUS_MIN_FLOOR, max * 0.36));
  return { min, max };
}

/**
 * 气泡太多/太大时整体缩小。
 * 让所有气泡面积之和不超过画布的 BUBBLE_AREA_BUDGET，避免糊成一团。
 * @returns {number} 缩放系数（0.42–1）
 */
export function areaScaleForCanvas(radii, width, height) {
  const area = (width || 0) * (height || 0);
  if (!area || !radii || !radii.length) return 1;
  const wanted = radii.reduce((sum, r) => sum + Math.PI * r * r, 0);
  const budget = area * BUBBLE_AREA_BUDGET;
  if (wanted <= budget) return 1;
  return Math.max(0.42, Math.min(1, Math.sqrt(budget / wanted)));
}

export function radiusForMagnitude(magnitude, min = RADIUS_MIN, max = RADIUS_MAX) {
  const m = Math.min(MAGNITUDE_MAX, Math.max(MAGNITUDE_MIN, Number(magnitude) || 50));
  // 用平方根让"面积感"更贴近数值，而不是半径线性
  const t = (m - MAGNITUDE_MIN) / (MAGNITUDE_MAX - MAGNITUDE_MIN);
  return min + (max - min) * Math.sqrt(t);
}
