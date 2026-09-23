// 剩余时间 → 紧迫档位 → 气泡大小。
//
// 这是 v0.4 的核心：**气泡大小表示"还剩多久"**，颜色表示"事情多大"。
// 所有端（Web / 未来的 Kotlin / Swift）都从这里取规则，不要各写一遍。
//
// 规则来源（用户口述）：
//   · 大小档位：年 5–10% / 月 10–20% / 周 20–35% / 日 35–55% / 时 55–80%
//     / 分 80–110% / 秒 110–145%（相对最大半径的百分比）
//   · 相邻档端点正好相接（差值 5,10,15,20,25,30,35 等差）→ 做成**连续曲线**，
//     跨档不跳变；档内用幂曲线，让越接近截止增长越快。
//   · 显示两位：年+月 / 月+日 / 周+天 / 天+时 / 时+分 / 分+秒
//   · 前缀：只有"剩余"，**没有"不足"**（用户要求去掉）。
//     读数是**向下取整**的，所以"剩余 X"表示"至少还有 X"，永不虚报。

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const MONTH_MS = 30 * DAY_MS;
export const YEAR_MS = 365 * DAY_MS;

/** 单个时间单位的毫秒数。`week` 用 7 天、`month` 用 30 天、`year` 用 365 天（与档位边界一致） */
export const UNIT_MS = {
  year: YEAR_MS,
  month: MONTH_MS,
  week: WEEK_MS,
  day: DAY_MS,
  hour: HOUR_MS,
  minute: MINUTE_MS,
};

export const UNIT_LABEL = {
  year: '年',
  month: '月',
  week: '周',
  day: '天',
  hour: '小时',
  minute: '分',
  second: '秒',
};

/** 从大到小的时间单位顺序 */
export const UNIT_ORDER = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'];

/**
 * 七个紧迫档位，**按"最不紧迫 → 最紧迫"排列**（index 0 = 年档 = 气泡最小）。
 *
 * 每档显式写出自己的 `min`/`max`（毫秒，`min` 含、`max` 不含），靠 id 找档时用
 * `order` 做锚点。**不要靠"上界"反推下界** —— 早先的写法就是这么错的：
 * 按 max 升序排的话月档会排在周档前，导致 30 天被算成月档、7 天算成月档。
 *
 * `lo`/`hi` 是该档对应的尺寸比例（相对最大半径），端点**相接**：上一档的 `hi`
 * 就是下一档的 `lo`，所以整体连续，跨档不跳变。
 * `p` 是档内幂曲线指数（越大 = 档内"前松后紧"，越接近截止增长越快）。
 * 最紧迫的秒档没有上界，`max: Infinity`。
 */
export const TIME_BANDS = [
  { key: 'year', label: '年', min: 365 * DAY_MS, max: Infinity, lo: 0.05, hi: 0.10, p: 1.6 },
  { key: 'month', label: '月', min: 30 * DAY_MS, max: 365 * DAY_MS, lo: 0.10, hi: 0.20, p: 1.8 },
  { key: 'week', label: '周', min: 7 * DAY_MS, max: 30 * DAY_MS, lo: 0.20, hi: 0.35, p: 2.0 },
  { key: 'day', label: '日', min: DAY_MS, max: 7 * DAY_MS, lo: 0.35, hi: 0.55, p: 2.2 },
  { key: 'hour', label: '时', min: HOUR_MS, max: DAY_MS, lo: 0.55, hi: 0.80, p: 2.4 },
  { key: 'minute', label: '分', min: MINUTE_MS, max: HOUR_MS, lo: 0.80, hi: 1.10, p: 2.5 },
  { key: 'second', label: '秒', min: 0, max: MINUTE_MS, lo: 1.10, hi: 1.45, p: 2.6 },
];

/** 没有截止时间时用的中性尺寸（中等偏小，既不夸张也不像不重要） */
export const NEUTRAL_SIZE = 0.30;

