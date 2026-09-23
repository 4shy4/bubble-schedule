// 同步层（4c）：把两台设备上的数据合到一起。
//
// ⚠️ 这个文件解决的核心难题是**删除**。
//    `tools/sync-to-phone.ps1` 的文件头早就写过一句很准的话：
//      "双向合并很难做对，因为**删除无法用合并表达** —— 删掉的东西会被合回来。"
//    确实如此：按记录合并时，"A 那边没有这条" 和 "A 把这条删了" 长得一模一样，
//    于是删掉的会被对方重新合回来。
//
//    解法是**墓碑（tombstone）**：删除不写"没了"，而是写"这个 id 在 T 时刻被删了"。
//    有墓碑就能把"对方新增"和"我删掉了"区分开：
//      · 墓碑比记录新 → 删
//      · 记录比墓碑新 → 复活（用户重新创建了同一个 id）
//    墓碑会定期清理（超过 PRUNE_DAYS 就扔），否则文件会一直变大。
//
// ⚠️ 墓碑里必须连**类别**一起记（`{ at, category }`）。
//    因为按类别筛选同步时（"只同步课表"），面对一条已删除的事件，
//    光看 id 无法判断它当初是课表还是气泡 —— 那会导致：
//      · 该发的墓碑没发 → 对方把删掉的课又合回来
//      · 不该发的墓碑发了 → 把用户明确选择"不同步"的那类东西删掉
//    两者都是静默的数据损坏，所以类别必须记下来。
//
// 同步范围（有意的决定）：
//   只同步 **events + courses**，**不同步 settings**。
//   理由：settings 里混着两类东西 ——
//     · 设备相关的（notify 强度、开机自启、局域网）——跨设备同步是**错的**，
//       iPad 的提醒强度和 Windows Toast 本来就不该一样
//     · 学期相关的（termStart / sectionTimes）——跟着课表走，而课表是从电脑导入的
//   把 settings 排除掉能一次绕开"两台设备互相覆盖设置"那一大类怪问题。
//   以后真要同步学期设置，单独做，别混进这条链路。

/** 可同步的类别。`bubbles` = 气泡区（个人日程/任务），`courses` = 课表 */
export const SYNC_CATEGORIES = ['courses', 'bubbles'];

/** 默认筛选：全都同步 */
export const SYNC_FILTER_ALL = { mode: 'all', categories: [] };

/**
 * 要不要清理老墓碑 —— **默认不要**。
 *
 * ⚠️ 这条改动是有实测依据的（2026-09-22 量的）：
 *     单条墓碑 76 字节 → 1000 条 74 KB、10000 条 742 KB，
 *     而整个 db.json 现在才 72 KB。**清理省下的空间基本是零。**
 *
 *   而清理的代价是那个它本来要防的 bug：
 *     一台设备超过清理期限没同步 → 它那边的旧记录还在、对端的墓碑却没了
 *     → 合并时"对端没有"和"对端删了"又分不开 → **删掉的东西自己回来了**。
 *     这正是 `tools/sync-to-phone.ps1` 文件头警告过的现象。
 *
 *   所以：**留着墓碑**。它换来的正确性是免费的。
 *
 * `pruneTombstones()` 仍然保留（能显式调用），但只在"文件真的太大了、
 * 并且你已经接受'长期没同步的设备可能把旧记录带回来'"时才用。
 * 想安全地清理，得先做**按设备的水位线**（每个设备都同步过某个时间点之后，
 * 才能扔掉那之前的墓碑）—— 那需要设备身份，本应用暂时没有，
 * 在只有 2~3 台设备、删除量很小的场景下也不值得。触发条件：墓碑超过 ~1 MB。
 */
export const PRUNE_DAYS = 30;

/** 一条事件属于哪个类别 */
export function categoryOfEvent(ev) {
  return (ev && ev.type === 'course') ? 'courses' : 'bubbles';
}

