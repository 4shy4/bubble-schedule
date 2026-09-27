// 「本地活动日记」：把"发生了什么"记在**本地**，只把**压缩摘要**喂给 AI。
//
// 用户原话（这是本模块存在的全部理由）：
//   "记得投喂本程序的**日志、上下文、和创造过程**给 AI"
// 已确认要记的**三类**（程序自身的运行错误日志**不在**其中）：
//   ① 日程的完成 / 推迟（改期）/ 逾期
//   ② 提醒的发出与戳破记录
//   ③ AI 生成与祝福发送记录
//
// ---------------------------------------------------------------------------
// 四条底线，改动时别越过
// ---------------------------------------------------------------------------
// ① **记的是"发生了什么"，不是"内容是什么"**。
//    `newActivity` 用**字段白名单构造**（见 FIELD_WHITELIST）：新对象里只有登记过的
//    几个键，传进来的其它字段**一律丢掉**。为什么不是"过滤掉某些名字"：
//    黑名单永远会漏（`note` 挡住了还有 `notes` / `remark` / `memo`…），而这里要挡的是
//    **好友关键词、好友备注、私信正文** —— 漏一个就是把别人的隐私写进了日志。
//    所以 `refId` 只存**不透明 id**，绝不存好友名/称呼/关键词/备注。
//
// ② **只喂摘要**（`summarizeActivity`）。
//    给 AI 的是几十个字的人话（"完成 3 件、提醒响了 4 次…"），不是原始日志。
//    原始日志留在本地**给人看**（见 web/ui/views/assistant.js 的「本地记录」入口）——
//    "看不见的本地记录"是不可接受的，所以那边能看见、也能一键清空。
//
// ③ **开关默认关**（`activitySettings.enabled === false`）。
//    这是用户一贯的要求（"不要时就不要"）：不点头就一个字节都不记。
//    所有写入都必须经过 `recordActivity` / `logActivity`，闸门只有那一处
//    （调用点各写一个 `if` 必然会漏一处，而漏的那处会安静地记一整年）。
//
// ④ **绝不影响平台无关性 / 可复现性**。
//    id 走 FNV-1a 稳定哈希，**没有 Math.random、没有 Date.now 参与输出** ——
//    同输入必须逐字节同输出（理由同 core/greetings.js：指纹与"重开一次结果一样"）。
//    ⚠️ 唯一读墙上时钟的地方是"没给 `now` 时的兜底"（`isoOf`），它和 core/brief.js
//       的 `now == null ? new Date()` 是同一个约定：宁可记一个当前时刻，也不要抛错。
//
// 平台无关（不碰 node: / window / document / Buffer / fetch / localStorage），
// 见 tools/core.test.mjs。
//
// 保留期：默认 **500 条 / 30 天**（`ACTIVITY_MAX_ENTRIES` / `ACTIVITY_MAX_DAYS`）。
// 两个上限都要有：条数防"一天记一万条"，天数防"三个月前的事还在喂 AI"。

// ---------------------------------------------------------------------------
// 登记表：能记哪些 kind / action
// ---------------------------------------------------------------------------

/**
 * 能记的三类。`label` 是给人看的中文（摘要和本地查看都用它，界面不许再抄一份）。
 * ⚠️ `key` 是**存储键**，改了等于历史记录全部认不出来，别改。
 */
export const ACTIVITY_KINDS = [
  { key: 'event', label: '日程' },
  { key: 'reminder', label: '提醒' },
  { key: 'ai', label: 'AI' },
];

/**
 * 每类下**允许**的动作。没登记的组合一律**不记**（返回 null，不是抛错）。
 *
 * ⚠️ 为什么要"登记 + 不记"而不是"都记下来再过滤"：一条没登记的动作往往意味着
 *    调用方写错了（typo / 传错了 kind）。安静地记一条谁也读不懂的记录，比当场什么都不记
 *    难查得多 —— 而这里又不适合抛错（记日志失败绝不该让"戳破一颗泡泡"失败）。
 */
export const ACTIVITY_ACTIONS = {
  event: ['created', 'done', 'popped', 'rescheduled', 'overdue'],
  reminder: ['fired', 'popped'],
  ai: ['generated', 'sent'],
};

const KIND_LABEL = Object.fromEntries(ACTIVITY_KINDS.map((k) => [k.key, k.label]));

/** 动作的中文（**只有这一份**：摘要、本地查看、将来任何地方都用它） */
const ACTION_LABEL = {
  'event/created': '新建',
  'event/done': '完成',
  'event/popped': '戳破',
  'event/rescheduled': '改期',
  'event/overdue': '逾期',
  'reminder/fired': '发出',
  'reminder/popped': '戳破',
  'ai/generated': '生成',
  'ai/sent': '发送',
};

