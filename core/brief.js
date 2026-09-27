// AI 助手第一期：**上下文注入 + 今日简报 + 周复盘**（全是"读"，不写数据）。
//
// 用户原话（本轮）：
//   "这些新加入的功能我要可关可开，不要时就不要"
//   （简报）"能不带 AI 也出"
//
// 所以本模块的三条底线，写在文件头，改动时别越过：
//
// ① **每个功能单独开关，默认全关**（见 AI_FEATURES / aiFeatureIsOn）。
//    没打开就**不许有任何行为**：不发请求、不往界面塞卡片、不改任何现有输出。
//    默认关还有一层原因：简报是"主动说话"的功能，猜错一次用户就想关掉它，
//    所以"用户明确打开"是它唯一的启动方式。
//
// ② **离线必须有内容**（composeOfflineBrief）。AI 只是"更好看"，不是"没它不行"。
//    用户的原话是"能不带 AI 也出" —— 所以离线版要真的有用（点名最紧的那件、
//    把逾期的列出来、给一句**有依据的**建议），而不是"今天有 3 件事"这种废话。
//
// ③ **绝不把整库喂给 AI**（scheduleContext）。
//    只取"今天 + 未来 N 天（默认 7）+ 逾期未完成 + 今天/明天有课"，
//    压缩成**人类读的短文本**，且有总长度上限（超了截断并把 truncated 置真）。
//    这条不只是省钱：整库喂进去，模型会把三个月后的事和今天的事混着说，
//    出来的简报反而不能用。
//
// 平台无关（不碰 node: / window / document / Buffer / fetch / localStorage），
// 见 tools/core.test.mjs。
//
// ⚠️ 全程**不许 Math.random / Date.now**：同输入必须逐字节可复现。
//    理由同 greetings.js —— 指纹（fingerprint）和"重开一次界面结果一样"都靠它。

import { coursesOnDay } from './course-digest.js';
import { greetingFingerprint, stripCliches } from './greetings.js';
import { rankOf } from './level.js';
import { asDate, dayDiff, startOfDay, toDateKey } from './time.js';

// ---------------------------------------------------------------------------
// 开关登记表
// ---------------------------------------------------------------------------

/**
 * 每个新功能一条，**默认全部关闭**。
 *
 * `needsAi` 的作用是给界面/调用方一个判据：
 *   · `needsAi:false` 的功能（今日简报/周复盘）→ 离线模板就能出，AI 只是让它更好看
 *   · `needsAi:true` 的功能（上下文注入 / 让 AI 了解这个 App 与你的历史）→ 没配 AI 就没有
 *     任何意义，必须整块关掉（"让 AI 看得见你的日程"在没配 AI 时打开只会让人以为
 *     在偷偷上传数据）
 *
 * ⚠️ `key` 是**存储键**，改了等于用户之前的选择全部丢失，不要改。
 * ⚠️ 这张表必须与 `aiFeatureDefaults()` 一致（测试会对着断言）。
 */
export const AI_FEATURES = [
  {
    key: 'todayBrief',
    label: '今日简报',
    desc: '每天早上一条：今天有什么、最紧的是哪件',
    defaultOn: false,
    needsAi: false,
  },
  {
    key: 'weeklyReview',
    label: '周复盘',
    desc: '每周日一条：完成情况、哪些一直在拖',
    defaultOn: false,
    needsAi: false,
  },
  {
    key: 'contextInjection',
    label: '把日程喂给 AI',
    desc: '让 AI 看得见你今天/本周的安排（不喂整库）',
    defaultOn: false,
    needsAi: true,
  },
  {
    // 「让 AI 了解这个 App 与你的历史」（第 52 轮）。
    //
    // ⚠️ 本项**默认关**，而且比上面三项更该默认关：它外发的不只是"今天有什么"，
    //    还有这个程序自己的术语和你**过去**的完成/改期/逾期/提醒/AI 记录。
    //    摘要里没有好友名单、没有关键词/备注/私信内容（见 core/activity-log.js 的
    //    字段白名单），但"只喂摘要"这件事必须由用户点头：
    //    开关关着时 `canFeed` 一律 false、`activityForFeed` 连遍历都不做。
    //
    // ⚠️ 它和 `settings.activitySettings.enabled` **不是一回事，别合并**：
    //      · `activitySettings.enabled` 管"**本地记不记**"（记在自己设备上）；
    //      · 本开关管"**记下来的摘要喂不喂给 AI**"（会离开这台设备）。
    //    两个方向的组合都有意义：只想自己留个记录（记录开、本项关），
    //    或者两者都开。core/ai-context.js 的 canFeed 只看本开关。
    key: 'assistantMemory',
    label: '让 AI 了解这个 App 与你的历史',
    desc: '把这个程序的术语、以及你的完成/推迟/提醒/AI 记录压成摘要喂给它（只喂摘要，好友名单永不外发）',
    defaultOn: false,
    needsAi: true,
  },
];

/** 功能 key → 登记项（内部用，避免每次遍历数组） */
const FEATURE_BY_KEY = new Map(AI_FEATURES.map((f) => [f.key, f]));

/**
 * 存进 `settings.aiFeatures` 的缺省值：
 * `{todayBrief:false, weeklyReview:false, contextInjection:false, assistantMemory:false}`。
 *
 * ⚠️ 必须是**普通对象**（不能带 `enabled` 这类包裹层）：`core/defaults.js` 的
 *    `mergeDefaults` 是逐字段深合并的，形状越平，"老库补字段"越不容易出岔子。
 *    而且 `mergeDefaults` 只补**缺的键** —— 用户开过又关掉的功能（显式 false）
 *    不会被缺省值顶回 true。这正是我们要的。
 */
export function aiFeatureDefaults() {
  const out = {};
  for (const f of AI_FEATURES) out[f.key] = f.defaultOn === true;
  return out;
}

/**
 * 这个功能开着吗？
 *
 * ⚠️ **脏数据/缺字段一律按 defaultOn 处理**（也就是一律 false）。设置是用户能亲手
 *    改坏的东西（导入了旧备份、手改了 db.json、同步过来半个对象），而这里是
 *    "要不要主动说话/要不要往外发数据"的总闸 —— 读不出来时**必须当成关**。
 *    反过来（读不出来当成开）会让用户遇到"我明明关了它还在推"。
 *
 * 兼容两种写法（两种都认，见 `readFeatureConfig`）：
 *   · `aiFeatures: { todayBrief: true }`            ← 推荐的扁平写法
 *   · `aiFeatures: { todayBrief: { enabled: true } }` ← 带零配置的写法
 */
export function aiFeatureIsOn(settings, key) {
  const entry = FEATURE_BY_KEY.get(String(key == null ? '' : key));
  if (!entry) return false;                     // 未知 key → 当作关（不是抛错）
  const cfg = readFeatureConfig(settings && settings.aiFeatures);
  return cfg[entry.key] === true;
}

/**
 * 读 `settings.aiFeatures`，归一化成一个干净的对象。
 *
 * ⚠️ 三种脏值都要能扛（测试里有）：
 *   · `null` / `undefined` / 字符串 / 数组 → 整块当空对象
 *   · 未知 key（"aiFeatures: { foo: true }"）→ **忽略**，绝不写进结果
 *     （否则会被当成"用户开过一个我不知道的功能"，将来改名时更难查）
 *   · 值不是布尔 → 只认 `true`（`1` / `'true'` 不当成开：设置里出现字符串
 *     往往意味着数据被别的东西改过，这时保守一点）
 */
