// 课程摘要提醒：按"天"汇总要上的课，在对人方便的时间点提醒。
//
// 用户需求（原话）：
//   「课程类这种周期类事件提前提醒，比如前一天晚上提醒第二天课程，早上提醒上午课程，
//     中午提醒下午课程，傍晚提醒晚上课程，当然，这些提醒只是一个笼统的人性化功能，
//     应当有一定的用户调整空间，比如具体何时提醒，要不要提醒」
//
// 这和已有的「按剩余时间分档提醒」是**两回事**：
//   · 分档提醒：每门课各算各的（1 小时前 / 30 分 / 10 分 / 准点…）—— 精确但吵
//   · 摘要提醒：一天只发几条，每条汇总一段时间内的所有课 —— 温和但粗略
// 两个都开着会重复轰炸，所以调用方那边有「逐条提醒课程」开关（默认关）。
//
// 为什么放 core/：纯函数、平台无关。桌面（server/store.js）、安卓（Store.kt 复刻同名逻辑）、
// 浏览器（页内轮询）三方共用同一套判定，避免"两端提醒时机不一样"。
//
// ⚠️ 安卓端 Store.kt 里有一份**必须保持一致的复刻**（见该文件 COURSE_DIGEST_SLOTS）。

/** 提醒时间过早/过晚都不发：`now` 超过槽位时间这么久就跳过（避免中午才收到"早上"的提醒）*/
export const DIGEST_FRESH_MS = 90 * 60_000;

/**
 * 槽位的默认配置。
 *
 * `window` 是「汇总哪段时间的课」（当天分钟数，start 含、end 不含）：
 *   · tonight → 汇总**明天**一整天，所以 window 不参与（见 targetDay）
 *   · morning → 05:00–12:00
 *   · noon    → 12:00–17:00
 *   · evening → 17:00–24:00
 */
export const DIGEST_SLOTS = [
  {
    key: 'tonight',
    label: '前一天晚上',
    hint: '提醒明天的课',
    defaultAt: '21:00',
    targetDay: 'tomorrow',
    window: [0, 24 * 60],
  },
  {
    key: 'morning',
    label: '早上',
    hint: '提醒今天上午的课',
    defaultAt: '07:30',
    targetDay: 'today',
    window: [5 * 60, 12 * 60],
  },
  {
    key: 'noon',
    label: '中午',
    hint: '提醒今天下午的课',
    defaultAt: '12:30',
    targetDay: 'today',
    window: [12 * 60, 17 * 60],
  },
  {
    key: 'evening',
    label: '傍晚',
    hint: '提醒今天晚上的课',
    defaultAt: '17:30',
    targetDay: 'today',
    window: [17 * 60, 24 * 60],
  },
];

/** 槽位默认配置 → 完整的 settings 片段 */
export function defaultDigestSettings() {
  return {
    enabled: false,               // 默认**关**：不改变用户现有行为，自己去设置里打开
    perCourseReminders: false,    // 逐条分档提醒默认关（摘要打开时只留摘要）
    slots: Object.fromEntries(DIGEST_SLOTS.map((s) => [
      s.key, { on: true, at: s.defaultAt },
    ])),
  };
}

/** 'HH:MM' → 当天的分钟数；非法给 null */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** 宽松读取用户设置，缺什么补什么（旧数据没有 courseDigest 也能跑） */
export function normalizeDigest(raw) {
  const def = defaultDigestSettings();
  if (!raw || typeof raw !== 'object') return def;
  const out = {
    enabled: raw.enabled === true,
    perCourseReminders: raw.perCourseReminders === true,
    slots: {},
  };
  for (const s of DIGEST_SLOTS) {
    const given = raw.slots && typeof raw.slots === 'object' ? raw.slots[s.key] : null;
    // ⚠️ 必须用 parseHHMM 而不是正则：`'25:99'` 格式合法但语义非法
    //    （25 点 99 分），只查格式会让它通过，然后在计算里算出一个荒唐的时刻。
    //    这条是单测抓出来的。
    const at = given && parseHHMM(given.at) !== null ? given.at : s.defaultAt;
    out.slots[s.key] = { on: !(given && given.on === false), at };
  }
  return out;
}

/** 当天 0 点 */
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * 一门课在某一天有没有课；有就返回**那天的开始时刻**（Date），否则 null。
 *
 * 只处理课表导入的形态：`type === 'course'` + `weeks[]` + `start` 里的时刻。
 * 复现 `server/scheduler.js` 的定位方式：学期第一周周一 + (周次-1)*7 + 星期偏移。
 *
 * ⚠️ 刻意不复用 `store.occurrencesIn` —— 那个函数自己 `store.load()` 读 termStart，
 * 是个隐式依赖，纯函数测试跑不了。这里 termStart 显式传进来。
 */