/** 已过截止时的尺寸：仍取最大尺寸（过期不缩水，而是变紫长刺） */
export const OVERDUE_SIZE = 1.45;

const BAND_BY_KEY = new Map(TIME_BANDS.map((b) => [b.key, b]));

export function bandByKey(key) {
  return BAND_BY_KEY.get(key) || null;
}

/** 档位序号：**0 = 最紧迫（秒），6 = 最不紧迫（年）** */
export function bandIndex(key) {
  const i = TIME_BANDS.findIndex((b) => b.key === key);
  return i < 0 ? 0 : TIME_BANDS.length - 1 - i;
}

/**
 * 剩余时间 → 档位。
 *
 * 边界规则（保证"无缝且不重叠"）：
 *   档 i 的范围是 `[上一档上界, 本档上界)`；秒档没有上界（0 以上全部算秒档）。
 * 所以 365 天正好落在年档、30 天正好落在月档、7 天落在周档、24 小时落在日档。
 */
/**
 * 剩余时间 → 档位。表是按"最不紧迫 → 最紧迫"排的，逐档判断 `min` 即可。
 * 边界含下界不含上界，所以 365 天 = 年档、30 天 = 月档、7 天 = 周档、24 小时 = 日档。
 */
export function bandForRemaining(remainingMs) {
  const ms = Number(remainingMs);
  if (!Number.isFinite(ms) || ms <= 0) return BAND_BY_KEY.get('second');
  for (const band of TIME_BANDS) {
    if (ms >= band.min) return band;
  }
  return BAND_BY_KEY.get('second');
}

/**
 * 剩余时间 → 尺寸比例（相对最大半径的倍数，1.0 = 100%）。
 *
 * 连续、单调、档内加速：
 *   档 i 的剩余时间区间是 [loMs, hiMs]，越接近截止越小；用
 *     ratio = ((hiMs - remaining) / (hiMs - loMs)) ^ p
 *   把"时间进度"映射到 [0,1]，再线性插值到 [band.lo, band.hi]。
 *   因为端点相接，跨档时结果连续（不会突然变大变小）。
 *   p > 1 使档内前段慢、后段快 —— 这就是"越接近截止，变大越快"。
 */
export function sizeRatioForRemaining(remainingMs) {
  if (remainingMs == null || !Number.isFinite(remainingMs)) return NEUTRAL_SIZE;
  if (remainingMs <= 0) return OVERDUE_SIZE;

  const band = bandForRemaining(remainingMs);
  const upper = band.max;
  const lower = band.min;
  // 年档没有上界（≥365 天）→ 固定取该档最小值
  if (!Number.isFinite(upper)) return band.lo;

  const span = Math.max(1, upper - lower);
  const nearness = Math.min(1, Math.max(0, (upper - remainingMs) / span));
  const curved = nearness ** band.p;
  return band.lo + (band.hi - band.lo) * curved;
}

/**
 * 档内增长速率（尺寸比例 / 天）。用来验证"越接近截止增长越快"，
 * 也方便做调试面板（`?debug=1`）。
 */
export function growthRatePerDay(remainingMs) {
  if (!(remainingMs > 0)) return 0;
  const band = bandForRemaining(remainingMs);
  if (!Number.isFinite(band.max)) return 0;
  const span = Math.max(1, band.max - band.min);
  const nearness = Math.min(1, Math.max(0, (band.max - remainingMs) / span));
  const derivative = band.p * (Math.max(1e-6, nearness) ** (band.p - 1));
  const perMs = ((band.hi - band.lo) * derivative) / span;
  return perMs * DAY_MS;
}

// ---------------------------------------------------------------------------
// 显示文本
// ---------------------------------------------------------------------------

