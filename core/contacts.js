// 好友（联系人）—— **数据形状 + 增删改查**，平台无关。
//
// 用户原话（第 48–49 轮）：
//   "用户可添加包括但不限于微信和QQ的好友，节日当日特定时间由AI生成符合当日的祝福语"
//   "用户可输入一些关键词来让AI更好地了解客户，并更个性化地发送消息，
//    用户也可补充与好友相关的关键词以使AI更亲切地发送合适的祝语"
//   "这个功能还可以拓展，比如将某些日程发给某些好友，提醒他们完成一些团队项目中自己的任务"
//
// ⚠️ 好友存在**设置**里（`settings.contacts`），不新建 db 顶层结构。理由有三条，都不是随便选的：
//   ① 备份/恢复（core/state-ops.js 的 restoreBackup）本来就整份带走 settings ——
//      存这里，"换台电脑好友还在"是白送的；存顶层新键就得同时改备份、同步、恢复三处。
//   ② 三端同步（4c）按 settings 整体走，好友跟着走，不用新开一条同步类别。
//   ③ 数据量小（CONTACTS_MAX = 200），不值得为它单开一张表和一套迁移。
//
// ⚠️ 但 `settings.contacts` **必须在 core/defaults.js 的 defaultDb() 里登记**，
//    否则老库里读出来是 `undefined`（`mergeDefaults` 靠缺省值知道要补什么）。
//    本轮任务划定的改动范围里没有 defaults.js，所以**这里只做读取端的兜底**：
//    `settings.contacts` 不是数组时 `normalizeContacts` 一律返回 []，
//    绝不会让界面炸。登记缺省值这一笔留给下一轮（见汇报里的"没做/待办"）。
//
// ⚠️ 关于"全局关键词"：用户说的是两层关键词 —— 一层描述**我自己**（我是做什么的、
//    语气偏好、称呼习惯），一层描述**这个好友**。本模块只负责第二层（contact.keywords）
//    和把两层**合并**（contactKeywords）。合并必须走这一个函数：
//    生成祝福语的地方如果各自写一遍"全局 + 好友"，一定会漂移成两种顺序/两种去重规则，
//    而 AI 的输入只要差一个字，缓存就命中不了（见 core/greetings.js 的说明）。

/** 通道。用户说"包括但不限于微信和QQ"，所以 `other` 是**必留**的兜底，不要删 */
export const CONTACT_CHANNELS = Object.freeze([
  { key: 'wechat', label: '微信' },
  { key: 'qq', label: 'QQ' },
  { key: 'other', label: '其它' },
]);

/** 语气。`tone` 是**每个好友**的属性（同一个人对不同客户不可能一个语气） */
export const GREETING_TONES = Object.freeze([
  { key: 'casual', label: '轻松' },
  { key: 'formal', label: '正式' },
  { key: 'brief', label: '简短' },
  { key: 'humor', label: '幽默' },
]);

/**
 * 好友数量上限。
 *
 * ⚠️ 超限**必须报错**（`throw`），不许静默丢最后一条。
 *    静默丢的症状是"我明明加进去了，列表里没有" —— 用户根本无从判断是没保存、
 *    还是同步没上来、还是被限流了。宁可当场弹一句"最多 200 个好友"。
 *    200 也不是技术上限，是"一个人真会一条条发祝福的规模"。
 */
export const CONTACTS_MAX = 200;

/** 一个好友最多几个关键词（多了 AI 的输入会糊，也会把 prompt 撑贵） */
export const CONTACT_KEYWORDS_MAX = 20;
/** 合并后（全局 + 好友）最多几个 */
export const MERGED_KEYWORDS_MAX = 30;
/** 单个关键词最长多少个字 */
export const KEYWORD_MAX_LEN = 20;
/** 备注/昵称/关系最长的字数（防手滑粘一整篇文章进来） */
export const CONTACT_TEXT_MAX = 200;
/** 昵称/名字最长 */
export const CONTACT_NAME_MAX = 40;

const CHANNEL_KEYS = CONTACT_CHANNELS.map((c) => c.key);
const TONE_KEYS = GREETING_TONES.map((t) => t.key);

/** 默认语气：轻松。对熟人喊一声"中秋快乐"最不会出错 */
export const DEFAULT_TONE = 'casual';
/** 默认通道：微信。国内默认就是它 */
export const DEFAULT_CHANNEL = 'wechat';