/** AI 这次是**从哪儿来**的（与 web/ui/ai-source.js 的三档 + 离线模板对应） */
export const ACTIVITY_AI_SOURCES = ['ai', 'offline', 'local', 'computer'];
const SOURCE_LABEL = { ai: '模型', offline: '离线模板', local: '本机模型', computer: '电脑' };

/** 祝福/提醒文案的**发送**结果（与 core/send-task.js 的状态机一致） */
export const ACTIVITY_SEND_STATUS = ['confirmed', 'unverified', 'failed'];
const STATUS_LABEL = { confirmed: '已确认发出', unverified: '无法确认', failed: '失败' };

/** 这次生成的是什么（只用于分类统计，不含任何内容） */
export const ACTIVITY_AI_TASKS = ['greeting', 'eventReminder', 'brief', 'other'];
const TASK_LABEL = { greeting: '祝福语', eventReminder: '日程提醒', brief: '简报', other: '其它' };

// ---------------------------------------------------------------------------
// 字段白名单（**隐私硬线的执行点**）
// ---------------------------------------------------------------------------

/**
 * 每种动作允许携带的**全部**字段。
 *
 * ⚠️⚠️ 这里是"好友名/备注/关键词/私信内容永不入库"的执行点。做法是**白名单构造**：
 *    新对象里只有下面这些键，`payload` 上多出来的东西（`note` / `notes` / `remark` /
 *    `keywords` / `contact` / `name` / `message` / `body` / `content` / `profile` …）
 *    一个都进不去。**不要**改成"黑名单过滤"。
 *
 * 字段含义：
 *   `refId`        不透明 id（事件 id / 草稿键）。**绝不存好友名或称呼。**
 *   `title`        日程标题（允许，但要能关：`summarizeActivity({includeTitles:false})`）
 *   `type`/`level` 日程类型与四档等级（用于摘要里分档，不含内容）
 *   `remainingMs`  戳破/完成那一刻的剩余时间（负数 = 提前完成，与回收站同一套符号约定）
 *   `minutes`      提醒的提前量（分钟；负值 = 开始之后提醒）
 *   `from`/`to`    改期前后的起始时刻（只记时间，不记理由）
 *   `source`       AI 来源（ai/offline/local/computer）
 *   `status`       发送结果（confirmed/unverified/failed）
 *   `feature`      这次生成的是什么（greeting/eventReminder/brief/other）
 */
const FIELD_WHITELIST = {
  'event/created': ['refId', 'title', 'type', 'level'],
  'event/done': ['refId', 'title', 'level', 'remainingMs'],
  'event/popped': ['refId', 'title', 'level', 'remainingMs'],
  'event/rescheduled': ['refId', 'title', 'level', 'from', 'to'],
  'event/overdue': ['refId', 'title', 'level', 'remainingMs'],
  'reminder/fired': ['refId', 'title', 'minutes'],
  'reminder/popped': ['refId', 'title', 'minutes'],
  'ai/generated': ['source', 'feature', 'refId'],
  'ai/sent': ['source', 'status', 'feature', 'refId'],
};

/** 文本字段 → 最大长度（**必须截短**：标题可以很长，而日志要能一眼扫完） */
const TEXT_FIELDS = { refId: 80, title: 60, type: 20, level: 12, from: 40, to: 40 };
/** 数字字段（只认有限数，脏值丢掉而不是当 0） */
const NUM_FIELDS = { remainingMs: 1, minutes: 1 };
/** 枚举字段（认不出来的值丢掉，而不是原样存进去） */
const ENUM_FIELDS = {
  source: ACTIVITY_AI_SOURCES,
  status: ACTIVITY_SEND_STATUS,
  feature: ACTIVITY_AI_TASKS,
};

/** 保留期缺省值（两条都要：条数防爆量，天数防"三个月前的事还在喂"） */
export const ACTIVITY_MAX_ENTRIES = 500;
export const ACTIVITY_MAX_DAYS = 30;
/** 同上限（用户手改出来的离谱值夹住，而不是照收） */
const HARD_MAX_ENTRIES = 5000;
const HARD_MAX_DAYS = 3650;

/** 去重窗口缺省值：同一件事在 60 秒内重复记 → 合并成一条（`count` 累加） */
export const ACTIVITY_DEDUP_MS = 60_000;