/**
 * 剩余毫秒 → 各单位拆解。`limitUnits` 可限制参与的单位。
 *
 * 重要：**周会被并进"天"**。毫秒拆解天生会先拆出"周"，但用户要的读法是"8 天"，
 * 不是"1 周 1 天"。所以周先取出来当 0 周，最后把周数 × 7 加进 `day`。
 * （踩过的坑：如果在循环里 `out.day +=` 合并，之后轮到 day 那一轮会把值覆盖掉。）
 */
export function breakdown(remainingMs, limitUnits) {
  const units = Array.isArray(limitUnits) && limitUnits.length ? limitUnits : UNIT_ORDER;
  let rest = Math.max(0, Math.floor(remainingMs));
  const out = { ms: 0 };
  for (const unit of UNIT_ORDER) out[unit] = 0;

  let weeks = 0;
  for (const unit of units) {
    const ms = unit === 'second' ? 1000 : UNIT_MS[unit];
    const value = Math.floor(rest / ms);
    rest -= value * ms;
    if (unit === 'week') weeks = value;   // 不单独显示，稍后并进"天"
    else out[unit] = value;
  }
  out.day += weeks * 7;
  out.ms = rest;
  return out;
}

/** 单位 → 下一个更小单位 */
function nextUnitOf(unit) {
  const i = UNIT_ORDER.indexOf(unit);
  return i >= 0 && i + 1 < UNIT_ORDER.length ? UNIT_ORDER[i + 1] : null;
}

export { nextUnitOf };

/** 单位 → 毫秒（second 单独处理成 1000） */
function msOfUnit(unit) {
  return unit === 'second' ? 1000 : UNIT_MS[unit];
}

/**
 * 两个时间点之间的**日历差**（逐单位借位）。
 *
 * 为什么要按日历算，而不是拿毫秒除一除：`YEAR_MS = 365 天`、`MONTH_MS = 30 天`，
 * 于是 3 年 4 月 = 1455 天，而被 30 天一除会得到 48.5 个月 → 显示成"不足 5 年"。
 * 用户填的是**年月周日时分**，所以差值也必须按年月周日时分来借位。
 *
 * 只做"从开始日期逐单位加、不越过目标"的写法；日历月的长度取真实值
 * （1 月 31 日 + 1 个月 = 2 月 28/29 日，这就是要日历算的原因）。
 */
export function calendarDiff(fromMs, toMs) {
  const sign = toMs >= fromMs ? 1 : -1;
  const a = sign > 0 ? new Date(fromMs) : new Date(toMs);
  const b = sign > 0 ? new Date(toMs) : new Date(fromMs);

  // 年
  let years = b.getFullYear() - a.getFullYear();
  const probeYear = new Date(a.getTime());
  probeYear.setFullYear(a.getFullYear() + years);
  if (probeYear.getTime() > b.getTime()) years -= 1;

  // 月
  const afterYears = new Date(a.getTime());
  afterYears.setFullYear(a.getFullYear() + years);
  let months = (b.getFullYear() - afterYears.getFullYear()) * 12 + (b.getMonth() - afterYears.getMonth());
  const probeMonth = new Date(afterYears.getTime());
  probeMonth.setMonth(afterYears.getMonth() + months);
  if (probeMonth.getTime() > b.getTime()) months -= 1;

  const afterMonths = new Date(afterYears.getTime());
  afterMonths.setMonth(afterYears.getMonth() + months);

  // 剩下的用毫秒差拆成 天/时/分/秒（这一段没有日历歧义）
  let restMs = b.getTime() - afterMonths.getTime();
  const days = Math.floor(restMs / DAY_MS);
  restMs -= days * DAY_MS;
  const hours = Math.floor(restMs / HOUR_MS);
  restMs -= hours * HOUR_MS;
  const minutes = Math.floor(restMs / MINUTE_MS);
  restMs -= minutes * MINUTE_MS;
  const seconds = Math.floor(restMs / 1000);
  restMs -= seconds * 1000;

  const out = {
    year: years, month: months, day: days, hour: hours, minute: minutes, second: seconds,
    ms: restMs,
  };
  if (sign < 0) {
    for (const k of Object.keys(out)) out[k] = -out[k];
  }
  return out;
}