// ---------------------------------------------------------------------------
// 稳定 id：**不许用 Math.random**
//
// 为什么这条是硬要求（不只是洁癖）：
//   · 祝福语的"可复现"要求"输入相同 → 输出完全相同"（测试要钉死这一条）。
//     id 是用输入的一部分，只要 id 里掺了随机数，"同样的输入"就再也复现不了，
//     连"同一个人同一节日不重复发"的判重都跟着失效。
//   · 测试要能断言 id，用了随机数就只能断言"不是空字符串"，等于没测。
//
// 所以 id = `c-` + 名字/时间戳/序号 的稳定哈希 + 序号。
// API 清单和哈希长度都按输入决定，固定长度；序号保证"同一毫秒内加两个人"也不撞。
// ⚠️ 这不是安全哈希（FNV-1a 32 位），**不要**拿它当密码/去重键之外的用途；
//    这里的唯一职责是"本地列表里区分两条记录"。
// ---------------------------------------------------------------------------

let idSeq = 0;

function nextIds() {
  idSeq += 1;
  return idSeq;
}

function base36(n) {
  return Math.max(0, Math.floor(Number(n) || 0)).toString(36);
}

/** 稳定字符串哈希（FNV-1a 32 位变体），只用于"选哪条模板/生成 id" */
function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // 乘 16777619，用移位加法避免 32 位乘法溢出（结果是同一个数，各端一致）
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** `Date | ISO 串` → ISO 串。丢弃非法值（返回 null 而不是捏一个当前时间） */
function isoOrNull(v) {
  if (typeof v === 'string' && v.trim()) {
    const t = new Date(v.length === 10 ? `${v}T00:00:00` : v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (v instanceof Date && Number.isFinite(v.getTime())) return new Date(v.getTime()).toISOString();
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return null;
}

/**
 * 归一化"现在"。
 *
 * ⚠️ 这里**不**兜底成"当前时间"以外的任何东西，也**不**在调用方各自 `new Date()`：
 *    一个祝福任务从"判定该发"到"落库"要经过好几层，每层各自取一次时钟，
 *    跨零点时就会出现"判定是今天、记的是明天"这种对不上的账。
 */
function nowDate(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return new Date(now.getTime());
  const iso = isoOrNull(now);
  if (iso) return new Date(iso);
  return new Date();
}

/**
 * 文本字段归一化。
 *
 * ⚠️ 对象/数组**不能**直接 `String()`：那会得到 `'[object Object]'` ——
 *    而它是个"看起来正常"的非空字符串，会一路混进昵称和祝福语里
 *    （"老王，[object Object]快乐"）。所以非标量一律当没填。
 *    数字/布尔还是收的（昵称写成 12345 是真人会干的事）。
 */
export function textOf(v, max = CONTACT_TEXT_MAX) {
  if (v == null) return '';
  const t = typeof v;
  if (t !== 'string' && t !== 'number' && t !== 'boolean') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function channelOf(v) {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return CHANNEL_KEYS.includes(k) ? k : DEFAULT_CHANNEL;
}

function toneOf(v) {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return TONE_KEYS.includes(k) ? k : DEFAULT_TONE;
}

/**
 * 关键词归一化：去空、去首尾标点、去重（**保留原顺序**）。
 *
 * ⚠️ 顺序要保留：关键词是要拼进 AI 输入的一串字，同样的关键词换个顺序
 *    就是另一个字符串，prompt 缓存会**直接失效**（价差 50 倍那条，见 greetings.js）。
 */
export function normalizeKeywords(list, max = CONTACT_KEYWORDS_MAX) {
  const out = [];
  const seen = new Set();
  const src = Array.isArray(list) ? list : (list == null ? [] : [list]);
  for (const raw of src) {
    if (out.length >= max) break;
    if (raw == null) continue;
    const s = String(raw).replace(/^[\s,，、;；]+|[\s,，、;；]+$/g, '').trim();
    if (!s) continue;
    const cut = s.length > KEYWORD_MAX_LEN ? s.slice(0, KEYWORD_MAX_LEN) : s;
    const key = cut.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cut);
  }
  return out;
}

/** 一个新 id：`c-` 前缀是**稳定**的（界面/日志一眼看出这是好友 id） */
export function contactId(seed, seq) {
  const n = Number.isFinite(Number(seq)) ? Math.floor(Number(seq)) : nextIds();
  return `c-${base36(hash32(String(seed == null ? '' : seed)))}${base36(n)}`;
}

/** 空白的合法好友骨架（id 一定要有，不许留空 —— 后面所有操作都按 id 找） */
export function newContact(patch = {}, now) {
  const at = nowDate(now).toISOString();
  const src = (patch && typeof patch === 'object') ? patch : {};
  const name = textOf(src.name, CONTACT_NAME_MAX);
  if (!name) {
    // 名字是唯一**必填**的：没有名字，"发给谁"这件事就不成立。
    // 昵称(nick)才是写祝福语最关键的字段，但它可以后补（见下面的注释）。
    throw new Error('好友名字不能为空');
  }
  const id = src.id != null && String(src.id).trim()
    ? String(src.id).trim()
    : contactId(`${name}|${at}`, nextIds());
  return {
    id,
    name,
    // ⚠️ `nick` = **"我平时怎么叫他"**，是写祝福语**最关键的一个字段**。
    //    不是"更短的名字"这么简单：
    //      · `name` 可能只是通讯录里的一个大名（"王建国"），拿去开口叫很生硬；
    //      · 祝福语真正要的是**你日常那张嘴怎么喊他**（"老王""建国哥""师父"）。
    //        称呼错了，整条祝福语就废了（"亲爱的王建国"发给铁哥们是灾难）。
    //      · 它还决定语气：叫"老师"就不能用幽默档，叫"老王"就不该用正式档。
    //    所以 nick 参与两件事：文本里的称呼，以及给 AI 的"关系信号"。
    //    为空时**回退到 name**，而不是丢弃这条线索。
    nick: textOf(src.nick, CONTACT_NAME_MAX),
    channel: channelOf(src.channel),
    relation: textOf(src.relation, CONTACT_NAME_MAX),
    keywords: normalizeKeywords(src.keywords),
    note: textOf(src.note),
    tone: toneOf(src.tone),
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * 脏数据兜底。目标是**任何输入都能收敛成合法 contact**，不抛错。
 *
 * 为什么必须有它：`settings.contacts` 会跟着备份/同步/手改 JSON 走三端，
 * 里面出现 `null`、字符串、缺字段、多字段都是**迟早的事**。
 * 界面列表要是拿到一个 `nick` 是对象的记录，格式化时就炸在渲染里 —— 且炸在用户手上。
 *
 * 规则（和老库"能自愈就自愈"的原则一致）：
 *   · 缺 id → 按内容生成一个稳定的（同一份脏数据两次归一化得到同一个 id，
 *     否则每次读一遍就多一个新好友）
 *   · 非法 channel/tone → 落回默认值（**不删这条**：宁可猜错通道，也别让好友消失）
 *   · 多余字段 → 丢弃（写回库里的是干净的形状）
 *   · 非法时间戳 → 记成 null 也仍然要有（`updatedAt` 保住"我改过它"这个事实）
 *   · 名字彻底没有 → 用"未命名好友"占位。**不在这里 throw**：throw 会让
 *     整份设置读不出来（一条脏数据废掉整个设置页），这比显示一个占位名严重得多。
 */
export function normalizeContact(raw, fallbackSeq) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    // 连对象都不是：给它一个稳定的空壳（内容固定 → id 也固定）
    return newContact({ name: '未命名好友', id: contactId('unnamed', 0) });
  }
  const name = textOf(raw.name, CONTACT_NAME_MAX) || '未命名好友';
  const createdAt = isoOrNull(raw.createdAt) || isoOrNull(raw.updatedAt);
  const updatedAt = isoOrNull(raw.updatedAt) || createdAt;
  const seq = Number.isFinite(Number(fallbackSeq)) ? Math.floor(Number(fallbackSeq)) : nextIds();
  const id = raw.id != null && String(raw.id).trim()
    ? textOf(raw.id, 80)
    : contactId(`${name}|${createdAt || ''}`, seq);
  const at = createdAt || nowDate(undefined).toISOString();
  return {
    id,
    name,
    nick: textOf(raw.nick, CONTACT_NAME_MAX),
    channel: channelOf(raw.channel),
    relation: textOf(raw.relation, CONTACT_NAME_MAX),
    keywords: normalizeKeywords(raw.keywords),
    note: textOf(raw.note),
    tone: toneOf(raw.tone),
    createdAt: at,
    updatedAt: updatedAt || at,
  };
}

/**
 * 数组兜底 + **id 唯一性**。
 *
 * ⚠️ id 重复不是"理论情况"：同步合并（4c）、手改 JSON、旧版本 bug 都会造出来。
 *    一旦重复，`upsertContact` 按 id 找会只改到第一个，删一个会删错人。
 *    所以这里给重复的补一个**确定性的**新 id（同样的输入 → 同样的补法，可复现）。
 */
export function normalizeContacts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  let n = 0;
  for (const raw of list) {
    n += 1;
    const c = normalizeContact(raw, n + 1000);   // 序号错开，避免和"新建"路径撞号
    let id = c.id;
    let bump = 0;
    while (seen.has(id)) {
      bump += 1;
      id = `c-${base36(hash32(c.name))}${base36(n * 977 + bump)}`;
    }
    seen.add(id);
    out.push(id === c.id ? c : { ...c, id });
  }
  return out;
}

/** 按 id 找一个（找不到 → null，**不抛错**：调用方多半是在读列表里的某条） */
export function findContact(list, id) {
  if (!Array.isArray(list) || id == null) return null;
  const key = String(id);
  return list.find((c) => c && String(c.id) === key) || null;
}

/**
 * 按名字找**全部**同名好友。
 *
 * ⚠️⚠️ 这里返回**数组**是刻意的，是本模块最重要的一条约定：
 *    "王伟"在通讯录里有两个是常态。任何"按名字发消息"的路径如果默认取第一个，
 *    就会**把祝福语发给错的人** —— 而且用户事后完全不知道发生过（消息已经出去了）。
 *    所以：返回列表 → 界面必须让用户选 → 选不出来时走 send-task 的
 *    `AMBIGUOUS_RECIPIENT`。这条链路上**没有任何一处允许猜**。
 *
 * 匹配规则：`name` 或 `nick` 完全相等才算（大小写/空格宽松）。
 * 不做"包含匹配"：那会让"小王"和"王"撞在一起，等于又回到猜。
 */
export function findContactsByName(list, name) {
  if (!Array.isArray(list)) return [];
  const key = String(name == null ? '' : name).replace(/\s+/g, '').toLowerCase();
  if (!key) return [];
  return list.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    const a = String(c.name || '').replace(/\s+/g, '').toLowerCase();
    const b = String(c.nick || '').replace(/\s+/g, '').toLowerCase();
    return a === key || b === key;
  });
}