/** 摘要的字符上限（≤800 字：它是喂给 AI 的，也是"一眼看完"的东西） */
export const SUMMARY_MAX_CHARS = 800;
/** 摘要默认看最近几天 */
export const SUMMARY_DEFAULT_DAYS = 7;
/** 喂给助手 prompt 时默认看最近几天（比摘要宽一点，但绝不是"全部历史"） */
export const FEED_DEFAULT_DAYS = 14;

// ---------------------------------------------------------------------------
// 小工具（全部**不抛错**：记日志失败绝不该让业务动作失败）
// ---------------------------------------------------------------------------

/** FNV-1a（与 core/greetings.js / core/contacts.js 同一套算法） */
function stableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function base36(n) { return Math.max(0, Math.floor(Number(n) || 0)).toString(36); }

/**
 * 整数夹取；**读不出来或小于下限的一律用缺省**（脏设置一律落回缺省，同 core/brief.js）。
 *
 * ⚠️ 负数和 0 走"缺省"而不是"夹到 1"：`maxDays: -3`、`maxEntries: 0` 是**被改坏**的值，
 *    夹到 1 的后果是"用户一打开记录，历史立刻只剩今天"—— 那是很吓人的一次静默数据丢。
 *    太大的值才夹住（那是手改出来的，夹到硬上限比照收安全）。
 */
function intIn(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, Math.floor(n));
}

/** 时刻 → ISO 字符串；认不出来给空串（**不要**用 0 冒充，那会变成 1970 年） */
function isoOf(now) {
  if (now instanceof Date) {
    return Number.isFinite(now.getTime()) ? now.toISOString() : '';
  }
  if (typeof now === 'number' && Number.isFinite(now)) {
    const d = new Date(now);
    return Number.isFinite(d.getTime()) ? d.toISOString() : '';
  }
  if (typeof now === 'string' && now.trim()) {
    const d = new Date(now);
    return Number.isFinite(d.getTime()) ? d.toISOString() : '';
  }
  // ⚠️ 唯一一处"读墙上时钟"：没给 now 就用当前时刻（同 core/brief.js 的约定）。
  //    显式传 now 的地方（几乎全部调用点）因此仍然逐字节可复现。
  const d = new Date();
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

/** 时刻 → 毫秒；认不出来给 null */
function msOf(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;                                       // 其余（null / undefined / 对象…）→ 没有时刻
}

/** 文本：去换行、去多余空白、截短（进日志的每个字符串都要过这一道） */
function textOf(v, max) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 选项对象兜底：只认**普通对象**，其余（null / 数组 / 字符串）当空参。
 * ⚠️ 参数默认值 `= {}` **只兜 undefined**：`f(x, null)` 会当场 TypeError。
 *    这些函数都会被界面/适配器直接调，一句 `null` 不该把整页弄崩。
 */
function optsOf(args) {
  return (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
}

/** 'YYYY-MM-DD HH:MM'（本地时间；日志是给人看的，用本地时刻最不费脑子） */
function stamp(at) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "还剩/逾期多久"的人话（负数是提前完成 —— 与回收站的符号约定一致） */
function remainText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const sign = n < 0 ? '逾期' : '还剩';
  if (abs < 60 * 60_000) return `${sign} ${Math.max(1, Math.round(abs / 60_000))} 分钟`;
  if (abs < 86_400_000) return `${sign} ${Math.max(1, Math.round(abs / 3_600_000))} 小时`;
  return `${sign} ${Math.max(1, Math.round(abs / 86_400_000))} 天`;
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/**
 * `settings.activitySettings` 的缺省值。
 *
 * ⚠️ 这是**唯一**一份定义：`core/defaults.js` 从这里取（别在那边手抄一份，
 *    抄了就会漂移，症状是"我明明开了记录，重启又关了"）。
 * ⚠️ `enabled` 默认 **false**：用户的一贯要求"不要时就不要"。它管的是
 *    **本地记不记**；"要不要喂给 AI"是另一个开关（`aiFeatures.assistantMemory`，
 *    见 core/brief.js）—— 两个开关职责不同，不重复：
 *      · 记录开 + 喂养关 = 本地留个自己的记录，一个字都不外发；
 *      · 喂养开 + 记录关 = 没有历史可喂（`canFeed` 仍是 true，但摘要自然是空的）。
 */
export function activitySettingsDefaults() {
  return { maxEntries: ACTIVITY_MAX_ENTRIES, maxDays: ACTIVITY_MAX_DAYS, enabled: false };
}

/**
 * 读出干净的一份活动日记设置（**脏值一律落回缺省**）。
 *
 * ⚠️ `enabled` 只认**严格 true**：设置是用户能亲手改坏的东西（旧备份、手改 db.json、
 *    同步过来半个对象），而它是"要不要把发生的事写进本地"的总闸 —— 读不出来时必须
 *    当成**关**。反过来（脏值当成开）会让用户遇到"我明明没开它却在记"。
 */
export function readActivitySettings(settings) {
  const s = (settings && typeof settings === 'object' && !Array.isArray(settings)) ? settings : {};
  const a = (s.activitySettings && typeof s.activitySettings === 'object' && !Array.isArray(s.activitySettings))
    ? s.activitySettings
    : {};
  return {
    enabled: a.enabled === true,
    maxEntries: intIn(a.maxEntries, ACTIVITY_MAX_ENTRIES, 1, HARD_MAX_ENTRIES),
    maxDays: intIn(a.maxDays, ACTIVITY_MAX_DAYS, 1, HARD_MAX_DAYS),
  };
}

// ---------------------------------------------------------------------------
// 构造 / 归一化
// ---------------------------------------------------------------------------

/** 这个 (kind, action) 登记过吗 */
function actionAllowed(kind, action) {
  const list = ACTIVITY_ACTIONS[kind];
  return Array.isArray(list) && list.includes(action);
}

/** 一个字段值能不能进日志（不能就返回 undefined，调用方直接不写这个键） */
function cleanField(field, value) {
  if (value === undefined || value === null) return undefined;
  if (Object.prototype.hasOwnProperty.call(TEXT_FIELDS, field)) return textOf(value, TEXT_FIELDS[field]);
  if (Object.prototype.hasOwnProperty.call(NUM_FIELDS, field)) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }
  const allowed = ENUM_FIELDS[field];
  if (Array.isArray(allowed)) {
    const s = typeof value === 'string' ? value.trim() : '';
    return allowed.includes(s) ? s : undefined;
  }
  return undefined;                                  // 没登记的字段 → 丢掉（不是原样存）
}

/** 计数（合并过的条目会 > 1）；上限防手改出来的天文数字 */
function cleanCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(100000, Math.floor(n));
}

