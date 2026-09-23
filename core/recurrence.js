// 重复规则展开 + 课表周次展开。前后端算法保持一致（server/scheduler.js 同源逻辑）。
import { DAY_MS, addDays, asDate, mondayOf, startOfDay, toDateKey } from './time.js';

/**
 * 重复规则的**级别**（新生单位）与间隔。
 *
 * 用户要求："重复参数可以为**日级、周级、月级、年级**（意思是每 N 日 / 每 N 周 /
 * 每 N 月 / 每 N 年新生一次）"，"新生机制当然要**严格遵循级别单位**"。
 *
 * 数据格式：
 *   · `freq` 表级别：`daily` / `weekly` / `monthly` / `yearly`
 *   · `interval` 表"每几个级别单位"（默认 1）
 *   · **旧写法** `{freq:'biweekly'}` 继续认，等价于 `weekly + interval:2`
 *
 * 为什么不把间隔揉进 freq（比如 `every3weeks`）：那会每加一个间隔就多一个枚举值，
 * 读写都容易漏。分开之后 `freq` 表级别、`interval` 表间隔。
 *
 * ⚠️ 这个函数是**唯一**的判定入口。同样的判定在 `server/scheduler.js`、
 *    安卓 `Store.kt` 里各有一份复刻 —— 改这里必须同步改那两处，
 *    否则两端展开出的日期会不一样。
 */

/** 级别 → 中文（编辑器与显示用） */
export const RECUR_LEVELS = [
  { key: 'daily', label: '每日' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'yearly', label: '每年' },
];

/** 每个级别的间隔上限（避免"每 999 个月"这种荒唐值） */
const INTERVAL_CAP = { daily: 365, weekly: 52, monthly: 60, yearly: 20 };

/** 归一化出 { freq, interval }；`freq='none'` 或无法识别时返回 null */
export function recurLevelOf(rec) {
  if (!rec) return null;
  let freq = rec.freq;
  if (!freq || freq === 'none') return null;
  // 旧写法
  let legacyInterval = null;
  if (freq === 'biweekly') { freq = 'weekly'; legacyInterval = 2; }
  if (!RECUR_LEVELS.some((l) => l.key === freq)) return null;
  const cap = INTERVAL_CAP[freq] || 52;
  let n = Number(rec.interval);
  if (legacyInterval != null && (!Number.isFinite(n) || n < 1)) n = legacyInterval;
  if (!Number.isFinite(n) || n < 1) n = 1;
  return { freq, interval: Math.min(cap, Math.floor(n)) };
}

/**
 * 这条重复规则"每几周"一次。
 *
 * ⚠️ 只有**周级**才有意义。日/月/年的间隔不是"周"，调用方应当用 `recurLevelOf`。
 *    保留这个函数是因为 `server/scheduler.js` 与 Kotlin 都按"周"处理，
 *    而且它就是"周级间隔"的语义名。
 */
export function intervalWeeksOf(rec) {
  const lv = recurLevelOf(rec);
  if (!lv) return 1;
  return lv.freq === 'weekly' ? lv.interval : 1;
}

/**
 * 事件在 [from, to] 区间内实际发生的时间点列表。
 * @param {object} ev
 * @param {Date} from
 * @param {Date} to
 * @param {string} termStart 学期第一周周一（课表用）
 */