/**
 * 这次同步要不要带上某个类别。
 *
 * @param {{mode:'all'|'whitelist'|'blacklist', categories:string[]}} filter
 *   白名单：只同步列出的；黑名单：除列出的都同步。
 *   用户的例子：白名单+[courses] = "只同步课表"；黑名单+[bubbles] = "只不同步气泡区"
 */
export function categoryEnabled(filter, category) {
  const f = filter || SYNC_FILTER_ALL;
  const list = Array.isArray(f.categories) ? f.categories : [];
  if (f.mode === 'whitelist') return list.includes(category);
  if (f.mode === 'blacklist') return !list.includes(category);
  return true;   // all / 未识别 → 全同步（宁可多同步，也别把人的数据卡住）
}

/** 规范化筛选设置（存进 settings 的是用户填的任意值） */
export function normalizeFilter(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const mode = ['all', 'whitelist', 'blacklist'].includes(f.mode) ? f.mode : 'all';
  const categories = (Array.isArray(f.categories) ? f.categories : [])
    .filter((c) => SYNC_CATEGORIES.includes(c));
  return { mode, categories };
}

// ---------------------------------------------------------------------------
// 墓碑
// ---------------------------------------------------------------------------

/** 确保 db.tombstones 结构存在 */
function graves(db) {
  if (!db.tombstones || typeof db.tombstones !== 'object') {
    db.tombstones = { events: {}, courses: {} };
  }
  if (!db.tombstones.events) db.tombstones.events = {};
  if (!db.tombstones.courses) db.tombstones.courses = {};
  return db.tombstones;
}

/** 墓碑的时间（兼容老的"纯字符串"写法） */
export function graveAt(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v.at || '');
}

/** 墓碑当初属于哪个类别（老的纯字符串写法按 bubbles 处理） */
export function graveCategory(v, kind) {
  if (v && typeof v === 'object' && v.category) return v.category;
  return kind === 'courses' ? 'courses' : 'bubbles';
}

/** 记一条删除。`kind` 是 'events' 或 'courses' */
export function markDeleted(db, kind, key, at, category) {
  const g = graves(db);
  if (!g[kind]) g[kind] = {};
  g[kind][String(key)] = {
    at: at || new Date().toISOString(),
    category: category || (kind === 'courses' ? 'courses' : 'bubbles'),
  };
}

/** 撤销墓碑（用户重新创建了同一个 id —— 复活必须是可能的） */
export function clearTombstone(db, kind, key) {
  const g = graves(db);
  if (g[kind] && g[kind][String(key)] !== undefined) delete g[kind][String(key)];
}

export function tombstonesOf(db) {
  const g = graves(db);
  return { events: { ...g.events }, courses: { ...g.courses } };
}

/**
 * 墓碑的规模。给自己/界面一个"要不要清理"的判断依据 ——
 * 有了这个数就不用凭感觉调参（实测 76 字节/条，攒到 1 MB 要一万三千条删除）。
 */
export function tombstoneStats(db) {
  const g = tombstonesOf(db);
  const events = Object.keys(g.events).length;
  const courses = Object.keys(g.courses).length;
  const total = events + courses;
  return {
    events, courses, total,
    // 粗略字节数：每条 {"id":{"at":"...","category":"..."}} ≈ 76 字节
    approxBytes: total * 76,
  };
}