/** 稳定 id：同一份内容 → 同一个 id（**没有随机数**） */
function activityId(kind, action, at, fields) {
  const seed = [
    kind, action, at,
    fields.refId || '', fields.title || '', fields.source || '',
    fields.status || '', fields.minutes == null ? '' : fields.minutes,
  ].join('|');
  return `a-${base36(stableHash(seed))}`;
}

/**
 * 把任意一个候选对象**重建成**一条合法记录；不合法返回 null。
 *
 * ⚠️ 所有入口（`appendActivity` / `appendActivityDedup` / `summarizeActivity` /
 *    `describeActivity`）都过这一道 —— 包括"从设置里读回来的老记录"。
 *    这样即使有人手改了 db.json、往 activityLog 里塞了 `{note:'老王的私事'}`，
 *    它也会在**读**的时候就消失（白名单构造），而不是靠每个输出点各挡一次。
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  const action = typeof raw.action === 'string' ? raw.action : '';
  if (!actionAllowed(kind, action)) return null;
  const atMs = msOf(raw.at);
  if (atMs == null) return null;                     // 没有时刻的记录没法排序/按天裁剪
  const at = new Date(atMs).toISOString();

  const out = { id: '', kind, action, at };
  for (const f of FIELD_WHITELIST[`${kind}/${action}`] || []) {
    const v = cleanField(f, raw[f]);
    if (v !== undefined) out[f] = v;
  }
  out.count = cleanCount(raw.count);
  const lastAt = msOf(raw.lastAt);
  if (lastAt != null) out.lastAt = new Date(lastAt).toISOString();
  out.id = activityId(kind, action, at, out);        // id 一律重算：外来的 id 不可信
  return out;
}

/** 一个数组 → 干净、按时刻升序的记录数组（脏项直接丢掉） */
function sanitizeList(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const e = normalizeEntry(raw);
    if (e) out.push(e);
  }
  // ⚠️ 只按时刻排，**不加 id 之类的 tie-break**：`Array.prototype.sort` 是稳定的，
  //    所以同一毫秒里的记录会保持**写入顺序**。用 id 当 tie-break 的后果是
  //    "同一毫秒里连着记的两条被排成乱序"（`created` 排在 `done` 后面）——
  //    而这不是罕见情况：一个动作里连着记两条、或者一次批量操作，都会撞在同一毫秒上。
  out.sort((a, b) => msOf(a.at) - msOf(b.at));
  return out;
}