/**
 * 从"日历各单位"的顺序表生成时间戳（不做进位，setMonth/setFullYear 会自动进位）。
 * 用于把 `{year,month,week,day,hour,minute}` 直接落到一个日历时刻上。
 * 注意 **week 要折算成 7 天一次加**，不能和 day 分两次 setDate（会重复加）。
 */
function stampFromUnits(units, nowMs) {
  const d = new Date(nowMs);
  if (units.year) d.setFullYear(d.getFullYear() + units.year);
  if (units.month) d.setMonth(d.getMonth() + units.month);
  const days = (units.week || 0) * 7 + (units.day || 0);
  if (days) d.setDate(d.getDate() + days);
  if (units.hour) d.setHours(d.getHours() + units.hour);
  if (units.minute) d.setMinutes(d.getMinutes() + units.minute);
  return d.getTime();
}

/**
 * 从 `fromMs` 起，按 `units` 的顺序逐级累加，看最多能推进到哪一刻。
 *
 * 两个要点（都踩过坑）：
 *   ① 累加要**带着当前祖先走**：累到"日"的时候，前面的"周"已经在 anchor 里，
 *      不能每级都从 fromMs 重新起算（那样周和天会各算一遍，出现 2 周 + 6 天重复计数）。
 *   ② 每一级都要**贪心地重估**：先按毫秒估一个份数，再往下微调，
 *      而且**必须先试"上一级再加一"**——否则"日"会一路加到 6 天，
 *      而其实再凑 1 天就能进位成第 3 周（3 周差 1 分钟就是这种情况）。
 */
function advanceByUnits(fromMs, toMs, units, totalMs) {
  const total = Math.max(0, Number(totalMs) || (toMs - fromMs));
  const acc = {};
  for (const u of UNIT_ORDER) acc[u] = 0;
  let anchorMs = fromMs;

  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit === 'second') continue;
    const next = units[i + 1];

    // 先试上一级再补一格（可能刚好凑满，就该进位）
    if (next && next !== 'second') {
      const probe = stampFromUnits({ [unit]: 1 }, anchorMs);
      if (probe <= toMs) {
        acc[unit] += 1;
        anchorMs = probe;
      }
    }

    // 再把本单位尽量加满。
    // 上界要取"从 anchor 到 toMs 的毫秒数 / 单位长度"的**向下取整再加 2**：
    // 不能用 (toMs - anchorMs)/unit 的四舍五入，也不能假设"加月"是可加的
    // （1 月 15 日 + 2 个月 与 1 月 15 日 + 1 个月 + 1 个月 落点不一定同一天）。
    const upper = Math.floor((toMs - anchorMs) / msOfUnit(unit)) + 2;
    for (let k = Math.max(0, upper); k >= 1; k -= 1) {
      const probe = stampFromUnits({ [unit]: k }, anchorMs);
      if (probe <= toMs) {
        acc[unit] += k;
        anchorMs = probe;
        break;
      }
    }
  }
  return { units: acc, anchorMs };
}

/**
 * 按"刻度单位"显示（**距离期限**那种填法）。
 *
 * 刻度 = 用户填写时的最小项，按这个单位**向下取整**数：
 *   只填 3 周     → 剩余 3 周 → 剩余 2 周 → …（快到头时才掉格）
 *   3 年 4 月     → 剩余 3 年 4 月 → 剩余 3 年 3 月 → …
 *
 * 向下取整的理由跟 `formatRemaining` 一致：读数永不虚报、观感更紧迫，
 * 而且不再需要"不足"这个前缀（用户要求去掉）。
 *
 * 必须按**日历**数（`setMonth` 那种），不能拿 30 天硬除 ——
 * "3 年 4 月" = 40 个月，用 30 天除会算成 40.5 个月。
 */