export function occurrences(ev, from, to, termStart) {
  const out = [];
  const start = asDate(ev.start);
  if (Number.isNaN(start.getTime())) return out;
  const rec = ev.recurrence || { freq: 'none' };

  const level = recurLevelOf(rec);

  if (level && level.freq === 'weekly') {
    const stepWeeks = level.interval;
    const byDay = (rec.byDay && rec.byDay.length ? rec.byDay : [start.getDay()]).map(Number);
    const until = rec.until ? new Date(`${rec.until}T23:59:59`) : null;
    const baseMonday = mondayOf(start);
    let cursor = startOfDay(from < start ? start : from);
    const guardEnd = addDays(to, 7 * stepWeeks);
    // ⚠️ 必须去重：`byDay` 里同一天可能被扫到多次。
    //    循环是**逐日**推进的，而对每个命中的日子都算同一个 `occ`（只有时分来自 start）。
    //    所以"一周勾了 7 天"时，那一周里 7 天都命中、`weekDiff` 都等于本周 ——
    //    同一个「周一 07:00」被 push 了 7 次（实测气泡数从 7 涨到 45）。
    //    用 Set 按时间戳去重最稳，也顺手保证输出有序。
    const hit = new Set();
    while (cursor <= guardEnd) {
      if (until && cursor > until) break;
      if (byDay.includes(cursor.getDay())) {
        const occ = new Date(cursor);
        occ.setHours(start.getHours(), start.getMinutes(), 0, 0);
        const weekDiff = Math.round((mondayOf(occ) - baseMonday) / (7 * DAY_MS));
        if (weekDiff >= 0 && weekDiff % stepWeeks === 0 && occ >= from && occ <= to) {
          hit.add(occ.getTime());
        }
      }
      cursor = addDays(cursor, 1);
    }
    return [...hit].sort((a, b) => a - b).map((ms) => new Date(ms));
  }

  // ---- 日级：每 N 日 ----
  //
  // 从事件开始那天算起，每 N 天一次（时分沿用 start）。
  // 按"天差"计算而不是逐日推进，天然不会有重复。
  if (level && level.freq === 'daily') {
    const step = level.interval;
    const until = rec.until ? new Date(`${rec.until}T23:59:59`) : null;
    const startDay = startOfDay(start);
    const hit = [];
    // 跳到区间起点附近（可能落在 start 之前，所以用 Math.max 兜一下）
    const beginDay = startOfDay(from < start ? start : from);
    let k = Math.floor((beginDay - startDay) / DAY_MS / step);
    if (!Number.isFinite(k) || k < 0) k = 0;
    for (let i = k; ; i += 1) {
      const occ = new Date(startDay);
      occ.setDate(occ.getDate() + i * step);
      occ.setHours(start.getHours(), start.getMinutes(), 0, 0);
      if (occ > to) break;
      if (until && occ > until) break;
      if (occ >= from && occ >= start) hit.push(occ);
    }
    return hit.sort((a, b) => a - b);
  }

  // ---- 月级：每 N 月 ----
  //
  // 用户原话："你那个月级和年级你每个月天数一样的一起写，每年天数一样一起写，
  //           新生机制当然要严格遵循级别单位啊，不要用 31 号死规矩做判定，
  //           每个月特殊的灵活来，特殊的分开判断就ok"
  //
  // 做法：以"月"为单位步进，落到**同一个月内的同一天**。
  //   · 各月天数不同的（如 1/31 起、到 2 月没有 31 号）→ **该月不新生**（跳过）
  //   · 判据是 Date 构造后的 month/day 是否还等于锚点 —— 溢出（2/31 → 3/3）会被识别出来
  //   · 不用"统一顺延到月末"这种一刀切：那是拿死数字套所有月，违背"严格按级别单位"
  if (level && level.freq === 'monthly') {
    const step = level.interval;
    const until = rec.until ? new Date(`${rec.until}T23:59:59`) : null;
    const anchorY = start.getFullYear();
    const anchorM = start.getMonth();
    const anchorD = start.getDate();
    const hit = [];
    // 从"可能落在 from 附近"的月份开始，往回多跑一个月保险
    let k = (from.getFullYear() - anchorY) * 12 + (from.getMonth() - anchorM) - step;
    if (!Number.isFinite(k) || k < 0) k = 0;
    for (let i = k; ; i += step) {
      const occ = new Date(anchorY, anchorM + i, anchorD,
        start.getHours(), start.getMinutes(), 0, 0);
      // 月份溢出 / 日不存在 → 这个月没有对应的"同一天"，跳过（不算新生）
      if (occ.getDate() !== anchorD || occ.getMonth() !== ((anchorM + i) % 12 + 12) % 12) {
        if (occ > to) break;
        continue;
      }
      if (occ > to) break;
      if (until && occ > until) break;
      if (occ >= from && occ >= start) hit.push(occ);
    }
    return hit.sort((a, b) => a - b);
  }

  // ---- 年级：每 N 年 ----
  //
  // 同理以"年"为单位步进，落到同一天。闰年 2/29 起的事件，平年 2/29 不存在 → **那年不新生**。
  if (level && level.freq === 'yearly') {
    const step = level.interval;
    const until = rec.until ? new Date(`${rec.until}T23:59:59`) : null;
    const anchorY = start.getFullYear();
    const anchorM = start.getMonth();
    const anchorD = start.getDate();
    const hit = [];
    let k = from.getFullYear() - anchorY - step;
    if (!Number.isFinite(k) || k < 0) k = 0;
    for (let i = k; ; i += step) {
      const occ = new Date(anchorY + i, anchorM, anchorD,
        start.getHours(), start.getMinutes(), 0, 0);
      // 闰年才有 2/29；平年构造会溢出到 3/1 —— 那年跳过，不硬凑
      if (occ.getDate() !== anchorD || occ.getMonth() !== anchorM) {
        if (occ > to) break;
        continue;
      }
      if (occ > to) break;
      if (until && occ > until) break;
      if (occ >= from && occ >= start) hit.push(occ);
    }
    return hit.sort((a, b) => a - b);
  }

  // 课表：weeks 指定上课周次
  if (ev.type === 'course' && Array.isArray(ev.weeks) && ev.weeks.length && termStart) {
    const monday = mondayOf(asDate(termStart));
    const dow = start.getDay();
    for (const w of ev.weeks) {
      const occ = addDays(monday, (Number(w) - 1) * 7 + (dow === 0 ? 6 : dow - 1));
      occ.setHours(start.getHours(), start.getMinutes(), 0, 0);
      if (occ >= from && occ <= to) out.push(occ);
    }
    return out.sort((a, b) => a - b);
  }

  if (start >= from && start <= to) out.push(start);
  return out;
}