/**
 * 造一条记录（**不落库**，只是构造）。
 *
 * @param {string} kind   'event' | 'reminder' | 'ai'
 * @param {string} action 见 ACTIVITY_ACTIONS
 * @param {object} payload 只认字段白名单里的键；**多出来的一律丢弃**
 * @param {Date|string|number} now 发生时刻（显式传，保证可复现）
 * @returns {{id,kind,action,at,count,...}|null} 未登记的 kind/action 或时刻无效 → null
 */
export function newActivity(kind, action, payload, now) {
  const k = typeof kind === 'string' ? kind : '';
  const a = typeof action === 'string' ? action : '';
  if (!actionAllowed(k, a)) return null;
  const at = isoOf(now);
  if (!at) return null;
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
  const base = { kind: k, action: a, at };
  for (const f of FIELD_WHITELIST[`${k}/${a}`] || []) {
    const v = cleanField(f, p[f]);
    if (v !== undefined) base[f] = v;
  }
  base.count = 1;
  base.id = activityId(k, a, at, base);
  return base;
}

// ---------------------------------------------------------------------------
// 裁剪
// ---------------------------------------------------------------------------

/**
 * 按 `maxEntries`（条数）和 `maxDays`（天数）裁剪，返回**新数组**。
 *
 * ⚠️ 两条路都要走，缺一条都会出问题：
 *   · 只有条数：天天记几百条的设备会把三个月前的事一直留着（喂给 AI 的摘要会变味）；
 *   · 只有天数：某天批量操作（导入课表）能一次性灌进几千条（文件爆掉、界面卡住）。
 * ⚠️ 裁掉的是**最老的**（按 `at` 升序保留最后 maxEntries 条）。
 * ⚠️ `now` 缺省用"最新一条的时刻"——**不是**墙上时钟：裁剪结果才可复现，
 *    也避免"用一台时钟不准的设备打开一次就把记录全清了"。
 */
export function pruneActivity(list, args) {
  const { now, maxEntries, maxDays } = optsOf(args);
  const clean = sanitizeList(list);
  if (!clean.length) return clean;
  const maxN = intIn(maxEntries, ACTIVITY_MAX_ENTRIES, 1, HARD_MAX_ENTRIES);
  const maxD = intIn(maxDays, ACTIVITY_MAX_DAYS, 1, HARD_MAX_DAYS);
  const newest = msOf(clean[clean.length - 1].at);
  const nowMs = msOf(now);
  const floor = (nowMs == null ? newest : nowMs) - maxD * 86_400_000;
  // ⚠️ 超过天数的**全部丢掉**（可能一条不剩）—— 这就是"最多留 30 天"那句话的字面意思。
  //    实际写入路径上不会因此丢空：`appendActivity` 是先加一条、再裁，
  //    新加的那条一定在窗口内（它的时刻就是裁剪的基准）。
  return clean.filter((e) => msOf(e.at) >= floor).slice(-maxN);
}

/**
 * 追加一条记录，返回**新数组**（不改入参）。
 *
 * `opts`：`{now, maxEntries, maxDays}`（默认 500 条 / 30 天）。
 */
export function appendActivity(list, entry, args) {
  const opts = optsOf(args);
  const base = sanitizeList(list);
  const clean = normalizeEntry(entry);
  if (!clean) return base;
  return pruneActivity([...base, clean], {
    ...opts,
    // 没给 now 时用这条记录自己的时刻（见 pruneActivity 的说明）
    now: opts.now == null ? clean.at : opts.now,
  });
}

/** 内容指纹：用来判"这是不是同一件事"（**不含时刻**，时刻交给窗口判） */
function dedupeKey(e) {
  return [
    e.kind, e.action,
    e.refId || '', e.title || '', e.source || '', e.status || '',
    e.minutes == null ? '' : e.minutes,
    e.from || '', e.to || '',
    e.level || '', e.type || '',
  ].join('|');
}

/**
 * 短时间内的**同一件事**合并成一条（`count` 累加，`lastAt` 记最近一次）。
 *
 * 为什么必须有它：记录点里有周期性扫描（提醒引擎、逾期扫描），
 * 它们**每几秒**就跑一次；没有去重的话，一条"提醒已发出"会被写几百遍，
 * 把 500 条的额度全占满 —— 用户看到的日志里就只剩同一句话。
 *
 * 合并规则：**保留第一次的 `at`**（"这件事从什么时候开始的"），
 * 最近一次写进 `lastAt`；`count` 累加，统计时按 `count` 算（否则会漏报）。
 *
 * @param {Array} list
 * @param {object} entry
 * @param {{windowMs?:number, now?:Date|string|number, maxEntries?:number, maxDays?:number}} opts
 */