export function formatRemainingInUnit(remainingMs, tickUnit, opts = {}) {
  const withPrefix = opts.prefix !== false;
  if (remainingMs == null || !Number.isFinite(remainingMs)) return '未设期限';
  const unit = UNIT_LABEL[tickUnit] ? tickUnit : 'day';
  const total = Math.max(0, Math.floor(Number(remainingMs) || 0));
  const nowMs = opts.now != null ? Number(opts.now) : Date.now();

  // 秒没有"日历"概念，直接按秒取整
  if (unit === 'second') {
    const text = `${Math.floor(total / 1000)} 秒`;
    return withPrefix ? `剩余 ${text}` : text;
  }

  const CAL = ['year', 'month', 'week', 'day', 'hour', 'minute'];
  const order = [...CAL.slice(0, CAL.indexOf(unit) + 1), UNIT_ORDER[UNIT_ORDER.indexOf(unit) + 1]]
    .filter(Boolean);

  // 按日历逐级推进，取"完整的刻度数"
  const { units } = advanceByUnits(nowMs, nowMs + total, order, total);
  // 高一级的份数要折进刻度里：tick=月 时 units 是 {year:3, month:4}，
  // 真正的月数是 3×12 + 4 = 40（不折算会把"3 年 4 月"报成"5 月"）。
  const count = unitsToTickCount(units, unit);

  if (count >= 1) {
    const text = describeUnitCount(count, unit);
    return withPrefix ? `剩余 ${text}` : text;
  }

  // 不到一个刻度（例如填的是"3 周"但只剩 3 天）→ 改用更小的单位说
  return formatRemaining(total, {
    prefix: withPrefix,
    limitUnits: order.slice(order.indexOf(unit)),
  });
}

/** 把 {year, month, week, day...} 折算成"多少个 unit" */
function unitsToTickCount(units, unit) {
  if (unit === 'month') return (units.year || 0) * 12 + (units.month || 0);
  if (unit === 'week') return (units.week || 0) + Math.floor((units.day || 0) / 7);
  if (unit === 'day') return (units.month || 0) * 30 + (units.week || 0) * 7 + (units.day || 0);
  return units[unit] || 0;
}

/** 把"多少个 unit"写回 {unit: n} 形式的顺序表 */
function ticksToUnits(n, unit) {
  return { [unit]: n };
}

/** 把"多少个刻度单位"写成人类读法 */
export function describeUnitCount(count, unit) {
  const n = Math.max(0, Math.floor(count));
  if (unit === 'month' && n >= 12) {
    const y = Math.floor(n / 12);
    const m = n % 12;
    return m > 0 ? `${y} 年 ${m} 月` : `${y} 年`;
  }
  return `${n} ${UNIT_LABEL[unit]}`;
}

/**
 * 只显示一级的"粗"单位：到了"天"这个量级，用户只关心天数，
 * 再报小时就是噪音（"3 天 5 小时"读起来累）。
 *
 * ⚠️ **不能把 month 放进来**：年是"年+月"成对读的（3 年 4 月），
 * 把 month 当粗单位会让年+月这一对走"顶位加一"的分支，
 * 于是"3 年 4 月差 1 小时"会被并成"4 年"（踩过）。
 */
const COARSE_UNITS = new Set(['year', 'day']);

/**
 * 进位上限：**这个单位里能装几个自己**（= 满几个就并进上一级）。
 *
 * ⚠️ 别和"一个单位含多少个更小单位"混为一谈（这两张表方向相反，踩过）：
 *   分钟满 60 → 1 小时；小时满 24 → 1 天；月满 12 → 1 年。
 *   这里 month 必须是 **12**，写成 4（"一月约四周"）会让"3 年 4 月"被并成"4 年"。
 */