export function readFeatureConfig(raw) {
  const out = {};
  for (const f of AI_FEATURES) out[f.key] = f.defaultOn === true;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const f of AI_FEATURES) {
    const v = raw[f.key];
    if (v === true) out[f.key] = true;
    else if (v === false) out[f.key] = false;
    else if (v && typeof v === 'object' && !Array.isArray(v) && v.enabled === true) out[f.key] = true;
  }
  return out;
}

/** 「到点没到点」的钟点（可以塞进 `aiFeatures` 一起存，也可以单独存） */
const DEFAULT_DAILY_HOUR = 8;    // 今日简报：早上 8 点
const DEFAULT_WEEKLY_HOUR = 20;  // 周复盘：周日晚上 8 点
const DEFAULT_WEEKLY_DOW = 0;    // 0 = 周日

/** 取出一个合法的"钟点"（0–23 的整数），脏值落回缺省 */
function hourOf(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(23, Math.max(0, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// 上下文注入：把"今天 + 未来 N 天 + 逾期 + 今天的课"压成短文本
// ---------------------------------------------------------------------------

/** 只给"今天/明天有课"这种粒度，别把整学期课表铺开 */
const MAX_COURSE_DAYS = 2;

/** 默认看未来几天（用户可改，但要夹住：太小会漏事，太大会变成喂整库） */
export const DEFAULT_CONTEXT_DAYS = 7;
const MIN_CONTEXT_DAYS = 1;
const MAX_CONTEXT_DAYS = 31;

/** `scheduleContext` 的默认总长度上限（字符）。超了截断 + `truncated:true` */
export const DEFAULT_CONTEXT_CHARS = 1200;
const MIN_CONTEXT_CHARS = 200;

/** 等级 → 中文（简报里说"这是件大事"，比甩一个 'amber' 有用） */
const LEVEL_LABEL = { red: '重大', amber: '大', emerald: '中', sky: '小' };

/**
 * 从 `settings` 里挑出这个模块要用的几项，**脏值全部落回缺省**。
 * （`updateSettings` 是浅合并，老库里 `aiFeatures` 可能整个不存在。）
 */
function contextOpts(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const s = (o.settings && typeof o.settings === 'object') ? o.settings : {};
  const daysRaw = Number(o.days);
  const days = Number.isFinite(daysRaw)
    ? Math.min(MAX_CONTEXT_DAYS, Math.max(MIN_CONTEXT_DAYS, Math.floor(daysRaw)))
    : DEFAULT_CONTEXT_DAYS;
  const charsRaw = Number(o.maxChars);
  const maxChars = Number.isFinite(charsRaw)
    ? Math.max(MIN_CONTEXT_CHARS, Math.floor(charsRaw))
    : DEFAULT_CONTEXT_CHARS;
  return {
    days,
    maxChars,
    // ⚠️ 课表定位**必须**有 termStart（见 core/course-digest.js 的 courseStartOn）：
    //    没有它就算不出"第几周"，硬算会把课摆到错误的日期上。
    termStart: typeof s.termStart === 'string' ? s.termStart : '',
    // 要不要把"今天"单独成段。默认要。
    includeToday: o.includeToday !== false,
    includeCourses: o.includeCourses !== false,
    // 节次表（第 1 节几点开始）——只在"没有 termStart、退回按星期匹配"那条路上用到
    sectionTimes: Array.isArray(s.sectionTimes) ? s.sectionTimes : [],
  };
}

/** 事件的到期时刻（毫秒）：`deadline > end > start`，与 core/state-ops.js 的方案 C 一致 */
function deadlineMs(ev) {
  const raw = ev && (ev.deadline || ev.end || ev.start);
  const t = raw == null ? NaN : asDate(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 标题：截短 + 去掉换行（它要进"一行一条"的文本里） */
function titleOf(ev) {
  const raw = ev && (ev.title != null ? ev.title : (ev.name != null ? ev.name : ev.summary));
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** 一个人的"还剩多久"（简报里必须说人话：不说"剩余 3600000 毫秒"） */
function remainText(ms) {
  if (ms == null) return '没有期限';
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  if (abs < 60 * 60_000) {
    if (ms >= 0) return `还剩 ${Math.max(1, mins)} 分钟`;
    return `逾期 ${Math.max(1, mins)} 分钟`;
  }
  const hours = Math.round(abs / 3_600_000);
  if (abs < 86_400_000) {
    if (ms >= 0) return `还剩 ${hours} 小时`;
    return `逾期 ${hours} 小时`;
  }
  const days = Math.round(abs / 86_400_000);
  if (ms >= 0) return `还剩 ${days} 天`;
  return `逾期 ${days} 天`;
}

/** 'HH:MM' */
function hhmm(d) {
  const x = asDate(d);
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}

/**
 * 事件的 `start` 解析成毫秒；解析不出来给 null。
 * ⚠️ 解析不出来的**不丢**：它可能是一条"待办"（没填时间）。丢掉会静默少一件事
 *    （"我的日程怎么没进简报"），所以调用方按"待办"单独处理。
 */
function startMsOf(ev) {
  const t = ev && ev.start != null ? asDate(ev.start).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** 未来泡泡（`future:true`）在"出现日期"之前不该出现在简报里（与气泡区同一套语义） */
function notYetVisible(ev, nowMs) {
  if (!ev || ev.future !== true) return false;
  const t = startMsOf(ev);
  return t != null && t > nowMs;
}

/**
 * 一条时间线条目（**只挑展示要用的字段**）。
 *
 * ⚠️⚠️ 这里是"不许出现内部字段"的执行点（`parentId` / `rev` / `updatedAt` /
 *    `recycle` / `popped` …一个都不许进）。做法不是"过滤掉某些名字"（黑名单永远
 *    漏），而是**白名单构造**：新对象里只有下面这些键，原对象上有什么都不影响。
 *    这条测试会断言（见 tools/brief.test.mjs 的"不含内部字段"）。
 */
function eventItem(ev, nowMs) {
  const startMs = startMsOf(ev);
  const dl = deadlineMs(ev);
  const overdue = dl != null && dl - nowMs <= 0;
  const level = typeof ev.level === 'string' ? ev.level : '';
  return {
    id: ev.id == null ? '' : String(ev.id),
    title: titleOf(ev),
    type: ev.type == null ? '' : String(ev.type),
    level,
    levelLabel: LEVEL_LABEL[level] || '',
    startMs,
    time: startMs == null ? '' : hhmm(new Date(startMs)),
    day: startMs == null ? '' : toDateKey(new Date(startMs)),
    deadlineMs: dl,
    remainingMs: dl == null ? null : dl - nowMs,
    overdue,
    done: ev.done === true,
    location: ev.location == null ? '' : String(ev.location).slice(0, 20),
  };
}

/**
 * 从**课程记录**（`courses` 表）里找出某一天要上的课。
 *
 * 课程的形状来自 core/scheduler-import.js：
 *   `{key, title, dayOfWeek, sections:[1,2], weeks:[1..16], location, teacher, level}`
 * 所以这里有**两条**定位路径，缺一不可：
 *   ① 有 `termStart` 且记录带 `weeks` → 用 core/course-digest.js 的
 *      `coursesOnDay`（能正确判断"这周有没有这门课"，是**首选**）
 *   ② 没有 `termStart`（或记录没有 weeks）→ 退回按 `dayOfWeek` 匹配。
 *      ⚠️ 这一条是必须的：新建的库、用户还没填学期起点时，走 ① 一门课都认不出来，
 *      简报会**静默地少说"今天有课"** —— 而"今天有课"正是简报最该说的事之一。
 *      退回路径只知道"今天有这门课"，不知道"这周到底上不上"，所以：
 *        · 时间能算就算（有 `sectionTimes` 时取该节次的开始时刻），算不出就不写时间
 *        · **不写教室**（没算出来就别硬说）
 *
 * 两条来源（课程记录 + `events` 里 `type==='course'` 的副产物）都收，
 * 按"标题 + 时间"去重 —— 去重键刻意**不用 id**（两边 id 生成方式不同），
 * 否则同一节课会因为来源不同在简报里出现两次（用户一眼看出是 bug）。
 */
function coursesOn(day, courses, termStart, fallbackEvents, sectionTimes) {
  const out = [];
  const seen = new Set();
  const dayStart = startOfDay(day);
  const push = (at, title, location) => {
    const time = at ? hhmm(at) : '';
    const key = `${String(title)}@${time}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      title: titleOf({ title }),
      time,
      atMs: at ? asDate(at).getTime() : null,
      location: location == null ? '' : String(location).slice(0, 20),
    });
  };

  if (Array.isArray(courses) && courses.length) {
    if (termStart) {
      for (const { ev, at } of coursesOnDay(courses, dayStart, termStart, null)) push(at, ev.title, ev.location);
    }
    // 兜底：按 dayOfWeek 匹配（见上面 ②）
    if (!out.length) {
      for (const c of courses) {
        const dow = Number(c && c.dayOfWeek);
        if (!Number.isFinite(dow) || dow !== dayStart.getDay()) continue;
        push(slotStart(dayStart, c, sectionTimes), c && c.title, '');
      }
    }
  }
  // 还没有课程记录（或算不出周次）时，退回扫 events 里那两天的课 ——
  // 至少"今天有课"这件事不会因为数据来源不同就消失。
  if (!out.length && Array.isArray(fallbackEvents)) {
    const from = dayStart.getTime();
    const to = from + 86_400_000 - 1;
    for (const ev of fallbackEvents) {
      if (!ev || ev.type !== 'course') continue;
      const t = startMsOf(ev);
      if (t == null || t < from || t > to) continue;
      push(new Date(t), ev.title, ev.location);
    }
  }
  out.sort((a, b) => (a.atMs == null ? 0 : a.atMs) - (b.atMs == null ? 0 : b.atMs));
  return out;
}

/** 这门课那天第一节的开始时刻（Date）；查不到给 null（**不写时间是允许的**） */
function slotStart(day, course, sectionTimes) {
  if (!Array.isArray(sectionTimes) || !sectionTimes.length) return null;
  const sections = Array.isArray(course.sections) ? course.sections.map(Number) : [];
  const first = sections.find((n) => Number.isFinite(n));
  if (first == null) return null;
  const slot = sectionTimes.find((s) => Number(s && s.index) === first);
  const hhmmRaw = slot && typeof slot.start === 'string' ? slot.start : null;
  const m = hhmmRaw && /^(\d{1,2}):(\d{2})$/.exec(hhmmRaw.trim());
  if (!m) return null;
  const at = new Date(day);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return at;
}

/**
 * 压缩成"一行一条"的人类文本。
 *
 * 排布顺序是**故意的**（越靠前越该看）：
 *   概要 → 今天 → 接下来 → 逾期 → 今明两天有课
 * 逾期排在"接下来"后面，因为它是欠账不是今天的安排（但一定要有）。
 *
 * @returns {{text:string, truncated:boolean}}
 */
function renderContextText({ today, timeline, overdue, coursesToday, coursesTomorrow }, now, maxChars) {
  const lines = [];
  const dayLabel = (d) => (dayDiff(now, d) === 0 ? '今天' : d.getMonth() + 1 + '月' + d.getDate() + '日');

  lines.push(`【概要】今天 ${today.length} 件；逾期未完成 ${overdue.length} 件；今明 ${coursesToday.length + coursesTomorrow.length} 门课`);

  const fmt = (it, tail) => `${it.time} ${it.title}${it.levelLabel ? ` · ${it.levelLabel}` : ''} · ${tail}`;

  if (today.length) {
    lines.push('');
    lines.push(`【今天（${today.length} 件）】`);
    for (const it of today) lines.push(`- ${fmt(it, it.done ? '已完成' : remainText(it.remainingMs))}`);
  }

  const upcoming = timeline.filter((it) => !today.some((t) => t.id && t.id === it.id && it.id !== ''));
  if (upcoming.length) {
    lines.push('');
    lines.push('【接下来】');
    let curDay = '';
    for (const it of upcoming) {
      const d = dayLabel(new Date(it.startMs));
      if (d !== curDay) {
        curDay = d;
        lines.push(`${d}：`);
      }
      lines.push(`- ${fmt(it, remainText(it.remainingMs))}`);
    }
  }

  if (overdue.length) {
    lines.push('');
    lines.push(`【逾期未完成（${overdue.length} 件）】`);
    // 逾期这行**不再重复日期**：上面已经统一是"逾期 N 天"，
    // 再来一次"2026-09-10 10:00"会变成"2026-09-10 10:00 … 逾期 15 天"（同一条信息说两遍）
    for (const it of overdue) lines.push(`- ${it.title} · ${it.levelLabel || '未分级'} · ${remainText(it.remainingMs)}`);
  }

  const courseLine = (label, list) => {
    if (!list.length) return;
    lines.push(`${label}有课（${list.length} 门）：${list.map((c) => `${c.time} ${c.title}`).join('；')}`);
  };
  if (coursesToday.length || coursesTomorrow.length) {
    lines.push('');
    lines.push('【课】');
    courseLine('今天', coursesToday);
    courseLine('明天', coursesTomorrow);
  }

  return clampLines(lines, maxChars);
}

/**
 * 按**行**截断（不是字符串硬切）。
 *
 * ⚠️ 硬切会把最后一行切成半句话（"08:00 数据结构作"）——用户看到的是一段乱码，
 *    比少一条还糟。所以：能整行放就整行放，放不下就丢掉这一行并说明还剩几条；
 *    单行本身超限（标题特别长）时才退化成硬切 + 省略号。
 */
function clampLines(lines, maxChars) {
  const all = lines.join('\n').trim();
  if (all.length <= maxChars) return { text: all, truncated: false };
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = (kept.length ? 1 : 0) + line.length;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  while (kept.length && !kept[kept.length - 1].startsWith('-')) kept.pop();
  const dropped = lines.length - kept.length;
  let text = kept.join('\n');
  if (dropped <= 0) text = all.slice(0, maxChars - 1) + '…';
  else text = `${text}\n…（还有 ${dropped} 行没放下）`;
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  return { text, truncated: true };
}

/**
 * **这一期的核心**：把日程压成"够 AI（和我）看懂今天/本周"的上下文。
 *
 * 返回 `{text, items, stats, truncated}`。
 *
 * 硬要求（都对应用户原话）：
 *   · **绝不把整库塞进去**：只取今天 + 未来 `opts.days`（默认 7）天 + 逾期未完成
 *     + 今天/明天有课。三个月后的事**不出现**（测试断言）。
 *   · 一行一条，**有总长度上限**（`opts.maxChars`，默认 1200），超了截断 + `truncated:true`。
 *   · **不许出现内部字段**（`parentId`/`rev`/`updatedAt`/`recycle`/`popped`…）——
 *     靠"白名单构造"保证，不靠黑名单过滤。
 *   · 课程只给"今天/明天有课"这种粒度。
 *
 * `items` 的形状（展示用的字段，没有一个是内部的）：
 *   `{id, title, type, level, levelLabel, startMs, time, day, deadlineMs, remainingMs, overdue, done, location}`
 *
 * `stats`：`{today, overdue, weekDone, tightest, coursesToday, coursesTomorrow, totals}`
 *   · `tightest` = **最紧的那一件**（等级高优先，同级看剩余时间）：`{title, level, remainingMs, text}`
 *   · `weekDone` = 本周（周一起）已完成几件
 *
 * @param {{events?:Array, courses?:Array, now?:Date|string|number, opts?:object}} args
 */
export function scheduleContext({ events, courses, now, opts } = {}) {
  const o = contextOpts(opts);
  const nowDate = asDate(now == null ? new Date() : now);
  const nowMs = Number.isFinite(nowDate.getTime()) ? nowDate.getTime() : new Date().getTime();
  const nowD = new Date(nowMs);
  const today0 = startOfDay(nowD);

  const allEvents = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const allCourses = Array.isArray(courses) ? courses.filter((c) => c && typeof c === 'object') : [];

  // 未来 N 天的右端（含当天结束）
  const windowEnd = new Date(today0);
  windowEnd.setDate(windowEnd.getDate() + o.days);
  const windowEndMs = windowEnd.getTime() + 86_400_000 - 1;
  const todayEndMs = today0.getTime() + 86_400_000 - 1;
  // 本周一 0 点（周复盘要用"本周完成了几件"）
  const weekStart = startOfDay(nowD);
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() === 0 ? 6 : weekStart.getDay() - 1));
  const weekStartMs = weekStart.getTime();

  const today = [];
  const timeline = [];
  const overdue = [];
  let weekDone = 0;
  let upcomingCount = 0;
  let total = 0;

  for (const ev of allEvents) {
    // 虚拟节日事件（气泡区的节日装饰）不是"我的事"，不进简报
    if (ev.festival === true) continue;
    const startMs = startMsOf(ev);
    const dl = deadlineMs(ev);
    const done = ev.done === true;

    // ---- 本周完成了几件（独立的账，和时间线窗口无关）----
    if (done) {
      const doneMs = dl != null ? dl : startMs;
      if (doneMs != null && doneMs >= weekStartMs && doneMs <= nowMs) weekDone += 1;
    }

    if (notYetVisible(ev, nowMs)) continue;   // 未来泡泡：还没"出现"

    if (dl != null && dl - nowMs <= 0 && !done) {
      total += 1;
      overdue.push(eventItem(ev, nowMs));
      continue;                                // 逾期的不再进时间线（它会重复出现）
    }
    if (startMs == null) continue;             // 没时间的待办：不进时间线（但没被丢掉，见注释）
    if (startMs < today0.getTime()) continue;  // 昨天以前开始的未完事项：那是逾期那条账的事
    if (done) continue;                        // 已完成的不进"今天/接下来"
    if (startMs > windowEndMs) continue;       // ⚠️ 未来 N 天之外：**绝不出现**（不许喂整库）
    total += 1;
    upcomingCount += 1;
    const it = eventItem(ev, nowMs);
    if (startMs <= todayEndMs) today.push(it);
    else timeline.push(it);
  }

  const byTime = (a, b) => (a.startMs - b.startMs) || a.title.localeCompare(b.title);
  today.sort(byTime);
  timeline.sort(byTime);
  overdue.sort((a, b) => (a.remainingMs - b.remainingMs) || a.title.localeCompare(b.title));

  const coursesToday = o.includeCourses
    ? coursesOn(nowD, allCourses, o.termStart, allEvents, o.sectionTimes) : [];
  let coursesTomorrow = [];
  if (o.includeCourses && MAX_COURSE_DAYS > 1) {
    const tmr = new Date(today0);
    tmr.setDate(tmr.getDate() + 1);
    coursesTomorrow = coursesOn(tmr, allCourses, o.termStart, allEvents, o.sectionTimes);
  }

  // **最紧的那一件**：先看等级（重大 > 大 > 中 > 小），同级看剩余时间。
  // 逾期的一律排在前面（它已经过点了，不管什么等级都该先提）。
  const ranked = [...overdue, ...today, ...timeline];
  let tightest = null;
  for (const it of ranked) {
    if (!tightest) { tightest = it; continue; }
    const a = it.overdue ? 1 : 0;
    const b = tightest.overdue ? 1 : 0;
    if (a !== b) { if (a > b) tightest = it; continue; }
    const ra = rankOf(it.level);
    const rb = rankOf(tightest.level);
    if (ra !== rb) { if (ra > rb) tightest = it; continue; }
    const ma = it.remainingMs == null ? Number.POSITIVE_INFINITY : it.remainingMs;
    const mb = tightest.remainingMs == null ? Number.POSITIVE_INFINITY : tightest.remainingMs;
    if (ma < mb) tightest = it;
  }

  const rendered = renderContextText(
    {
      today: o.includeToday ? today : [],
      timeline,
      overdue,
      coursesToday,
      coursesTomorrow,
    },
    nowD,
    o.maxChars,
  );

  const items = [...today, ...timeline, ...overdue];
  // 「像是一直在往后拖的」也一并算好带上：离线简报要用它，界面也可能要单独显示。
  // 这里传的是**原始事件**（检测需要 createdAt/updatedAt，items 里刻意没有这些）。
  const postponed = detectChronicallyPostponed(allEvents, { now: nowD });

  return {
    text: rendered.text,
    items,
    postponed,
    stats: {
      today: today.length,
      overdue: overdue.length,
      weekDone,
      tightest: tightest
        ? {
          title: tightest.title,
          level: tightest.level,
          remainingMs: tightest.remainingMs,
          overdue: tightest.overdue,
          text: remainText(tightest.remainingMs),
        }
        : null,
      coursesToday: coursesToday.length,
      coursesTomorrow: coursesTomorrow.length,
      totals: { upcoming: upcomingCount, overdue: overdue.length, scanned: allEvents.length, inWindow: total },
    },
    truncated: rendered.truncated,
    days: o.days,
  };
}

// ---------------------------------------------------------------------------
// 「反复被推迟的事」
// ---------------------------------------------------------------------------

/**
 * 找出"反复被推迟"的事。
 *
 * ⚠️⚠️ **先说清楚这个近似的局限（诚实比好看重要）**：
 *
 *   我去翻过事件模型（core/defaults.js 的事件形状、core/state-ops.js 的 upsertEvent、
 *   core/recurrence.js），**没有任何"改期次数/改期历史"字段** ——
 *   `upsertEvent` 的 base 是逐字段列举的，里头只有 `createdAt` / `updatedAt`
 *   两个时间戳，没有 deadline 的变更历史（旧值一覆盖就没了）。
 *
 *   所以**这里没有"推迟了 N 次"这种数**，也不许造一个出来（那是编数据）。
 *   能诚实推出来的信号只有两个：
 *
 *     ① `modified`（强一些）：`updatedAt > createdAt` —— 这条**确实被改过一次以上**，
 *        但**改了哪里不知道**（可能只是改了个错别字、改了颜色）。配合
 *        "到期时间还在未来"（说明它一直没被划掉），才勉强算是"动过、但没往前走"。
 *        所以它只是**弱证据**，不是"推迟次数"。
 *     ② `overdue`（最弱）：已经过点了还没完成。这连"改过"都不一定 —— 
 *        可能只是没人管它。它列出来的价值是"这条拖了很久"，**别当推迟次数看**。
 *
 *   想真正做准，需要给事件加"截止时间变更历史"（下一轮可以加一条
 *   `deadlineHistory: [{at, from, to}]`，那时这个函数就能给出真数字）。
 *   在那之前，这个函数**只回答"哪几件像是在被一直往后拖"**，不回答"拖了几次"。
 *
 * 判定（`minDays` 默认 7，即"至少放了这么久还没动"）：
 *   · 跳过已完成 / 已戳破 / 虚拟节日事件 / 未来泡泡（还没出现的不算拖）
 *   · 没有截止时间的事件**不算**（连"什么时候该做完"都没有，谈不上推迟）
 *   · 信号①：`updatedAt - createdAt >= 1 天`（确实被改过），且**距上次改动 ≥ minDays 天**，
 *     且截止时间仍在未来 → `reason:'modified'`（置信度低，但至少有证据）
 *   · 信号②：截止时间已过 ≥ minDays 天且未完成 → `reason:'overdue'`（最弱）
 *
 * 返回 `[{id, title, level, days, reason, dueAt, editedAt, confidence}]`，
 * 按"更有证据 → 放得更久"排序。**没有 `postponeCount` 这种字段。**
 *
 * @param {Array} events
 * @param {{now?:Date|string|number, minDays?:number}} opts
 */
export function detectChronicallyPostponed(events, { now, minDays } = {}) {
  const nowD = asDate(now == null ? new Date() : now);
  const nowMs = Number.isFinite(nowD.getTime()) ? nowD.getTime() : new Date().getTime();
  const minRaw = Number(minDays);
  const min = Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : 7;
  const minMs = min * 86_400_000;
  const list = Array.isArray(events) ? events : [];
  const out = [];

  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.festival === true) continue;
    if (ev.done === true) continue;                 // 完成了就不是"一直拖"
    if (notYetVisible(ev, nowMs)) continue;
    const dl = deadlineMs(ev);
    if (dl == null) continue;                       // 没期限 → 谈不上"推迟"

    const createdMs = tsOf(ev.createdAt);
    const updatedMs = tsOf(ev.updatedAt);
    const edited = createdMs != null && updatedMs != null && (updatedMs - createdMs) >= 86_400_000;
    const idleMs = updatedMs != null ? nowMs - updatedMs : null;

    // ① 改过、但很久没动，且到期时间还在未来
    if (edited && idleMs != null && idleMs >= minMs && dl > nowMs) {
      out.push(record(ev, nowMs, Math.floor(idleMs / 86_400_000), 'modified', dl, updatedMs, 'low'));
      continue;
    }
    // ② 早就过点了还没完成（最弱的信号）
    const lateMs = nowMs - dl;
    if (lateMs >= minMs) {
      out.push(record(ev, nowMs, Math.floor(lateMs / 86_400_000), 'overdue', dl, updatedMs, 'lowest'));
    }
  }

  out.sort((a, b) => (a.reason === b.reason ? b.days - a.days : a.reason === 'modified' ? -1 : 1));
  return out;
}

/** 时间戳（毫秒）；解析不出来给 null（**不要**用 0 冒充，否则会算出"放了 50 年"） */
function tsOf(v) {
  if (v == null || v === '') return null;
  const t = asDate(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function record(ev, nowMs, days, reason, dueAt, editedAt, confidence) {
  return {
    id: ev.id == null ? '' : String(ev.id),
    title: titleOf(ev),
    level: typeof ev.level === 'string' ? ev.level : '',
    days,
    reason,
    confidence,
    // ⚠️ 这里刻意**没有** postponeCount：模型里没有这个事实，不许造。
    dueAt: dueAt == null ? null : new Date(dueAt).toISOString(),
    editedAt: editedAt == null ? null : new Date(editedAt).toISOString(),
    remainingMs: dueAt == null ? null : dueAt - nowMs,
  };
}

// ---------------------------------------------------------------------------
// 两套提示词
// ---------------------------------------------------------------------------

/**
 * ⚠️⚠️ `system` 必须是**常量**，一个字都不能随 kind / 日程 / 时间变。
 *
 *    原因和 core/greetings.js 的 SYSTEM_PROMPT 完全一样，而且是**钱**：
 *    OpenAI 兼容接口的 prompt 缓存只对"前缀完全一致"的请求命中，命中与不命中的
 *    价差是 **50 倍**。简报是**每天/每周都发**的功能，system 里掺一个变量
 *    （哪怕只是"今天"两个字），缓存就永远不命中，账单月底才看得出来。
 *
 *    所以：**所有变量都进 user**（今天的日程、用户画像、kind 的差别全在 user 里）。
 *    这里的"180 字以内"是**写死的常量**，不要改成按 kind 变 —— 一变缓存就废。
 *    测试会断言"不同输入下 system 完全一致"。
 */
const SYSTEM_PROMPT = [
  '你是一个替人写日程简报的助手。简报会直接显示在用户自己的日程应用里，他每天看这一条。',
  '',
  '硬性规则（违反任何一条即视为失败）：',
  '1. 只输出简报正文。不要解释、不要标题、不要 Markdown 标记、不要引号包住整段、不要 emoji 堆砌（最多一个）。',
  '2. 不要出现"AI""人工智能""生成""模板""提示词""作为一个…""根据您提供的"这类自我暴露的字眼。',
  '3. 不要使用这些套话：阖家欢乐、万事如意、心想事成、幸福安康、吉祥如意、大吉大利、步步高升、财源广进、一帆风顺、岁岁平安。',
  '4. **严禁编造**：日程里没写的事、没说过的安排、没提到的数字，都不许自己造。上下文里没有的事就不提。',
  '5. 不要复述上下文里的清单（用户自己能看见）。要说的是"所以今天该先干什么"。',
  '6. 中文，口语化，像同一个人在自己心里过一遍今天的事，不要播音腔。',
  '7. 长度：180 字以内，可以分 2–4 行；不要用编号列表。',
  '8. 有逾期/快到期的事，要点名说清楚；确实没有要紧事就老实说没什么事，不要硬凑。',
  '9. 不要在正文里写日期之外的元信息（比如"本周完成率"这种统计口吻），要说成人话。',
].join('\n');

/**
 * 把用户画像压成几行（复用 `settings.greetingProfile` 那一套：owner / style / keywords）。
 * ⚠️ 画像里可能有很长的自由文本，一律截短 —— prompt 是**按 token 付费**的。
 */
function profileLines(profile) {
  const p = (profile && typeof profile === 'object') ? profile : {};
  const lines = [];
  const owner = textOf(p.owner, 40);
  const style = textOf(p.style, 120);
  const kws = normalizeKw(p.keywords).slice(0, 12);
  if (owner) lines.push(`【我是谁】${owner}`);
  if (style) lines.push(`【我平时说话的风格】${style}`);
  if (kws.length) lines.push(`【我关心的事】${kws.join('、')}`);
  return lines;
}

function textOf(v, max = 80) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function normalizeKw(raw) {
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(/[,，、\s]+/) : []);
  const out = [];
  for (const x of arr) {
    const s = textOf(x, 8);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 构造一次简报生成请求。返回 `{system, user, maxTokens, temperature}`。
 *
 * `kind`：`'today'`（今日简报）| `'weekly'`（周复盘）。
 * ⚠️ kind 的差别**只进 user**（见 SYSTEM_PROMPT 的说明）。两条要求也不一样：
 *    今日简报要"先干什么"，周复盘要"完成情况 + 哪些一直在拖"。
 *
 * `previousTexts`：**最近几次的简报正文**。为什么要带上：不带的话模型每天
 *   都会给出高度相似的句子（"今天又是忙碌的一天…"），用户看两天就烦了。
 *   只取最近两条、每条截到 200 字 —— 否则 prompt 越滚越长，成本失控。
 */
export function composeBriefPrompt({ context, profile, kind, now, previousTexts, memory } = {}) {
  const isWeekly = String(kind) === 'weekly';
  const ctx = (context && typeof context === 'object') ? context : {};
  const at = asDate(now == null ? new Date() : now);

  const lines = [];
  lines.push(`【这一条是】${isWeekly ? '周复盘（一周过完了，回头看）' : '今日简报（今天早上，往前看）'}`);
  lines.push(`【今天日期】${toDateKey(at)}${isWeekly ? `（${'日一二三四五六'[at.getDay()]}）` : ''}`);
  lines.push('');
  lines.push('【我的日程上下文（已经压缩过，只包含今天/未来几天/逾期未完成/今明两天的课）】');
  const text = textOf(ctx.text, 4000);
  if (text) lines.push(text);
  else lines.push('（没有任何日程）');

  const stats = (ctx.stats && typeof ctx.stats === 'object') ? ctx.stats : null;
  if (stats) {
    const bits = [`今天 ${Number(stats.today) || 0} 件`, `逾期 ${Number(stats.overdue) || 0} 件`, `本周完成 ${Number(stats.weekDone) || 0} 件`];
    if (stats.tightest && stats.tightest.title) {
      bits.push(`最紧的是「${textOf(stats.tightest.title, 40)}」（${textOf(stats.tightest.text, 20)}）`);
    }
    lines.push(`【数字（只作参考，别照抄这些统计口径）】${bits.join('；')}`);
  }
  if (ctx.truncated) lines.push('【注意】上下文被截断过，后面还有没列出来的事，不要断言"就这些"。');

  const pl = profileLines(profile);
  if (pl.length) {
    lines.push('');
    lines.push('【关于我】');
    lines.push(...pl);
  }

  // 「让 AI 了解这个 App 与你的历史」（第 53 轮）：`memory` 由**调用方**组装
  // （`core/ai-context.js` 的 `memorySectionFor` —— 它已经带上标题、trim 过、也截断过），
  // 因为开关判定与摘要裁剪都在那边，而 core/brief.js 不能反向 import ai-context
  // （那会成环：ai-context 要 import 本文件取 aiFeatureIsOn）。
  // ⚠️ 这里**不要**用本文件的 `textOf()` 收口：它会把换行压成空格（摘要是一条一行的）。
  // ⚠️⚠️ **空串就一行都不加** —— 这是"开关关着时发出去的 prompt 与接入前逐字节相同"
  //    的执行点。别改成"加个空标题"或"加一句（无）"：那会让每次请求都多出几个字节，
  //    也让那条承诺没法用 `assert.equal` 证。
  const mem = memory == null ? '' : String(memory).trim();
  if (mem) {
    lines.push('');
    lines.push(mem);
  }

  lines.push('');
  // ⚠️ 这几条**在 system 里也写了**（那里是常量，专门伺候 prompt 缓存）。
  //    在 user 末尾再点名一次不是啰嗦：system 离生成位置最远，而"只输出正文/
  //    不要说'作为AI'/不要编造日程里没有的事/中文口语化/不超过多少字"这五条
  //    恰好是这个功能最容易被违反的（编造最严重 —— 用户会以为日程里真有事）。
  //    ⚠️ 字数上限在这里写的是**常量**（不随 kind 变）：system 已经是常量了，
  //       user 里再按 kind 变一个数字，只是让 prompt 更难对齐，收益为零。
  lines.push([
    '【这次输出的要求】',
    '· 只输出正文本身：不要开场白、不要解释、不要"以下是"、不要引号包住整段。',
    '· 不要说"作为 AI""根据你的日程"这类话，也不要点出你看到了什么数据。',
    '· 不要编造：日程里没写的安排、没提到的数字，都不许出现。',
    '· 中文口语化，180 字以内。',
  ].join('\n'));

  const prev = (Array.isArray(previousTexts) ? previousTexts : [])
    .map((x) => textOf(x, 200)).filter(Boolean).slice(-2);
  if (prev.length) {
    lines.push('');
    lines.push('【最近几条简报的开头/说法，别再用同一套说法】');
    lines.push(...prev.map((t) => `- ${t}`));
  }

  lines.push('');
  lines.push(isWeekly
    ? '现在只输出这一条周复盘正文：先说这周做完了什么，再说哪些一直在往后拖，最后给一句下周的建议。'
    : '现在只输出这一条今日简报正文：先说今天最要紧的那件事，再说其他安排，最后给一句建议。');

  return {
    system: SYSTEM_PROMPT,
    user: lines.join('\n'),
    // 中文 180 字 ≈ 300 token 上下；周复盘多说一点，所以留宽一些
    maxTokens: isWeekly ? 500 : 400,
    // 温度比祝福语低一点：简报是**事实**驱动的（日程里有什么就说什么），
    // 不需要创意，跑偏的代价是"编了一件不存在的事"，比不好看严重。
    temperature: 0.6,
  };
}

// ---------------------------------------------------------------------------
// 离线简报
// ---------------------------------------------------------------------------

/** 离线文本的默认上限（字符）。比上下文紧：简报是"一眼看完"的东西 */
export const DEFAULT_OFFLINE_CHARS = 600;

/** 简报里"还剩多久"的写法：比 remainText 更短（同一句话里会连着出现几次） */
function shortRemain(ms) {
  if (ms == null) return '没有期限';
  const abs = Math.abs(ms);
  if (ms < 0) {
    if (abs < 3_600_000) return `逾期 ${Math.max(1, Math.round(abs / 60_000))} 分钟`;
    if (abs < 86_400_000) return `逾期 ${Math.round(abs / 3_600_000)} 小时`;
    return `逾期 ${Math.round(abs / 86_400_000)} 天`;
  }
  if (abs < 3_600_000) return `还剩 ${Math.max(1, Math.round(abs / 60_000))} 分钟`;
  if (abs < 86_400_000) return `还剩 ${Math.round(abs / 3_600_000)} 小时`;
  return `还剩 ${Math.round(abs / 86_400_000)} 天`;
}

/**
 * 一句**有依据的**建议。
 *
 * ⚠️ 这里最容易写出"要不要把 X 挪到周四"这种**瞎建议**：日程里根本没有"周四有没有空"
 *    这个信息，凭什么说周四行？所以每条建议都必须能指回一个具体的事实
 *    （逾期几件 / 最紧那件还剩多久 / 有没有课 / 有几件在拖）。
 *    **没有依据时返回 null** —— 宁可不说，也不要说一句放之四海皆准的废话。
 */
function dailyAdvice(ctx, stats, postponed) {
  if (arr(ctx.overdue).length) {
    return `有 ${arr(ctx.overdue).length} 件已经过点了还没划掉，先挑一件处理掉，比重新排计划有用。`;
  }
  const t = stats.tightest;
  if (t && t.overdue === false && t.remainingMs != null && t.remainingMs <= 86_400_000) {
    return `「${t.title}」${shortRemain(t.remainingMs)}就到点，今天先把它做完。`;
  }
  if (Number(ctx.coursesToday) > 0) {
    return '今天有课，别忘了按课表的时间出门。';
  }
  if (arr(postponed).length) {
    // ⚠️ 措辞留余地：推迟只是**近似**推断（见 detectChronicallyPostponed 的注释），
    //    所以是"像是一直往后拖"，不是"你推迟了 N 次"。
    return `「${arr(postponed)[0].title}」放了很久没动，像是一直在往后拖，今天可以动一下。`;
  }
  const pending = arr(ctx.today).length + arr(ctx.timeline).length;
  if (pending >= 6) return `看着有 ${pending} 件排着，挑最要紧的一两件先做完就行，别指望全清。`;
  return null;
}

/**
 * 离线（模板）简报。**必须有内容**（用户原话："能不带 AI 也出"）。
 *
 * 结构（今日）：
 *   ① 开头一句说清"今天几件、最紧的是哪件"（**点名**，不是"今天有 3 件事"）
 *   ② 今天的时间线（最多 5 条）
 *   ③ 逾期未完成（最多 4 条）
 *   ④ 今明两天有课
 *   ⑤ 一句有依据的建议（没有依据就不出现）
 *
 * 结构（周复盘）：
 *   ① 本周完成几件
 *   ② 还挂着的（今天 + 逾期，最多 5 条）
 *   ③ 像是在被一直往后拖的（见 detectChronicallyPostponed）
 *   ④ 一句建议
 *
 * ⚠️ 空库/什么都不做时**也要有话说**（返回非空），但绝不许硬编一件不存在的事。
 *
 * @returns {{text:string, source:'offline'}}
 */
export function composeOfflineBrief({ context, kind, now, events } = {}) {
  const nowD = asDate(now == null ? new Date() : now);
  const isWeekly = String(kind) === 'weekly';
  const base = (context && typeof context === 'object') ? context : {};
  const stats = (base.stats && typeof base.stats === 'object') ? base.stats : {};

  // ⚠️ 这里收的是 `scheduleContext` 的**输出**，不是原始数据 —— 两条路要能单独用
  //    （界面可以先只算离线版，不生成上下文）。缺字段时全部按空处理，
  //    **绝不抛错**：简报出不来比简报不好看严重得多。
  const today = arr(base.items).filter((it) => it.day === toDateKey(nowD) && it.overdue !== true);
  const rest = arr(base.items).filter((it) => it.day !== toDateKey(nowD));
  const overdue = arr(base.items).filter((it) => it.overdue === true);

  // 「一直往后拖」的名单：优先用上下文里已经算好的（`scheduleContext` 会带上），
  // 没带就用调用方直接给的 events 现算 —— 两种入口都支持，因为离线简报
  // 完全可能在没有上下文的情况下被单独调用。
  const postponed = arr(base.postponed).length
    ? arr(base.postponed)
    : detectChronicallyPostponed(arr(events), { now: nowD });

  // 课程信息：上下文文本里的「【课】」那一节最稳（它已经是"今天/明天有课"的粒度）
  const courseLine = pickCourseSection(base.text);
  const tightest = stats.tightest || null;

  const lines = [];
  if (isWeekly) {
    lines.push(`这周完成了 ${Number(stats.weekDone) || 0} 件，还有 ${today.length + overdue.length} 件挂着。`);
    const show = [...overdue, ...today].slice(0, 5);
    if (show.length) {
      lines.push('还挂着的：');
      for (const it of show) lines.push(`- ${it.overdue ? `${it.day} ` : ''}${it.title}（${shortRemain(it.remainingMs)}）`);
    }
    if (postponed.length) {
      lines.push(`像是一直在往后拖的（${postponed.length} 件）：`);
      for (const p of postponed.slice(0, 3)) lines.push(`- ${p.title}（放了 ${p.days} 天没动）`);
    }
    const advice = weeklyAdvice({ overdue, today, postponed });
    if (advice) lines.push(advice);
    if (lines.length === 1) lines.push('这周没有排任何事，也没有欠账。');
  } else {
    const nToday = today.length;
    const nOverdue = overdue.length;
    const head = tightest && tightest.title
      ? `今天 ${nToday} 件，最紧的是「${tightest.title}」（${shortRemain(tightest.remainingMs)}）。`
      : (nOverdue
        ? `今天没有排事，但有 ${nOverdue} 件逾期没完成。`
        : '今天没有安排。');
    lines.push(head);
    if (today.length) {
      lines.push('今天：');
      for (const it of today.slice(0, 5)) {
        const at = it.time ? `${it.time} ` : '';
        lines.push(`- ${at}${it.title}（${shortRemain(it.remainingMs)}）`);
      }
    }
    if (nOverdue) {
      lines.push(`逾期未完成（${nOverdue} 件）：`);
      for (const it of overdue.slice(0, 4)) lines.push(`- ${it.day} ${it.title}`);
    }
    if (courseLine) lines.push(courseLine);
    const advice = dailyAdvice(
      { overdue, today, timeline: rest, coursesToday: Number(stats.coursesToday) || 0 },
      { tightest },
      postponed,
    );
    if (advice) lines.push(advice);
    if (lines.length === 1) lines.push('可以安排点自己的事，或者就歇着。');
  }

  return { text: lines.join('\n').trim(), source: 'offline' };
}

/** 建议（周复盘版）—— 同样必须"有依据"，没依据就不说 */
function weeklyAdvice({ overdue, today, postponed }) {
  if (overdue.length) {
    return `下周开始前，先把这 ${overdue.length} 件逾期的处理掉（要么做完，要么改期），不然它们会一直跟着。`;
  }
  if (postponed && postponed.length) {
    return `有 ${postponed.length} 件放了很久没动，挑一件真正要做的排进下周，剩下的干脆删掉。`;
  }
  if (today.length) return '下周的事不多，挑最要紧的一件先做就行。';
  return null;
}

/** `[]` 兜底（脏 context 不许把简报弄崩） */
function arr(v) { return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []; }

/** 从上下文文本里取「【课】」那一节（离线版只搬这一节，不自己重算课表） */
function pickCourseSection(text) {
  const s = typeof text === 'string' ? text : '';
  const i = s.indexOf('【课】');
  if (i < 0) return '';
  const rest = s.slice(i + 4).trim().split('\n').map((x) => x.trim()).filter(Boolean);
  return rest.length ? `课：${rest.join('；')}` : '';
}

// ---------------------------------------------------------------------------
// 对外主函数
// ---------------------------------------------------------------------------

/**
 * 生成一条简报。
 *
 * 有 `aiText` → 用它（过一次去套话）；没有/去完套话变空 → **离线模板**。
 * 返回 `{text, source, fingerprint}`，`source` 只有 `'ai' | 'offline'`。
 *
 * ⚠️ **绝不静默产出空简报**（同 core/greetings.js 的理由）：用户看到一张空白卡片
 *    比看到"模板味"糟得多，而且他没法判断是没数据还是功能坏了。
 */
export function composeBrief({ context, profile, aiText, kind, now } = {}) {
  const nowD = asDate(now == null ? new Date() : now);
  const ctx = (context && typeof context === 'object') ? context : {};
  const raw = typeof aiText === 'string' ? aiText.trim() : '';
  let source = 'offline';
  let text = '';

  if (raw) {
    source = 'ai';
    text = stripCliches(raw);
    if (text.trim().length < MIN_AI_CHARS) {
      // 只剩半句（或整段都是套话被删空）→ 退回离线。半句简报没有任何价值。
      source = 'offline';
      text = '';
    }
  }
  if (!text.trim()) {
    text = composeOfflineBrief({ context: ctx, kind, now: nowD }).text;
  }

  const cap = Number.isFinite(Number(ctx.maxChars))
    ? Math.max(MIN_CONTEXT_CHARS, Math.floor(Number(ctx.maxChars)) * 2)
    : DEFAULT_OFFLINE_CHARS;
  if (text.length > cap) text = `${text.slice(0, cap - 1)}…`;

  return { text: text.trim(), source, fingerprint: briefFingerprint(text) };
}

/** AI 文本低于这个长度就当作"没生成出来"（退回离线） */
const MIN_AI_CHARS = 8;

/** 简报指纹（判重/防重发用）。复用祝福语那套稳定 FNV-1a，前缀换成 `b-` */
export function briefFingerprint(text) {
  const fp = greetingFingerprint(text);
  return `b-${fp.replace(/^g-/, '')}`;
}

// ---------------------------------------------------------------------------
// 到期判定
// ---------------------------------------------------------------------------

/**
 * 现在到点了吗：`{today, weekly, at}`。
 *
 * 规则（用户原话是"每天早上一条""每周日一条"）：
 *   · 今日简报：**每天**过了 `briefHour`（默认 8 点）就算到点
 *   · 周复盘：**周日**过了 `weeklyHour`（默认 20 点）才算
 *   · `at` = **下一次**周复盘的到点时刻（界面拿它显示"下次什么时候会有简报"）
 *
 * ⚠️⚠️ **本函数只回答"到点了吗"，不判开关。** 开关由调用方判：
 *
 *       const due = briefDue({ now, settings });
 *       const show = aiFeatureIsOn(settings, 'todayBrief') && due.today;   // ← 必须 AND
 *
 *    为什么刻意分开（这是分层，不是漏写）：
 *      · "现在是不是那个时刻"是**客观事实**，与用户开没开无关；
 *        界面要显示"明天 08:00 会有一条简报"时功能可能还关着，那时也得算得出 `at`。
 *      · 这个模块的开关是**数据库里的设置**（老库可能还没有这个键），
 *        而到点判定是**纯时间函数** —— 分开之后它能被单独钉住（不用造一份 settings），
 *        也让"我刚打开开关，为什么今天不补发"这类问题只有一个解释点。
 *
 *    ⚠️ 但**调用方必须 AND 上开关**。用户原话："这些新加入的功能我要可关可开，
 *       不要时就不要" —— 只判 `due.today` 会让关掉的功能照样冒卡片出来，
 *       而用户会理解成"我关了它还在推"。这条已经在交接里写明（界面工位负责）。
 *
 * ⚠️ **没到点就是 false**，不做"补发"：晚上 11 点打开应用不该突然弹出
 *    "早上 8 点的今日简报"（"今天该做什么"此时已经没有意义了）。
 *    这条和 core/course-digest.js 的 DIGEST_FRESH_MS 是同一个考虑。
 *
 * 钟点读法：先看 `settings.aiFeatures.briefHour / weeklyHour / weeklyDow`，
 * 读不到就用缺省。脏值一律落回缺省（别让一个字符串把判定弄崩）。
 */
export function briefDue({ now, settings } = {}) {
  const at0 = asDate(now == null ? new Date() : now);
  // ⚠️ `now` 可能是脏值（随便一个字符串 / NaN / Invalid Date）。原来直接把它带下去，
  //    结果是 `at` 变成 Invalid Date（NaN）——界面上就会显示 "Invalid Date"。
  //    契约说"now / settings 都不给也不许炸"，而**不炸但吐 NaN 不算满足契约**。
  //    所以这里落回"现在"，和 `now == null` 走同一条兜底路径。
  const at = Number.isFinite(at0.getTime()) ? at0 : new Date();
  const s = (settings && typeof settings === 'object') ? settings : {};
  const f = (s.aiFeatures && typeof s.aiFeatures === 'object' && !Array.isArray(s.aiFeatures)) ? s.aiFeatures : {};
  const dailyHour = hourOf(f.briefHour, DEFAULT_DAILY_HOUR);
  const weeklyHour = hourOf(f.weeklyHour, DEFAULT_WEEKLY_HOUR);
  const weeklyDow = hourOf(f.weeklyDow, DEFAULT_WEEKLY_DOW) % 7;

  const dayStart = startOfDay(at);
  const todayAt = new Date(dayStart);
  todayAt.setHours(dailyHour, 0, 0, 0);

  const sunday = new Date(dayStart);
  sunday.setDate(sunday.getDate() + ((weeklyDow - sunday.getDay() + 7) % 7));
  const weeklyAt = new Date(sunday);
  weeklyAt.setHours(weeklyHour, 0, 0, 0);

  const nowMs = at.getTime();
  return {
    // ⚠️ 只看时间，**不看开关**（见上面那段"为什么刻意分开"）：
    //    调用方必须 `aiFeatureIsOn(settings,'todayBrief') && due.today`。
    today: nowMs >= todayAt.getTime(),
    weekly: nowMs >= weeklyAt.getTime(),
    at: weeklyAt,
  };
}

/**
 * "一天只推一次"用的稳定键。
 *
 * ⚠️ 键里**只有日期**，不能带时分秒：带着时刻的话，每分钟算出来的键都不一样，
 *    判重就失效了（用户会收到一整天不停刷新的简报）。
 *   · 今日简报 → `brief:today:2026-09-25`
 *   · 周复盘   → `brief:weekly:2026-09-21`（**那一周的周一**：同一周内任何一天
 *     算出来都一样，跨周才变 —— 这是"周"这个粒度的自然键）
 *
 * ⚠️ 用**本地**日期（`toDateKey`），不用 UTC 的 `toISOString().slice(0,10)`：
 *    后者在东八区会把凌晨 0–8 点算成前一天。
 */
export function briefSeenKey(kind, now) {
  const at = asDate(now == null ? new Date() : now);
  if (String(kind) === 'weekly') {
    const monday = startOfDay(at);
    monday.setDate(monday.getDate() - (monday.getDay() === 0 ? 6 : monday.getDay() - 1));
    return `brief:weekly:${toDateKey(monday)}`;
  }
  return `brief:today:${toDateKey(at)}`;
}