export function appendActivityDedup(list, entry, args) {
  const base = sanitizeList(list);
  const clean = normalizeEntry(entry);
  if (!clean) return base;
  const o = optsOf(args);
  const win = intIn(o.windowMs, ACTIVITY_DEDUP_MS, 0, 24 * 3_600_000);
  // 裁剪/追加统一用**这条记录自己的时刻**（没显式给 now 时），见 pruneActivity 的说明
  const rest = {
    now: o.now == null ? clean.at : o.now,
    maxEntries: o.maxEntries,
    maxDays: o.maxDays,
  };
  const atMs = msOf(clean.at);
  const key = dedupeKey(clean);
  // 从**末尾**往前找（列表按时刻升序，所以第一个命中的就是最近的那条）；
  // 一旦超出窗口就停 —— 再往前的记录一定更旧。
  for (let i = base.length - 1; i >= 0; i -= 1) {
    const prev = base[i];
    if (atMs - msOf(prev.at) > win) break;
    if (dedupeKey(prev) !== key) continue;
    const merged = normalizeEntry({
      ...prev,
      at: prev.at,                                   // 保留第一次的时刻
      lastAt: clean.at,
      count: cleanCount(prev.count) + cleanCount(clean.count),
    });
    if (!merged) break;
    const next = [...base];
    next[i] = merged;
    return pruneActivity(next, rest);
  }
  return appendActivity(base, clean, rest);
}

// ---------------------------------------------------------------------------
// 统计与摘要
// ---------------------------------------------------------------------------

/** 窗口内的记录（`days` 天；脏数据 → 空数组） */
function windowOf(list, now, days) {
  const clean = sanitizeList(list);
  const d = intIn(days, SUMMARY_DEFAULT_DAYS, 1, HARD_MAX_DAYS);
  const nowMs = msOf(now);
  const newest = clean.length ? msOf(clean[clean.length - 1].at) : null;
  const ref = nowMs == null ? newest : nowMs;
  if (ref == null) return [];
  const floor = ref - d * 86_400_000;
  return clean.filter((e) => msOf(e.at) >= floor);
}

/** 某类动作的"次数"（合并过的按 `count` 算 —— 否则统计会漏报） */
function countOf(list, kind, action, extra) {
  let n = 0;
  for (const e of list) {
    if (e.kind !== kind || e.action !== action) continue;
    if (extra && !extra(e)) continue;
    n += cleanCount(e.count);
  }
  return n;
}

/**
 * 数字统计（`days` 天窗口内）。
 *
 * 返回**恰好**这八个键（调用方/界面按它们显示，别自己再算一套口径）：
 *   `done`      完成几件（`event/done`）
 *   `postponed` 改期几次（`event/rescheduled`）
 *   `overdue`   逾期几件（`event/overdue`）
 *   `remindersFired` 提醒发出几次（`reminder/fired`）
 *   `popped`    戳破几次（`event/popped` + `reminder/popped` 合计）
 *   `aiGenerated`    AI 生成几次（`ai/generated`，离线模板也算一次生成）
 *   `greetingsSent`  **确认发出**几条（`ai/sent` + `status:'confirmed'`）
 *   `greetingsUnverified` 无法确认几条（`ai/sent` + `status:'unverified'`）
 *
 * ⚠️ `status:'failed'` **不计入**上面任何一项（"发出去了"和"没发出去"是两件事，
 *    混进 `greetingsSent` 就是撒谎）。
 */
export function activityStats(list, args) {
  const { now, days } = optsOf(args);
  const win = windowOf(list, now, days == null ? SUMMARY_DEFAULT_DAYS : days);
  return {
    done: countOf(win, 'event', 'done'),
    postponed: countOf(win, 'event', 'rescheduled'),
    overdue: countOf(win, 'event', 'overdue'),
    remindersFired: countOf(win, 'reminder', 'fired'),
    popped: countOf(win, 'event', 'popped') + countOf(win, 'reminder', 'popped'),
    aiGenerated: countOf(win, 'ai', 'generated'),
    greetingsSent: countOf(win, 'ai', 'sent', (e) => e.status === 'confirmed'),
    greetingsUnverified: countOf(win, 'ai', 'sent', (e) => e.status === 'unverified'),
  };
}