/**
 * 新增或更新一个好友，**返回新数组**（不改原数组）。
 *
 * ⚠️ 为什么不就地改：
 *   · `settings.contacts` 是从 db 里读出来的引用，就地 push 会让"改了一半"
 *     变成可见状态（界面可能正好在渲染），而 updateSettings 又是一层浅合并；
 *   · 不可变更容易写测试（`assert.notEqual(list, next)`），也更容易在失败时回滚。
 *   所以：**拿到返回值必须写回设置**，别指望它改了你手里的那份。
 *
 * 超限抛错（`CONTACTS_MAX`），不许静默丢最后一条 —— 见常量上的说明。
 */
export function upsertContact(list, contact, now) {
  const at = nowDate(now).toISOString();
  const incoming = (contact && typeof contact === 'object') ? contact : {};
  const id = incoming.id != null && String(incoming.id).trim() ? String(incoming.id).trim() : '';

  if (id) {
    const cur = (Array.isArray(list) ? list : []).find((c) => c && String(c.id) === id);
    if (cur) {
      // 什么都不给就什么都不改（免得"只改备注"把关键词抹了）
      const patch = { ...incoming };
      delete patch.createdAt;                     // 创建时间不许被改
      const next = normalizeContact({ ...cur, ...patch, id }, 0);
      next.createdAt = isoOrNull(cur.createdAt) || next.createdAt;   // 保住原来的创建时间
      next.updatedAt = at;
      return (list || []).map((c) => (c && String(c.id) === id ? next : c));
    }
  }

  const base = id
    ? { ...newContact({ ...incoming, id }, now), id }
    : newContact(incoming, now);
  const name = textOf(base.name, CONTACT_NAME_MAX);
  if (!name) throw new Error('好友名字不能为空');
  const src = Array.isArray(list) ? list : [];
  if (src.length >= CONTACTS_MAX) {
    throw new Error(`最多只能有 ${CONTACTS_MAX} 个好友，先删掉几个再加`);
  }
  const record = { ...base, name, createdAt: at, updatedAt: at };
  return [...src, record];
}