const SUBUNITS = {
  year: 12,     // 12 月 → 1 年（年没有上一级，用不到）
  month: 12,    // 12 月 → 1 年
  week: 4,      // ≈4 周 → 1 月
  day: 24,      // 24 小时 → 1 天
  hour: 60,     // 60 分 → 1 小时
};


/**
 * 低位"满格"就并进上位，否则会印出"不足 23 小时 60 分"这种不存在的读数（真机上出现过）。
 *
 * 判据是**严格超过** `> cap`：
 *   分钟 = 60（= cap，正好 1 小时）→ 归 0 并给小时 +1
 *   月 = 12（"12 月"本身是合法读数）→ 只有 >12 才并
 * 用 `>=` 会把合法的"3 年 12 月"记法误并掉（踩过）。
 */
function rollUpOverflow(picked) {
  for (let i = picked.length - 1; i > 0; i -= 1) {
    const cap = SUBUNITS[picked[i].unit] || SUBUNITS[picked[i - 1].unit];
    if (!cap || picked[i].value < cap) continue;
    if (picked[i].value > cap) {
      picked[i - 1].value += Math.floor(picked[i].value / cap);
      picked[i].value %= cap;
    } else {
      picked[i - 1].value += 1;
      picked[i].value = 0;
    }
    if (picked[i].value === 0) picked.splice(i, 1);
  }
}

/**
 * 剩余时间 → "剩余 3 年 4 月 / 剩余 8 天 / 剩余 45 分 10 秒"。
 *
 * **一律向下取整（floor）**，只保留"剩余"一种前缀（不再有"不足"）：
 *   8 天差 1 分钟 → "剩余 7 天"（不是 8 天，也不是"不足 8 天"）
 * 向下取整的好处是**永远不会虚报**（说"还剩 7 天"就真还有至少 7 天），
 * 而且读数更紧迫 —— 用户明确要的是这个观感。
 *
 * 代价：快到整格时会提前掉一格（3 周差 1 分钟 → "剩余 2 周"）。
 *
 * 显示规则：顶位 = 最大的非零单位；下一位只在"总时长还装得下上一级单位"时才带上。
 *   45 分 10 秒 → "45 分 10 秒"（总时长 < 1 小时）
 *   2 小时 3 分 → "2 小时 3 分"（< 1 天）
 *   1 天 2 小时 → "1 天"（≥ 1 天，小时是噪音）
 *   8 天 / 20 天 → 只按天说（周并入天，不写"1 周 1 天"）
 *   3 年 4 月 → 年月成对读
 */