/**
 * 把记录压成**人类读的短文本**（这是唯一允许喂给 AI 的形态）。
 *
 * @returns {{text:string, stats:object, truncated:boolean, days:number, count:number, total:number}}
 *   `text` 长度**不超过 SUMMARY_MAX_CHARS（800）**；超了按行截断并置 `truncated:true`。
 *   `count` = 窗口内的条数（界面显示"已把 N 条历史纳入摘要"），`total` = 本地总条数。
 *
 * 隐私：文本里的字符串**只有一个来源**——白名单字段（`summarizeActivity` 先过
 *   `sanitizeList`）。好友名、`settings.greetingProfile` 的内容、事件备注全文
 *   **不可能**出现在这里（它们根本进不了记录，见 FIELD_WHITELIST）。
 *   日程**标题**会出现在"最近做过"那一行，用 `includeTitles:false` 可整行关掉；
 *   另外可以用 `redact` 传一组敏感词（例如好友名）做最后一道遮挡。
 */
export function summarizeActivity(list, args) {
  const { now, days, includeTitles, redact } = optsOf(args);
  const d = intIn(days, SUMMARY_DEFAULT_DAYS, 1, HARD_MAX_DAYS);
  const win = windowOf(list, now, d);
  const stats = activityStats(list, { now, days: d });
  const titles = includeTitles !== false;
  const masks = (Array.isArray(redact) ? redact : [])
    .map((x) => String(x == null ? '' : x).trim())
    .filter((x) => x.length >= 2);
  const mask = (s) => {
    let out = String(s == null ? '' : s);
    for (const m of masks) out = out.split(m).join('＊');
    return out;
  };

  const lines = [];
  lines.push(`【最近 ${d} 天】本地记录了 ${win.length} 条（共 ${sanitizeList(list).length} 条）`);

  const bits = [];
  if (stats.done) bits.push(`完成 ${stats.done} 件`);
  if (stats.postponed) bits.push(`改期 ${stats.postponed} 次`);
  if (stats.popped) bits.push(`戳破 ${stats.popped} 颗`);
  if (stats.overdue) bits.push(`逾期 ${stats.overdue} 件`);
  if (bits.length) lines.push(`日程：${bits.join(' · ')}`);

  if (stats.remindersFired) lines.push(`提醒：发出 ${stats.remindersFired} 次`);

  if (stats.aiGenerated || stats.greetingsSent || stats.greetingsUnverified) {
    const ai = [];
    if (stats.aiGenerated) {
      // 来源分布：让 AI 知道"用户平时用本机模型还是离线模板"（只给数，不给内容）
      const by = {};
      for (const e of win) {
        if (e.kind !== 'ai' || e.action !== 'generated') continue;
        const k = e.source || 'unknown';
        by[k] = (by[k] || 0) + cleanCount(e.count);
      }
      const inner = Object.keys(by).sort().map((k) => `${SOURCE_LABEL[k] || k} ${by[k]}`).join(' / ');
      ai.push(`生成 ${stats.aiGenerated} 次（${inner}）`);
    }
    if (stats.greetingsSent) ai.push(`确认发出 ${stats.greetingsSent} 条`);
    if (stats.greetingsUnverified) ai.push(`无法确认 ${stats.greetingsUnverified} 条`);
    lines.push(`AI：${ai.join(' · ')}`);
  }

  if (titles) {
    // ⚠️ **一条一行、而且最新的排最前**：
    //    · 拼成一行的后果是"这一行放不下 → 整行被丢掉"，用户和 AI 就都看不到
    //      最近做过什么了；一条一行时截断才能**逐条**丢。
    //    · 最新的排前面：`clampLines` 是从**末尾**开始丢的，所以丢掉的一定是最老的，
    //      留下的永远是最新的那些 —— 那正是这个摘要的价值所在。
    // 只取最近 10 条：这里要的是"最近在忙什么"，不是流水账。
    const notable = win
      .filter((e) => e.action !== 'created')
      .slice(-10)
      .reverse()
      .map((e) => `- ${describeActivity(e, { includeTitles: true })}`)
      .filter((s) => s.length > 3);
    if (notable.length) {
      lines.push('最近：');
      lines.push(...notable);
    }
  }

  const rendered = clampLines(lines, SUMMARY_MAX_CHARS);
  return {
    text: mask(rendered.text),
    stats,
    truncated: rendered.truncated,
    days: d,
    /** 窗口内（`days` 天）的条数 —— 界面那行"已把 N 条历史纳入摘要"用的就是它 */
    count: win.length,
    /** 本地日志总条数（含窗口外的） */
    total: sanitizeList(list).length,
  };
}