/**
 * 这次发生（occurrence）的截止时刻。
 *
 * ⚠️ 这个函数是「7 个勾选的重复气泡显示同一个剩余时间」的修复点。
 *
 * 原来气泡的剩余时间一律用**事件自己的 deadline** 算，而重复实例只改了发生日期。
 * 于是一周勾了周一到周日 → 7 个实例算出**同一个**"还剩多久"，
 * 看起来就是 7 个一模一样的泡泡（用户报的 bug）。
 *
 * 规则：把「事件开始 → 事件截止」这段关系**平移**到这次发生的日期上。
 *   · 没填 deadline（deadline 就是 start）→ 本次截止 = 本次开始（每周期归零，符合直觉）
 *   · 填了 deadline（"周三开始、周五截止"）→ 保持同样的间隔
 *
 * 返回毫秒；算不出来给 null（沿用 `deadlineOf` 的"未设期限"语义）。
 */
export function occurrenceDeadline(ev, occStart, occEnd) {
  const startMs = asDate(ev.start).getTime();
  if (!Number.isFinite(startMs)) return null;
  // ⚠️ 优先级 `deadline > end > start` —— 与 core/state-ops.js 的 deadlineMsOf 一致
  //    （用户选定的方案 C："到期" = 这件事结束了）。
  //    没有显式 deadline 时取 `end`：18:30–20:05 的课在 19:00 应当"还剩 65 分钟"、
  //    **不**变紫。原来这里取的是 `start`，于是课一开就紫 —— 和"容器变紫"的
  //    判据（用 end）互相矛盾。
  //    提醒不在这里：提醒点相对 occurrence 的 **start** 算（见 core/reminder-plan.js）。
  const raw = ev.deadline || ev.end || ev.start;
  const dl = new Date(raw).getTime();
  if (!Number.isFinite(dl)) return null;
  // 相对事件开始的偏移（通常是 0；"周三开始周五截止"时是 +2 天）
  const offset = dl - startMs;
  const base = offset === 0 ? asDate(occStart).getTime() : asDate(occStart).getTime() + offset;
  return Number.isFinite(base) ? base : null;
}

/**
 * 把区间内的事件展开成带 occurrence 的扁平列表，按时间排序。
 *
 * 每个 item 都带 `deadline`（**这次发生的**截止时刻）——
 * 气泡的倒计时、大小、是否变紫都由它决定，不再共用整个事件的那一个。
 */
export function expandRange(events, from, to, termStart, filterFn) {
  const items = [];
  for (const ev of events) {
    if (filterFn && !filterFn(ev)) continue;
    for (const occ of occurrences(ev, from, to, termStart)) {
      const duration = Math.max(0, asDate(ev.end || ev.start) - asDate(ev.start));
      const end = new Date(occ.getTime() + duration);
      const dl = occurrenceDeadline(ev, occ, end);
      items.push({
        event: ev,
        start: occ,
        end,
        /** 这次发生的截止时刻（毫秒）—— 供气泡算剩余时间/大小/是否过期 */
        deadline: dl == null ? null : new Date(dl),
        key: `${ev.id}@${toDateKey(occ)}`,
      });
    }
  }
  return items.sort((a, b) => a.start - b.start || (a.event.title || '').localeCompare(b.event.title || ''));
}

/** 事件在某天的发生实例（列表视图/日视图用） */
export function occurrencesOnDay(ev, day, termStart) {
  const from = startOfDay(day);
  const to = new Date(from.getTime() + DAY_MS - 1);
  return occurrences(ev, from, to, termStart);
}

export const FREQ_LABEL = {
  none: '不重复',
  weekly: '每周',
  biweekly: '每两周',
};

export function recurrenceLabel(ev) {
  const rec = ev.recurrence || { freq: 'none' };
  if (ev.type === 'course' && ev.weeks && ev.weeks.length) {
    return `共 ${ev.weeks.length} 周`;
  }
  const base = freqLabelOf(rec);
  if (base === '不重复') return base;
  const days = (rec.byDay || []).map((d) => '日一二三四五六'[d]).join('、');
  return days ? `${base} · 周${days}` : base;
}