/**
 * 删一个好友，**返回新数组**。
 *
 * ⚠️ 删不存在的 id **不抛错**、原样返回（复制一份）。
 *    同步场景里"我这边删了、对方那边也删了"是正常的，抛错会把整个同步打断；
 *    而删除本来就不该有"必须存在"的前提。
 * ⚠️ 这里**不**记墓碑（core/sync.js 那套）：好友长在 settings 里，
 *    同步按 settings 整体走，没有"按条 tombstone"的机制。这一条是**已知缺口**：
 *    将来若做"只同步 settings 的一部分"，删除就会在合并时被对方合回来。
 */
export function removeContact(list, id, now) {
  const src = Array.isArray(list) ? list : [];
  const key = id == null ? '' : String(id);
  void now;   // 参数保留（签名契约）：将来要记删除时间时不用改调用方
  if (!key) return src.slice();
  return src.filter((c) => !(c && String(c.id) === key));
}

/**
 * 合并"全局关键词 + 这个好友的关键词"。
 *
 * ⚠️ 这是**唯一**允许做这件事的地方（看文件头）。两层关键词的顺序固定为
 *    "全局在前、好友在后"（好友的更具体，让 AI 优先看到）。
 * ⚠️ 全局关键词从 `profile` 里读，字段名有**三个名字**是历史原因：
 *    下一轮的设置界面还没定稿，我先认 `keywords`；为了不让调用方在这一轮
 *    猜错字段名，这里同时认 `globalKeywords` 和 `commonKeywords`。
 *    等界面定下来应当**只留一个**，多认一个就多一份漂移。
 */