/**
 * 按**行**截断（不是字符串硬切）。
 * ⚠️ 硬切会把最后一行切成半句话，看起来像乱码；能整行放就整行放，放不下就
 *    丢掉整行并说明还剩几行（做法同 core/brief.js 的 clampLines，那边不导出，
 *    所以这里是同一套语义的第二份 —— 两份都只服务各自的输出，别互相 import 出环）。
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
  if (!kept.length) return { text: `${all.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
  let text = `${kept.join('\n')}\n…（还有 ${lines.length - kept.length} 行没放下）`;
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  return { text, truncated: true };
}

/**
 * 一条记录 → 一行中文（本地查看界面用；摘要里的"最近"也用它）。
 *
 * ⚠️ `includeTitles:false` 时**连标题都不出现**（日程标题可能带着人名/事由，
 *    用户要求"标题可以，但要能关"）。
 */
export function describeActivity(entry, args) {
  // ⚠️ 只有**显式 false** 才关标题（写成 `opts.includeTitles ?? true` 也行，
  //    但 `{includeTitles: undefined}` 那种写法用 ?? 与展开默认值的差别很容易看漏）
  const titles = optsOf(args).includeTitles !== false;
  const e = normalizeEntry(entry);
  if (!e) return '';
  const kindLabel = KIND_LABEL[e.kind] || e.kind;
  const what = ACTION_LABEL[`${e.kind}/${e.action}`] || e.action;
  const bits = [`${kindLabel} · ${what}`];
  if (titles && e.title) bits.push(`「${e.title}」`);
  if (e.source) bits.push(SOURCE_LABEL[e.source] || e.source);
  if (e.status) bits.push(STATUS_LABEL[e.status] || e.status);
  if (e.feature) bits.push(TASK_LABEL[e.feature] || e.feature);
  if (Number.isFinite(e.minutes)) bits.push(e.minutes === 0 ? '准点提醒' : `${e.minutes} 分钟前提醒`);
  if (Number.isFinite(e.remainingMs)) bits.push(remainText(e.remainingMs));
  if (cleanCount(e.count) > 1) bits.push(`×${e.count}`);
  return `${stamp(e.at)} ${bits.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// 写入闸门（调用点只碰这两个函数）
// ---------------------------------------------------------------------------

/**
 * 记一条（**过总闸**），返回**新的 activityLog 数组**。
 *
 * ⚠️ 关着的时候返回的是**原数组本身**（同一个引用）：调用方据此就能判断
 *    "什么都没发生"，也就不会去做一次没必要的持久化。
 * ⚠️ 这一步**不落库**：持久化是调用方的事（core/state-ops.js 的约定：改 db、
 *    由调用方 persist）。
 */
export function recordActivity(settings, kind, action, payload, now, opts = {}) {
  const s = (settings && typeof settings === 'object' && !Array.isArray(settings)) ? settings : null;
  if (!s) return [];
  const cfg = readActivitySettings(s);
  // ⚠️ 关着时返回的是**原来的值本身**（可能是 undefined）：调用方用 `===` 一眼判断
  //    "什么都没记"，也就不会写一次没必要的持久化（也不会凭空造出这个键）。
  if (!cfg.enabled) return s.activityLog;            // 总闸关着 → 一个字节都不写
  const list = Array.isArray(s.activityLog) ? s.activityLog : [];
  const entry = newActivity(kind, action, payload, now);
  if (!entry) return s.activityLog;
  return appendActivityDedup(list, entry, {
    ...opts,
    now: entry.at,
    maxEntries: opts.maxEntries == null ? cfg.maxEntries : opts.maxEntries,
    maxDays: opts.maxDays == null ? cfg.maxDays : opts.maxDays,
  });
}

/**
 * **就地**记一条（写回 `settings.activityLog`），返回是否真的记了。
 *
 * ⚠️ 为什么允许"就地"：调用点全在 core 的写操作里（`popEvent` / `upsertEvent` /
 *    `patchEvent`），那些函数本来就是"就地改 db、由调用方持久化"的约定
 *    （见 core/state-ops.js 文件头）。有了它，每个记录点**只加一行**，
 *    不必写成 `db.settings.activityLog = recordActivity(...)`（那种写法在
 *    7 个地方各写一遍，迟早有人写成两行或写错对象）。
 */
export function logActivity(settings, kind, action, payload, now, opts = {}) {
  const next = recordActivity(settings, kind, action, payload, now, opts);
  if (!settings || typeof settings !== 'object') return false;
  if (next === settings.activityLog) return false;
  settings.activityLog = next;
  return true;
}