/**
 * 重复规则的显示文字。
 *
 * "每 N 周"要如实显示 N（"每三周"不能显示成"每周"，那会让人以为记错了）。
 * N=1 显示"每周"，N=2 显示"每两周"（保持用户熟悉的说法），其余显示"每 N 周"。
 */
export function freqLabelOf(rec) {
  const lv = recurLevelOf(rec);
  if (!lv) return '不重复';
  const { freq, interval: n } = lv;
  // 周级保留用户熟悉的说法（"每两周"比"每 2 周"顺口）
  if (freq === 'weekly') {
    if (n === 1) return '每周';
    if (n === 2) return '每两周';
    return `每 ${n} 周`;
  }
  const unit = { daily: '天', monthly: '月', yearly: '年' }[freq];
  if (n === 1) return { daily: '每天', monthly: '每月', yearly: '每年' }[freq];
  return `每 ${n} ${unit}`;
}

// ---------------------------------------------------------------------------
// 「周期」筛选：重复事件只显示"第一颗 + 周期"以内那几颗
// ---------------------------------------------------------------------------

/**
 * 一个重复事件最多往后显示多久（天）。用户设的就是这个数。
 * 未设 / 非法 / <1 → 不筛（保持原行为，绝不因为一个脏值把事件全藏起来）。
 */
export function periodDaysOf(ev) {
  const n = Number(ev && ev.periodDays);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * 按「周期」筛掉太远的重复实例 —— **规则 B：只留「第一颗 + 周期」以内的**。
 *
 * 用户原话："用户可选择一个周期（相当于**最新任务时间加周期等于实际显示时间**）：
 * 若泡泡为周级、每周一，周期为 3 天，一个任务还剩四天，原本会有俩泡泡
 * （剩四天和剩十一天），加周期后第二个就没了；周期改成 8 天又会出来。"
 *
 * ⚠️⚠️ 锚点是「**第一个未来的实例**」，不是「窗口内第一颗」—— 这条踩过，别改回去。
 *
 *   第一版把锚点写成"窗口内第一颗"，**后果是整个事件消失**：
 *   气泡区的展开窗口要往前看 180 天（`bubble.js` 的 LOOKBACK_DAYS），
 *   于是一个三个月前开始的每周事件，锚点落在三个月前，
 *   `锚点 + 3 天` 早于今天 → **所有实例都不满足条件 → 这个事件在气泡区整个不见**。
 *   而且它只在"事件开始得足够早"时才发作，很容易漏测。
 *
 *   现在的规则：
 *     · 过去的实例（start < now）→ **永远保留**。它们是欠账，攒着才警醒
 *       （和"未来只浮当前+预备两颗"是同一套思想）。
 *     · 未来的实例 → 以**最近的那颗**为锚，`start − 锚点 ≤ 周期` 才留。
 *   这样也和用户那句"最新任务时间加周期 = 显示上限"完全对上。
 *
 *   副作用是好的：锚点只由"现在"和"未来"决定，**和窗口起点无关**，
 *   所以气泡区、提醒、日历三处算出来的结果天然一致。
 *
 * @param {Array<{event:object,start:Date}>} items expandRange 的输出（已按时间排序）
 * @param {Date} [now] "现在"。测试里固定住才可断言
 * @returns {Array} 过滤后的数组（不修改入参）
 */
export function applyPeriodLimit(items, now = new Date()) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const nowMs = asDate(now).getTime();

  // 先给每个"设了周期的事件"定锚：它第一个**在未来**的实例
  const anchor = new Map();
  for (const it of items) {
    const ev = it.event || {};
    if (periodDaysOf(ev) == null) continue;
    const t = asDate(it.start).getTime();
    if (!Number.isFinite(t) || t < nowMs) continue;   // 过去的实例不参与定锚
    const cur = anchor.get(ev.id);
    if (cur == null || t < cur) anchor.set(ev.id, t);
  }
  if (!anchor.size) return items;                     // 没设周期 / 未来没有实例 → 不筛

  return items.filter((it) => {
    const ev = it.event || {};
    const days = periodDaysOf(ev);
    if (days == null) return true;                    // 没设周期 → 不筛
    const a = anchor.get(ev.id);
    if (a == null) return true;                       // 这个事件未来没有实例 → 不筛
    const t = asDate(it.start).getTime();
    if (!Number.isFinite(t)) return true;
    if (t < nowMs) return true;                       // 过去的实例（欠账）永远保留
    return t - a <= days * DAY_MS;
  });
}