export function formatRemaining(remainingMs, opts = {}) {
  const withPrefix = opts.prefix !== false;
  if (remainingMs == null || !Number.isFinite(remainingMs)) return '未设期限';
  const total = Math.max(0, Math.floor(remainingMs));
  if (total === 0) return withPrefix ? '剩余 0 秒' : '0 秒';

  const nowMs = opts.now != null ? Number(opts.now) : Date.now();

  // 找顶位：从大到小，取第一个"填不满上一级周期"的单位。
  // 用 `Infinity` 表示"没有上一级" —— 判据必须是 `total < cycle`，
  // **不能写成 `!Number.isFinite(cycle) || total < cycle`**：
  // 后者会让年永远命中第一轮，永远选不到月/日（踩过）。
  let idx = CAL_CHAIN.length - 1;
  for (let i = 0; i < CAL_CHAIN.length; i += 1) {
    if (total < CYCLE_MS[CAL_CHAIN[i]]) { idx = i; break; }
  }

  let topValue = floorCount(total, CAL_CHAIN[idx], nowMs);
  // 向下取整可能把这级取成 0（"差一点到 1 月"）→ 退到下一级说，别显示"剩余 0 月"
  while (topValue < 1 && idx < CAL_CHAIN.length - 1) {
    idx += 1;
    topValue = floorCount(total, CAL_CHAIN[idx], nowMs);
  }
  if (topValue < 1) topValue = 0;

  const picked = [{ unit: CAL_CHAIN[idx], value: topValue }];

  // 第二位：**只看顶位用掉之后剩下的零头**（必须减掉，否则会算出"45 分 2710 秒"
  // 这种把整段都算进低位的读数 —— 踩过）。
  //
  // 但粗单位（年/天）只报一级：到了"天"这个量级，小时就是噪音
  // （"8 天差 1 分钟"该说"剩余 7 天"，不该说"剩余 7 天 23 小时"）。
  // 年+月是例外：年月必须成对读，"3 年 4 月"少一个月会被误读成差一年。
  const lower = CAL_CHAIN[idx + 1];
  const topIsCoarse = COARSE_UNITS.has(CAL_CHAIN[idx]);
  const showLower = lower && (!topIsCoarse || CAL_CHAIN[idx] === 'year');
  if (showLower) {
    // 总时长还装得下"上一级单位"时才值得带上这一级
    const fits = total < CYCLE_MS[CAL_CHAIN[idx]];
    let rest = total;
    if (CAL_CHAIN[idx] === 'month' || CAL_CHAIN[idx] === 'year') {
      // 日历单位不能用固定毫秒乘，直接按日历推进出落点
      rest = total - (stampFromUnits(ticksToUnits(topValue, CAL_CHAIN[idx]), nowMs) - nowMs);
    } else {
      rest = total - topValue * msOfUnit(CAL_CHAIN[idx]);
    }
    const v = floorCount(Math.max(0, rest), lower, nowMs);
    if (fits && v > 0) picked.push({ unit: lower, value: v });
  }

  rollUpOverflow(picked);
  const text = picked.map((p) => `${p.value} ${UNIT_LABEL[p.unit]}`).join(' ');
  return withPrefix ? `剩余 ${text}` : text;
}

/**
 * `total` 毫秒里有多少个**完整**的 `unit`（向下取整）。
 * 日历单位（月/年）用日历推进找最大够用的份数，不能拿固定毫秒除。
 */
function floorCount(total, unit, nowMs) {
  if (unit === 'month' || unit === 'year') {
    const order = unit === 'year' ? ['year'] : ['year', 'month'];
    const { units } = advanceByUnits(nowMs, nowMs + total, order, total);
    return unitsToTickCount(units, unit);
  }
  return Math.floor(total / msOfUnit(unit));
}

// 顶位候选链：周不入列（周一律并进天，用户要"8 天"而不是"1 周 1 天"）
const CAL_CHAIN = ['year', 'month', 'day', 'hour', 'minute', 'second'];

/**
 * 每个单位"上一级周期"的长度：判断总时长还装不装得下这一级。
 *
 * `year: Infinity` = 它没有上一级，永远可以当顶位。
 * 判据是 `total < CYCLE_MS[unit]`，**不要再加 `!Number.isFinite(cycle) ||`**：
 * 那样写成"年永远命中"，就永远选不到月/日了（踩过）。
 */
const CYCLE_MS = {
  year: Infinity,
  month: YEAR_MS,
  day: MONTH_MS,
  hour: DAY_MS,
  minute: HOUR_MS,
  second: MINUTE_MS,
};

// ---------------------------------------------------------------------------
// 距离输入（"距离期限"那种填法）
// ---------------------------------------------------------------------------

export const DISTANCE_FIELDS = ['year', 'month', 'week', 'day', 'hour', 'minute'];

/**
 * 计算"距离输入"的推进刻度：**最小填写项就是时间流逝单位**。
 *
 *   只填"3 周"        → 刻度 = 周  → 剩余 3 周 → 剩余 2 周 → 剩余 1 周
 *   填"3 年 4 月"     → 刻度 = 月  → 剩余 3 年 4 月 → 剩余 3 年 3 月 → …
 *   什么都没填        → 刻度 = 天（兜底）
 *   什么都没填        → 刻度 = 天（兜底）
 */