export function courseStartOn(ev, dayStart, termStart) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type !== 'course') return null;
  if (!Array.isArray(ev.weeks) || !ev.weeks.length) return null;
  if (!termStart) return null;

  const base = new Date(ev.start);
  if (Number.isNaN(base.getTime())) return null;

  const termMonday = startOfDay(new Date(`${termStart}T00:00:00`));
  if (Number.isNaN(termMonday.getTime())) return null;

  // 这一天是学期第几周（从 1 开始）
  const dow = dayStart.getDay();                 // 0=周日
  const offsetFromMonday = dow === 0 ? 6 : dow - 1;
  const dayMonday = new Date(dayStart);
  dayMonday.setDate(dayStart.getDate() - offsetFromMonday);
  const week = Math.round((startOfDay(dayMonday) - termMonday) / (7 * 86_400_000)) + 1;
  if (!ev.weeks.map(Number).includes(week)) return null;

  // 星期也要对得上（事件的 start 本身带了星期）
  const evDow = base.getDay();
  if (evDow !== dow) return null;

  const occ = new Date(dayStart);
  occ.setHours(base.getHours(), base.getMinutes(), 0, 0);
  return occ;
}

/** 某一天里、落在 [from,to) 分钟区间内的课程，按时间排序 */
export function coursesOnDay(events, dayStart, termStart, windowMin) {
  const out = [];
  for (const ev of events || []) {
    const at = courseStartOn(ev, dayStart, termStart);
    if (!at) continue;
    const min = at.getHours() * 60 + at.getMinutes();
    if (windowMin && (min < windowMin[0] || min >= windowMin[1])) continue;
    out.push({ ev, at });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 'HH:MM' */
function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 一条摘要的文字：标题 + 逐行列出课程 */
export function formatDigest(slot, items, dayLabel) {
  const title = `${dayLabel}${items.length} 门课`;
  const lines = items.map(({ ev, at }) => {
    const where = ev.location ? ` @${ev.location}` : '';
    return `${hhmm(at)} ${ev.title}${where}`;
  });
  return { title, body: lines.join('\n') };
}

/**
 * 现在该响哪些摘要。
 *
 * 判定（三个条件同时满足）：
 *   ① 该槽位开着，且 `now >= 槽位时间`（到了点）
 *   ② `now` 没有比槽位时间晚太多（`DIGEST_FRESH_MS`）—— 否则中午才打开应用，
 *      不该补发"今天早上"的提醒，那已经没用了
 *   ③ 目标窗口里还有**没开始的课**（都上完了就别提醒了）
 *
 * ⚠️ 条件 ② 是必须的。第一版只用了 ①：晚上 23:00 打开应用会补发当天所有的摘要
 *    （早上/中午/傍晚），一口气弹三条过时消息。实测过的坑。
 *
 * @returns {Array<{key, slot, title, body, at}>}
 */
export function dueDigests({ events, settings, now = new Date(), fired = new Set() } = {}) {
  const cfg = normalizeDigest(settings && settings.courseDigest);
  if (!cfg.enabled) return [];
  const termStart = (settings && settings.termStart) || '';
  if (!termStart) return [];   // 没有学期起点就定位不了周次

  const out = [];
  const nowMs = now.getTime();

  for (const s of DIGEST_SLOTS) {
    const slotCfg = cfg.slots[s.key];
    if (!slotCfg || !slotCfg.on) continue;
    const atMin = parseHHMM(slotCfg.at);
    if (atMin === null) continue;

    const dayStart = startOfDay(now);
    const slotMs = dayStart.getTime() + atMin * 60_000;
    if (nowMs < slotMs) continue;                        // 还没到点
    if (nowMs - slotMs > DIGEST_FRESH_MS) continue;      // 太晚了，别补发（条件②）

    // 目标日期
    const target = new Date(dayStart);
    const isTomorrow = s.targetDay === 'tomorrow';
    if (isTomorrow) target.setDate(target.getDate() + 1);

    const items = coursesOnDay(events, target, termStart, s.window);
    // 只留还没开始的（今天更早的课不管；明天的课全都"还没开始"）
    const upcoming = items.filter((x) => x.at.getTime() > nowMs);
    if (!upcoming.length) continue;                      // 条件③

    const dayKey = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    const key = `digest:${s.key}:${dayKey}`;
    if (fired.has(key)) continue;

    const dayLabel = isTomorrow
      ? '明天 '
      : (s.key === 'morning' ? '今天上午 ' : s.key === 'noon' ? '今天下午 ' : '今天晚上 ');
    const text = formatDigest(s, upcoming, dayLabel);
    out.push({
      key,
      slot: s.key,
      title: text.title,
      body: text.body,
      at: new Date(now),
      count: upcoming.length,
    });
  }

  return out;
}