/** 丢掉太老的墓碑（合并成功之后调用） */
export function pruneTombstones(db, now = new Date(), days = PRUNE_DAYS) {
  const g = graves(db);
  const cutoff = now.getTime() - days * 86_400_000;
  let removed = 0;
  for (const kind of ['events', 'courses']) {
    for (const [k, v] of Object.entries(g[kind] || {})) {
      const ms = new Date(graveAt(v)).getTime();
      if (Number.isFinite(ms) && ms < cutoff) { delete g[kind][k]; removed += 1; }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 取载荷 / 合并 / 写回
// ---------------------------------------------------------------------------

/** 一条记录的"最后修改时刻"（毫秒）。事件用 updatedAt，课程用 importedAt */
function timeOfEvent(ev) {
  const ms = new Date((ev && (ev.updatedAt || ev.createdAt)) || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}
function timeOfCourse(c) {
  const ms = new Date((c && (c.importedAt || c.updatedAt)) || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 把一份载荷按筛选规则**裁一遍**。
 *
 * ⚠️ 为什么服务端也必须裁，不能只信客户端自己的 `syncPayloadOf`：
 *    筛选是用户的**明确选择**（"只同步课表"）。如果只靠客户端自觉，
 *    一个旧版本客户端、或者一个手写的请求，就能把气泡区也推上来 ——
 *    于是"我明明选了只同步课表，气泡还是被覆盖了"。
 *    所以服务端收到什么都要按 filter 再裁一次：**filter 是权威，不是建议**。
 */
export function filterPayload(payload, filter) {
  const f = normalizeFilter(filter);
  const src = payload && typeof payload === 'object' ? payload : {};
  const out = {
    events: [],
    courses: [],
    tombstones: { events: {}, courses: {} },
    generatedAt: src.generatedAt || null,
    filter: f,
  };
  if (categoryEnabled(f, 'courses')) out.courses = Array.isArray(src.courses) ? src.courses.slice() : [];
  out.events = (Array.isArray(src.events) ? src.events : []).filter((e) => categoryEnabled(f, categoryOfEvent(e)));

  const g = (src.tombstones && typeof src.tombstones === 'object') ? src.tombstones : {};
  if (categoryEnabled(f, 'courses')) out.tombstones.courses = { ...(g.courses || {}) };
  for (const [id, v] of Object.entries(g.events || {})) {
    if (categoryEnabled(f, graveCategory(v, 'events'))) out.tombstones.events[id] = v;
  }
  return out;
}

/**
 * 按筛选规则取出"可以同步的那部分"。
 * 不在筛选范围内的类别**整个不出现**在载荷里 —— 这样对方就不会去动它。
 */
export function syncPayloadOf(db, filter, now = new Date()) {
  const f = normalizeFilter(filter);
  const g = tombstonesOf(db);
  const payload = {
    events: [],
    courses: [],
    tombstones: { events: {}, courses: {} },
    generatedAt: now.toISOString(),
    filter: f,
  };

  if (categoryEnabled(f, 'courses')) {
    payload.courses = (db.courses || []).slice();
    payload.tombstones.courses = g.courses;
  }
  // events 按**每条自己的类别**过滤：课表事件归 courses，其余归 bubbles
  payload.events = (db.events || []).filter((e) => categoryEnabled(f, categoryOfEvent(e)));
  // 事件墓碑：按墓碑里记的类别过滤（这正是"墓碑要连类别一起记"的原因）
  for (const [id, v] of Object.entries(g.events)) {
    if (categoryEnabled(f, graveCategory(v, 'events'))) payload.tombstones.events[id] = v;
  }
  return payload;
}

/**
 * 合并两份载荷。**纯函数**，不改入参。
 *
 * 规则（简单、可预测，比"聪明"重要）：
 *   · 记录按 key 聚合，比较"最后修改时刻"，**新的赢**
 *   · 墓碑不早于记录 → 删；记录比墓碑新 → 复活
 *   · 只有一边有的记录 → 保留（"对方新增" 或 "我新增"）
 *   · 墓碑取并集，同一个 id 取更晚的那个时间
 *
 * ⚠️ 时间戳是唯一仲裁者 —— 所以**两台设备的时钟不能差太多**。
 *    差几秒无所谓（同一秒内的并发改动会有一边被覆盖，可接受）；
 *    差几天就会出怪事。本地优先应用里这是标准取舍。
 */
export function mergeSync(local, remote, now = new Date()) {
  const out = {
    events: [],
    courses: [],
    tombstones: { events: {}, courses: {} },
    generatedAt: now.toISOString(),
    stats: { eventsKept: 0, eventsDeleted: 0, coursesKept: 0, coursesDeleted: 0 },
  };

  for (const kind of ['events', 'courses']) {
    const a = (local && local.tombstones && local.tombstones[kind]) || {};
    const b = (remote && remote.tombstones && remote.tombstones[kind]) || {};
    const merged = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const cur = merged[k];
      if (cur === undefined || new Date(graveAt(v)).getTime() > new Date(graveAt(cur)).getTime()) {
        merged[k] = v;
      }
    }
    out.tombstones[kind] = merged;
  }

  const pick = (aList, bList, keyOf, timeOf, kind) => {
    const byKey = new Map();
    for (const r of [...(aList || []), ...(bList || [])]) {
      if (!r || r[keyOf] === undefined || r[keyOf] === null) continue;
      const k = String(r[keyOf]);
      const prev = byKey.get(k);
      if (!prev || timeOf(r) >= timeOf(prev)) byKey.set(k, r);
    }
    const keep = [];
    const grave = out.tombstones[kind] || {};
    for (const [k, rec] of byKey) {
      const v = grave[k];
      if (v !== undefined && new Date(graveAt(v)).getTime() >= timeOf(rec)) continue;  // 墓碑更新 → 删
      keep.push(rec);
    }
    return keep;
  };

  const totalKeys = (aList, bList, keyOf) => {
    const s = new Set();
    for (const r of [...(aList || []), ...(bList || [])]) {
      if (r && r[keyOf] !== undefined && r[keyOf] !== null) s.add(String(r[keyOf]));
    }
    return s.size;
  };

  out.events = pick(local && local.events, remote && remote.events, 'id', timeOfEvent, 'events');
  out.courses = pick(local && local.courses, remote && remote.courses, 'key', timeOfCourse, 'courses');
  out.stats.eventsKept = out.events.length;
  out.stats.coursesKept = out.courses.length;
  out.stats.eventsDeleted = totalKeys(local && local.events, remote && remote.events, 'id') - out.events.length;
  out.stats.coursesDeleted = totalKeys(local && local.courses, remote && remote.courses, 'key') - out.courses.length;
  return out;
}

/**
 * 把合并结果写回 db —— **只写筛选允许的类别**。
 * 不在筛选里的类别原样不动（那正是"只同步课表"的语义）。
 */
export function applySync(db, merged, filter) {
  const f = normalizeFilter(filter);
  const g = graves(db);
  const mergedEvents = (merged && merged.events) || [];
  const mergedGrave = (merged && merged.tombstones) || { events: {}, courses: {} };
  const doCourses = categoryEnabled(f, 'courses');
  const doBubbles = categoryEnabled(f, 'bubbles');

  if (doCourses) {
    db.courses = ((merged && merged.courses) || []).slice();
    g.courses = { ...(mergedGrave.courses || {}) };
  }
  // 分别替换两个类别的事件，另一类保持原样
  let events = (db.events || []).slice();
  if (doBubbles) {
    events = [...events.filter((e) => categoryOfEvent(e) !== 'bubbles'),
      ...mergedEvents.filter((e) => categoryOfEvent(e) === 'bubbles')];
  }
  if (doCourses) {
    events = [...events.filter((e) => categoryOfEvent(e) !== 'courses'),
      ...mergedEvents.filter((e) => categoryOfEvent(e) === 'courses')];
  }
  db.events = events;

  // 事件墓碑：只吸收"类别被允许"的那些
  for (const [id, v] of Object.entries(mergedGrave.events || {})) {
    if (categoryEnabled(f, graveCategory(v, 'events'))) g.events[id] = v;
  }
  db.rev = (Number(db.rev) || 0) + 1;
  return db;
}