export function tickUnitForParts(parts) {
  if (!parts || typeof parts !== 'object') return 'day';
  let smallest = null;
  for (const unit of UNIT_ORDER) {
    if (unit === 'second') continue;
    const v = Number(parts[unit] || 0);
    if (v > 0) smallest = unit;
  }
  return smallest || 'day';
}

/** 距离输入的各分量 → 毫秒合计（**固定长度口径**：年=365 天、月=30 天） */
export function partsToMs(parts) {
  if (!parts || typeof parts !== 'object') return 0;
  let ms = 0;
  for (const unit of UNIT_ORDER) {
    if (unit === 'second') continue;
    ms += Number(parts[unit] || 0) * msOfUnit(unit);
  }
  return ms;
}

/**
 * 距离输入 → 截止时间点。
 *
 * `at` 是"用户填写那一刻"的时间戳，之后倒计时从它开始推进，所以不会随编辑时间漂移。
 *
 * ⚠️ 必须按**日历**相加，不能拿 `partsToMs` 的时长直接加（踩过）：
 *   "3 年 4 月" 用固定长度算是 365×3 + 30×4 = 1455 天，
 *   而日历上是 3 个日历年 + 4 个月（含闰年共 1457 天），
 *   差出来的两天会让落点偏到 5 月 14 日 —— 于是显示永远差一格，
 *   刚填完"3 年 4 月"就看到"不足 3 年 4 月"（用户说的别扭就是这个）。
 */
export function deadlineFromParts(parts, at) {
  const d = new Date(at == null ? Date.now() : at);
  if (!parts || typeof parts !== 'object') return d;
  const n = (u) => Number(parts[u] || 0);
  if (n('year')) d.setFullYear(d.getFullYear() + n('year'));
  if (n('month')) d.setMonth(d.getMonth() + n('month'));
  const days = n('week') * 7 + n('day');
  if (days) d.setDate(d.getDate() + days);
  if (n('hour')) d.setHours(d.getHours() + n('hour'));
  if (n('minute')) d.setMinutes(d.getMinutes() + n('minute'));
  return d;
}

/** 距离输入的摘要文本，例如 "3 年 4 月" */
export function describeParts(parts) {
  if (!parts) return '';
  const bits = [];
  for (const unit of UNIT_ORDER) {
    if (unit === 'second') continue;
    const v = Number(parts[unit] || 0);
    if (v > 0) bits.push(`${v} ${UNIT_LABEL[unit]}`);
  }
  return bits.join(' ');
}

/**
 * 反推：已知截止时间和一个参考时刻，得到"距离输入"的分量。
 * 用于想让用户直接改"还剩多久"的场景。
 */
export function partsFromMs(ms) {
  const b = breakdown(Math.max(0, ms));
  const parts = {};
  for (const unit of DISTANCE_FIELDS) {
    const v = unit === 'second' ? b.second : b[unit];
    if (v > 0) parts[unit] = v;
  }
  return parts;
}

// ---------------------------------------------------------------------------
// 整数小时/天级别日期输入（"确切日期"那种填法）
// ---------------------------------------------------------------------------

/**
 * 日期精度 → 时间戳。
 * 用户"无需都填"，只填年也要能算出剩余时间：缺失的部分取该粒度的起点
 * （只填年 → 那年 1 月 1 日 00:00；只填年月 → 那个月 1 日 00:00）。
 */
export function deadlineFromDateParts(parts) {
  const y = Number(parts && parts.year);
  if (!Number.isFinite(y) || y <= 0) return null;
  const mo = Number(parts.month) > 0 ? Number(parts.month) : 1;
  const d = Number(parts.day) > 0 ? Number(parts.day) : 1;
  const h = parts.hour !== '' && parts.hour != null ? Number(parts.hour) : 0;
  const mi = parts.minute !== '' && parts.minute != null ? Number(parts.minute) : 0;
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}