export function contactKeywords(contact, profile) {
  const c = (contact && typeof contact === 'object') ? contact : {};
  const p = (profile && typeof profile === 'object') ? profile : {};
  const global = p.keywords != null ? p.keywords
    : (p.globalKeywords != null ? p.globalKeywords : p.commonKeywords);
  return normalizeKeywords(
    [...normalizeKeywords(global, MERGED_KEYWORDS_MAX), ...normalizeKeywords(c.keywords, CONTACT_KEYWORDS_MAX)],
    MERGED_KEYWORDS_MAX,
  );
}

/** 通道的中文名（找不到就原样返回，别把 key 变成 undefined） */
export function channelLabel(key) {
  const hit = CONTACT_CHANNELS.find((c) => c.key === key);
  return hit ? hit.label : String(key == null ? '' : key);
}

/** 语气的中文名 */
export function toneLabel(key) {
  const hit = GREETING_TONES.find((t) => t.key === key);
  return hit ? hit.label : String(key == null ? '' : key);
}

/**
 * 一行中文摘要（好友列表用）。
 *
 * 形如：`老王（客户 · 微信）` / `未命名好友（微信）`
 * ⚠️ 昵称和名字**不一样时都要显示**：列表里显示哪个是用户最容易争论的地方，
 *    而两个都显示就不会丢信息（"哪个是老王？" → 一眼看到"王建国"）。
 *    一样时只显示一次（"王伟（王伟）"是纯噪音）。
 */
export function describeContact(contact) {
  const c = normalizeContact(contact, 0);
  const label = c.nick && c.nick !== c.name ? `${c.name}（${c.nick}）` : c.name;
  const bits = [];
  if (c.relation) bits.push(c.relation);
  bits.push(channelLabel(c.channel));
  return `${label}（${bits.join(' · ')}）`;
}

/** 这个好友"该怎么称呼"—— `nick` 优先，空了回退 `name`（写祝福语的第一句要用） */
export function displayNameOf(contact) {
  const c = (contact && typeof contact === 'object') ? contact : {};
  return textOf(c.nick, CONTACT_NAME_MAX) || textOf(c.name, CONTACT_NAME_MAX) || '朋友';
}

// 说明：`contactId` 依赖的序号在每次加载模块时从 0 开始，
// 所以"同一毫秒造两条同内容的记录"这种极端情况，两个**不同进程**可能得到同一个 id。
// 这没关系：id 一旦写进 settings 就变成了**内容**，三端同步的是内容，
// 不是同一台机器上的计数器；而在同一份数据内部，序号保证唯一。
// `normalizeContacts` 还会再兜一道（见那里的 id 唯一性处理）。
