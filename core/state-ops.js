// 平台无关的「状态操作层」。
//
// 这是 4a 的落点：把原本只活在 `server/store.js` 里的业务逻辑搬到 core，
// 让**三端共用同一份**：
//   · 电脑的服务端（server/store.js 变成薄壳：load → 调这里 → persist）
//   · iPad 的本地适配器（数据存 IndexedDB，操作还是调这里）
//   · 将来的原生 iOS 壳（同样调这里，不需要用 Swift 复刻一遍）
//
// 为什么要这么搬（不是洁癖）：
//   `server/store.js` 里有一批判定**和 core 重复实现**，而且已经漂移了 ——
//   比如"过期（含祖先继承）"这条规则同时存在于
//   `server/store.js`、`web/ui/views/bubble.js`、以及 `bubbleStyle` 内部，
//   三份各自演化。而这个项目自己的原则写在 server/store.js 的注释里：
//   **"判定和显示必须用同一套依据"**。收拢成一份才守得住。
//
// 约定：
//   · 这里的函数**不碰** 文件 / IndexedDB / localStorage —— 持久化由调用方负责
//   · 需要"现在"的地方一律用参数传入（`now`），方便测试与三端对齐
//   · 抛出业务错误时带上 `status`（沿用既有的 { status } 约定，api.js 依赖它）

import {
  DEFAULT_LEVEL, LEVELS, canNestInside, levelByKey, levelFromLegacyMagnitude,
  notificationPlanForRemaining,
} from './level.js';
import { deadlineFromParts as deadlineFromDistance } from './countdown.js';
import { mondayOf } from './time.js';
// 墓碑是同步（4c）能区分"删除"和"没有"的唯一依据 —— 删除路径必须记它
import { markDeleted, clearTombstone, categoryOfEvent } from './sync.js';

const LEVEL_KEYS = new Set(LEVELS.map((l) => l.key));

/** 生成一个事件 id。前缀区分来源（evt_ / course: 等） */
export function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 事件的"到期时刻"（毫秒）—— 也就是**倒计时、气泡大小、过期变紫**用的那个时间。
 *
 * 优先级 `deadline > end > start`（用户 2026-09 明确选定的方案 C）：
 *
 *   · **到期 = 这件事结束了**，所以没填 deadline 时取 `end`。
 *     例：18:30–20:05 的课，19:00 时应当是"还剩 65 分钟"且**不变紫** ——
 *     课还在上，不该显示成已过期。
 *   · **提醒是另一回事**：提醒点一向相对 `start` 算（上课前 10 分钟），
 *     由 core/reminder-plan.js / server/scheduler.js 用 `occurrence.start` 得出，
 *     **不经过这个函数**。两个概念刻意分开，别合并。
 *
 * ⚠️ 这里曾经和 core/urgency.js / bubble.js 各执一套（`deadline > start > end`），
 *    导致"自己变紫按开始、容器变紫按结束"，同一条规则两个答案。
 *    现已统一到本函数 —— 要改只改这里。
 */
export function deadlineMsOf(ev) {
  const raw = ev && (ev.deadline || ev.end || ev.start);
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 还剩多久（毫秒）。没有期限 → null（表示"未设期限"，**不是** 0） */
export function remainingMsOf(ev, now = new Date()) {
  const d = deadlineMsOf(ev);
  if (d == null) return null;
  return d - now.getTime();
}

/**
 * 这个事件是不是"过期"（紫色）。
 *
 * ⚠️ 规则有两层，别混：
 *   · **自己过期**：剩余时间 ≤ 0
 *   · **祖先过期**：母气泡变紫时子气泡也跟着紫（用户明确要求的，见
 *     tools/bubble-style.test.mjs 文件头的 bug ②）
 *
 * 返回布尔值。需要区分这两层的地方（比如渲染时"继承来的紫只画虚线环"）
 * 请用 `overdueStateOf`。
 *
 * 用途之一：过期容器**只读** —— 能进去看，不能往里加子泡泡（用户要求）。
 */
export function isOverdueEvent(ev, allEvents, now = new Date()) {
  return overdueStateOf(ev, allEvents, now).overdue;
}

/**
 * 过期的**分层**结果 —— 渲染层要它才能把"自己过期"和"容器过期"画成两种样子。
 *
 *   { ownOverdue, inheritedOverdue, overdue }
 *
 * ⚠️ 这是"剩余 N 天却是紫色泡泡"那个矛盾的修法：两者都算 overdue（视觉上要有表示），
 *    但**只有 ownOverdue 才该改档位文字**。core/urgency.js 的 bubbleStyle 也用同一套。
 */
export function overdueStateOf(ev, allEvents, now = new Date()) {
  if (!ev) return { ownOverdue: false, inheritedOverdue: false, overdue: false };
  const r = remainingMsOf(ev, now);
  if (r != null && r <= 0) {
    return { ownOverdue: true, inheritedOverdue: false, overdue: true };
  }
  // 母气泡过期 → 子气泡一起变紫（判定也要一致，否则"显示紫但能加子泡泡"）
  let cur = ev.parentId ? allEvents.find((e) => e.id === ev.parentId) : null;
  let guard = 0;
  while (cur && guard < 32) {
    const cr = remainingMsOf(cur, now);
    if (cr != null && cr <= 0) {
      return { ownOverdue: false, inheritedOverdue: true, overdue: true };
    }
    cur = cur.parentId ? allEvents.find((e) => e.id === cur.parentId) : null;
    guard += 1;
  }
  return { ownOverdue: false, inheritedOverdue: false, overdue: false };
}

/** 事件实际生效的提醒列表（自动模式：按当前剩余时间档位实时生成） */
export function effectiveReminders(ev, now = new Date()) {
  if (ev.autoReminders === false) return Array.isArray(ev.reminders) ? ev.reminders : [];
  const remaining = remainingMsOf(ev, now);
  // 没设期限 → 只准点提醒一次，不打扰
  if (remaining == null) return [0];
  return notificationPlanForRemaining(remaining).plan;
}

/**
 * 「未来泡泡」现在该不该出现。
 *
 * 用户定义的语义（原话确认过）：
 *   · `future：true` 时，**`start` = 泡泡出现的日子**（不是"开始做"的时刻）
 *   · 到 `start` 之前，这颗泡泡**只在气泡区不显示** —— 列表/月历/周课表照常显示它
 *     （用户明确选了这一条：气泡区是"眼前该管的"，列表是全部账本）
 *   · 到了 `start` 那天就照常出现，然后按剩余时间倒计时到 `end`
 *
 * 为什么这条判定放在 core 而不是写在 bubble.js 里：
 *   它是**事件模型的语义**（和 deadline/isOverdue 同一层），必须能被单元测试直接钉住；
 *   气泡区只是它的第一个使用者，将来列表要加"未来"角标也得用同一份判定。
 */
export function isNotYetVisible(ev, now = new Date()) {
  if (!ev || ev.future !== true) return false;
  const t = new Date(ev.start).getTime();
  if (!Number.isFinite(t)) return false;              // 没填时间的脏数据 → 当作可见，别把泡泡藏没了
  return t > new Date(now).getTime();
}

/**
 * 这一颗的**祖先容器**里有没有过期的（**不看它自己**）。
 *
 * ⚠️⚠️ 这个函数是为用户报的"**为啥又一圈紫色的齿轮**"补的，别把它和
 * `isOverdueEvent` 混用 —— 二者差一个维度，混用就会出现自相矛盾的界面：
 *
 *   · `isOverdueEvent(ev)` 问的是"**这条日程**到期了吗"，
 *     而它用的是 `ev.deadline || ev.end || ev.start`，也就是**第一次发生**那个期限。
 *   · 重复日程的**本次发生**用的是 `item.deadline`（见 core/recurrence.js 的
 *     occurrenceDeadline：把"开始→截止"这段关系平移到这次发生上）。
 *
 *   于是一颗"上周建的、每周重复"的日程：base 期限在上周（早过了），
 *   而本周/下周那两颗的期限都在将来 —— 渲染层却拿 `isOverdueEvent` 当
 *   "容器过期"的判据，就把这两颗**将来的**泡泡画成了"容器过期"，
 *   即那圈暗紫虚线环（用户看到的"紫齿轮"），而泡泡上的字明明写着"剩余 N 天"。
 *
 *   所以要判"继承来的过期"，只能**沿 parentId 往上问**，不能拿自己的期限凑。
 */
export function inheritedOverdueOf(ev, allEvents, now = new Date()) {
  if (!ev || !Array.isArray(allEvents)) return false;
  let cur = ev.parentId ? allEvents.find((e) => e.id === ev.parentId) : null;
  let guard = 0;
  while (cur && guard < 32) {
    // 用 `isOverdueEvent` 而不是只看它自己的 remaining：
    // 祖父过期时父级也是"有效过期"，只要链上有任意一层过期就算。
    if (isOverdueEvent(cur, allEvents, now)) return true;
    cur = cur.parentId ? allEvents.find((e) => e.id === cur.parentId) : null;
    guard += 1;
  }
  return false;
}

/** 事件当前的紧急档位（调试面板 / 图例 / 服务端调度器都要） */
export function bandForEvent(ev, now = new Date()) {
  const remaining = remainingMsOf(ev, now);
  if (remaining == null) return { band: null, intensity: 1, overdue: false, remaining: null };
  const plan = notificationPlanForRemaining(remaining);
  return { ...plan, remaining };
}

/** 只要档位名（旧接口兼容：以前叫 tierForStart） */
export function bandKeyForEvent(ev, now = new Date()) {
  return bandForEvent(ev, now).band;
}

/**
 * 事件等级（颜色）归一化 + 老数据迁移。
 * 优先级：显式 level > 旧 tier > 旧 magnitude/importance 换算 > 默认。
 *
 * ⚠️ 旧数据只有 magnitude/importance（没有 level），所以**不能读原始字段**，
 *    否则会得到 undefined 再兜底成蓝 —— "红色容器的子气泡只能选蓝"那个 bug 就是这么来的。
 */
export function levelOf(ev) {
  if (ev && ev.level) {
    const k = String(ev.level);
    if (['sky', 'emerald', 'amber', 'red'].includes(k)) return k;
  }
  if (ev && ev.tier) {
    const k = String(ev.tier);
    if (['sky', 'emerald', 'amber', 'red'].includes(k)) return k;
  }
  if (ev && ev.magnitude != null) return levelFromLegacyMagnitude(ev.magnitude);
  if (ev && ev.importance != null) return levelFromLegacyMagnitude(ev.importance);
  return DEFAULT_LEVEL;
}

/**
 * 是不是"重复"事件。
 * 重复日程（有 freq）和课表课程（有 weeks）都算。
 *
 * ⚠️ 判据必须是这两条**都算**：课表事件是 `weeks` 驱动的，
 *    `recurrence.freq` 是 'none'；只看 freq 会把整张课表当成"单次"。
 */
export function isRecurring(ev) {
  if (!ev) return false;
  const rec = ev.recurrence || {};
  if (rec.freq && rec.freq !== 'none') return true;
  return Array.isArray(ev.weeks) && ev.weeks.length > 0;
}

/** 实例的账本键（'YYYY-MM-DD'，**本地**日期）—— 三端必须一致，否则去重会失效 */
export function occurrenceKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 某个气泡的直接子气泡。接 db 而不是自己去 load —— 这样才是纯函数 */
export function childrenOf(db, eventId) {
  const events = (db && db.events) || [];
  return events.filter((e) => e.parentId === eventId);
}

/**
 * 事件是不是已经"彻底结束"（结束时间过去超过 graceMs）。
 * 这种才叫过期结束，不该再提醒。
 */
export function isFinished(ev, now = new Date(), graceMs = 60_000) {
  const end = new Date((ev && (ev.end || ev.start)) || NaN).getTime();
  if (!Number.isFinite(end)) return false;
  return end < now.getTime() - graceMs;
}

// ---------------------------------------------------------------------------
// 会**改状态**的操作（4a 第二刀）
//
// 约定：第一个参数是 db 对象；函数**就地修改**它并返回结果，
//       持久化由调用方负责（服务端 persist 到 db.json，iPad 端写 IndexedDB）。
//       这样同一段业务逻辑两端共用，不会各自漂移。
// ---------------------------------------------------------------------------

/** 统一的 ISO 时间戳。`now` 允许传 Date 或已经是字符串 */
function isoNow(now) {
  if (typeof now === 'string' && now) return now;
  return (now instanceof Date ? now : new Date()).toISOString();
}

/** 找不到事件时的错误（api.js 依赖 err.status） */
function notFound() {
  return Object.assign(new Error('日程不存在'), { status: 404 });
}

/**
 * 戳破一颗泡泡。
 *
 * ⚠️ **按实例记账**是这里的关键。
 *   原来无论什么事件都写 `e.done = true` —— 作用于**整个事件**。
 *   后果：戳破"这周的跑步"，整条重复就结束了，下周不再新生。
 *   用户要的是**每颗实例独立**（"如果提前完成任务，那么 10.5 该浮"）。
 *
 * 数据落在事件上：
 *   · `popped['YYYY-MM-DD'] = { at, remainingMs }` —— 哪几颗被戳破、戳破时还剩多久
 *   · 非重复事件仍然用 `done`（语义清楚，也兼容老数据）
 *
 * `remainingMs` 由**调用方**传入 —— 它算的剩余时间带上了"这次发生"的到期时刻
 * （core/recurrence.js 的 occurrenceDeadline），这里算不出来。
 *
 * 被戳破的容器，其**直接子级会被放出一级**，孙子留在原位。
 */
export function popEvent(db, eventId, opts = {}, now) {
  const events = db.events || [];
  const e = events.find((x) => x.id === eventId);
  if (!e) throw notFound();

  const released = events.filter((c) => c.parentId === eventId);
  const grandparent = e.parentId || null;
  const at = isoNow(now);
  for (const child of released) {
    child.parentId = grandparent;
    // 放出后仍然合法：放到更外层是安全的（外层等级只会更大）
    child.updatedAt = at;
  }

  const occurrence = opts.occurrence ? new Date(opts.occurrence) : null;
  const remainingMs = Number.isFinite(Number(opts.remainingMs)) ? Number(opts.remainingMs) : null;

  if (occurrence && isRecurring(e)) {
    // 重复事件：只记这一颗
    if (!e.popped || typeof e.popped !== 'object') e.popped = {};
    const k = occurrenceKey(occurrence);
    e.popped[k] = { at, remainingMs };
    e.updatedAt = at;
    return { ok: true, event: e, released: released.map((c) => c.id), occurrence: k, mode: 'instance' };
  }

  e.done = true;
  e.poppedAt = at;
  e.updatedAt = at;
  return { ok: true, event: e, released: released.map((c) => c.id), mode: 'event' };
}

/**
 * 还原一颗被戳破的泡泡（用户要求"还原可以有"）。
 * 传 `occurrence` 只还原那一颗；不传则把这条事件的**全部**破裂记录清掉。
 */
export function restorePopped(db, eventId, opts = {}, now) {
  const e = (db.events || []).find((x) => x.id === eventId);
  if (!e) throw notFound();
  const at = isoNow(now);

  if (opts.occurrence && e.popped && typeof e.popped === 'object') {
    const k = occurrenceKey(new Date(opts.occurrence));
    delete e.popped[k];
    e.updatedAt = at;
    return { ok: true, event: e, restored: [k] };
  }

  const keys = e.popped && typeof e.popped === 'object' ? Object.keys(e.popped) : [];
  e.popped = {};
  e.done = false;
  delete e.poppedAt;
  e.updatedAt = at;
  return { ok: true, event: e, restored: keys };
}

/**
 * 回收气泡站的数据：**每个事件一条**（用户要求"合并"）。
 *
 * 用户原话："合并，你很聪明" —— 重复事件戳破 5 次是**一条**记录，
 * 里面带着 5 次破裂的时间与"破裂那一刻的剩余时间"。纯读，不改状态。
 */
export function poppedRecords(db) {
  const out = [];
  for (const e of (db.events || [])) {
    const entries = [];
    if (e.popped && typeof e.popped === 'object') {
      for (const [date, info] of Object.entries(e.popped)) {
        entries.push({
          occurrence: date,
          at: (info && info.at) || null,
          // 负数 = 提前完成，正数 = 拖延（用户指定的符号约定）
          remainingMs: info && Number.isFinite(info.remainingMs) ? info.remainingMs : null,
        });
      }
    }
    // 非重复事件被戳破：用 done + poppedAt 也算一条
    if (e.done && e.poppedAt) {
      entries.push({ occurrence: occurrenceKey(e.poppedAt), at: e.poppedAt, remainingMs: null });
    }
    if (!entries.length) continue;
    entries.sort((a, b) => String(a.occurrence).localeCompare(String(b.occurrence)));
    out.push({
      eventId: e.id,
      title: e.title,
      type: e.type,
      level: e.level,
      location: e.location || '',
      teacher: e.teacher || '',
      count: entries.length,
      lastAt: entries[entries.length - 1].at,
      entries,
      done: !!e.done,
    });
  }
  out.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  return out;
}

/**
 * 删除一个事件。
 * 删掉容器时把里面的子气泡**放出一级**，不要连带删掉（和戳破的行为一致）。
 *
 * ⚠️ 同时记**墓碑**（4c）：不然"我删了"和"对方没有"无法区分，
 *    同步时被删掉的会被合回来（见 core/sync.js 文件头）。
 */
export function deleteEvent(db, eventId, now) {
  const events = db.events || [];
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx < 0) throw notFound();
  const grandparent = events[idx].parentId || null;
  const at = isoNow(now);
  const victim = events[idx];
  for (const child of events) {
    if (child.parentId === eventId) {
      child.parentId = grandparent;
      child.updatedAt = at;
    }
  }
  events.splice(idx, 1);
  markDeleted(db, 'events', eventId, at, categoryOfEvent(victim));
  return { ok: true };
}

/**
 * 改设置。
 *
 * ⚠️ `notify` 必须**基于旧的 notify** 做嵌套合并 —— 这里踩过一个很隐蔽的坑：
 *
 *     原来的写法是：
 *       db.settings = { ...db.settings, ...patch };                 // ①
 *       if (patch.notify) db.settings.notify = { ...db.settings.notify, ...patch.notify };  // ②
 *     ① 已经用 `patch.notify` **整个替换**掉了 notify；
 *     ② 再合并时，基数已经是"只剩 patch 里那几个键"的新对象 ——
 *     于是**没在 patch 里出现的键全丢了**（例如改了 `desktop` 就把 `intensity` 抹掉）。
 *
 *     为什么以前没被发现：丢掉的那些键，下次 `loadDb()` 会被 `mergeDefaults`
 *     补成**缺省值**。所以只有当用户把某项设成**非缺省**值、随后又改了
 *     notify 里的另一项时才会露馅 —— 而且症状是"我的设置自己变回去了"。
 *
 *     正确做法：先照旧值合并出新的 notify，再整体赋值。
 */
export function updateSettings(db, patch) {
  const prev = db.settings || {};
  const next = { ...prev, ...patch };
  if (patch.notify) next.notify = { ...(prev.notify || {}), ...patch.notify };
  // ⚠️ `bubbleView` 是第二个要**逐字段合并**的嵌套对象（同上那条 notify 的坑）：
  //    网页气泡区只改"显示课程"时不该把"时间范围"冲回默认值。
  //    而且它是**两端共用**的一份显示设置（网页 + Windows 桌面气泡层），
  //    所以更要按字段合并 —— 被冲掉的症状是"桌面上突然多/少了几颗"，很难联想到设置合并。
  if (patch.bubbleView) next.bubbleView = { ...(prev.bubbleView || {}), ...patch.bubbleView };
  db.settings = next;
  return db.settings;
}

/** 归一化等级：显式 level > 旧 tier > 旧 magnitude/importance > 默认 */
export function normalizeLevel(input) {
  if (input && input.level && LEVEL_KEYS.has(input.level)) return input.level;
  if (input && input.tier && LEVEL_KEYS.has(input.tier)) return input.tier;
  if (input && input.magnitude != null) return levelFromLegacyMagnitude(input.magnitude);
  if (input && input.importance != null) return levelFromLegacyMagnitude(input.importance);
  return DEFAULT_LEVEL;
}

/**
 * 到期时刻：优先"距离期限"分量算出的绝对时刻，其次显式 deadline，
 * 最后**兜底用 `end`**（没有 end 才用 start）。
 *
 * ⚠️ 兜底这里原来是 `start`，与方案 C 冲突 —— 而且是个**会让 C 整体失效**的坑：
 *    凡是走 UI 新建的日程，`deadline` 都会被写成一个具体值，
 *    于是 `deadlineMsOf` 的 `deadline > end > start` 永远取不到 `end`。
 *    结果只有"导入的课"（deadline 为空）吃到了 C，UI 建的日程没吃到。
 *    现在兜底改成 `end`，C 才对所有日程一致成立。
 *
 * ⚠️ `deadlineSource` 仍写 'start'（那是个**已存储的枚举**，改它会破坏编辑器的回显）。
 *    它的语义应读作"非显式、由事件自身时间推出"，不要再按字面理解。
 */
export function resolveDeadline(input, start, end) {
  if (input.countdownParts && typeof input.countdownParts === 'object') {
    const at = Number(input.countdownAt) || Date.now();
    const t = deadlineFromDistance(input.countdownParts, at);
    if (t instanceof Date && Number.isFinite(t.getTime())) return t.toISOString();
  }
  if (input.deadline) return input.deadline;
  return end || start;
}

/**
 * 新建或更新一条日程。
 *
 * 关键约束（都是踩出来的，别删）：
 *   · 父容器**不存在**时**不报错**，降级为最外层新建；
 *     原来 throw 400，而客户端可能一直发一个已删除的容器 id，
 *     于是"只要创建就失败"，用户毫无自救手段。状态过期能自愈就自愈。
 *   · 父容器**过期（紫）**时**只读** —— 能进去看，不能往里加（用户要求）。
 *   · 套娃层级：子元素的等级必须**严于**父容器（红 > 黄 > 绿 > 蓝）。
 *   · 更新时改完可能违反层级（把自己颜色调大超过父容器）→ 再校验一遍。
 */
export function upsertEvent(db, input, now) {
  const at = isoNow(now);
  const nowMs = (typeof now === 'string' ? new Date(now) : (now instanceof Date ? now : new Date())).getTime();
  if (!input.title || !String(input.title).trim()) {
    throw Object.assign(new Error('title 不能为空'), { status: 400 });
  }
  const start = input.start;
  if (!start) throw Object.assign(new Error('start 不能为空'), { status: 400 });

  const autoReminders = input.autoReminders !== false;
  const level = normalizeLevel(input);
  let parentId = input.parentId ? String(input.parentId) : null;

  if (parentId) {
    const parent = db.events.find((e) => e.id === parentId);
    if (!parent) {
      // 降级为最外层（见上面的说明）
      parentId = null;
    } else if (isOverdueEvent(parent, db.events, new Date(nowMs))) {
      throw Object.assign(new Error('紫泡泡过期了，不能再往里加泡泡'), { status: 400 });
    } else {
      const parentLevel = levelOf(parent);
      if (!canNestInside(parentLevel, level)) {
        throw Object.assign(new Error(
          `${levelByKey(parentLevel).colorName}气泡里只能放更小的东西（不能放${levelByKey(level).colorName}）`,
        ), { status: 400 });
      }
    }
  }

  const end = input.end || start;
  const base = {
    id: input.id || id('evt'),
    title: String(input.title).trim(),
    type: input.type || 'personal',
    location: input.location || '',
    teacher: input.teacher || '',
    notes: input.notes || '',
    start,
    end,
    // deadline：真正的"到期时刻"（方案 C 下兜底是 end，见 resolveDeadline）
    // countdownParts / countdownAt：用户填"还剩多久"时的原始分量要留着 ——
    //   修编辑框要回显"3 年 4 月"，不能反算成"差 1 天"。
    // fuzzy：勾了就只按刻度取整显示。
    deadline: resolveDeadline(input, start, end),
    deadlineSource: input.deadline ? 'explicit' : (input.countdownParts ? 'distance' : 'start'),
    countdownParts: input.countdownParts || null,
    countdownAt: input.countdownParts ? Number(input.countdownAt) || nowMs : null,
    fuzzy: !!input.fuzzy,
    level,
    parentId,
    allDay: !!input.allDay,
    recurrence: input.recurrence || { freq: 'none' },
    weeks: Array.isArray(input.weeks) ? input.weeks.map(Number) : [],
    autoReminders,
    // 自动模式下先写一份（调度时还会按"当时的剩余时间"重算，所以会自动加密）
    reminders: autoReminders
      ? notificationPlanForRemaining(new Date(resolveDeadline(input, start, end)).getTime() - nowMs).plan
      : (Array.isArray(input.reminders) ? input.reminders.map(Number) : (db.settings && db.settings.defaultReminders) || [10, 0]),
    tags: Array.isArray(input.tags) ? input.tags : [],
    done: !!input.done,
    // alarm：**这条日程要不要用真闹钟**（AlarmKit，iOS 26+）。
    //
    // ⚠️ 为什么必须有这个**按日程**的开关（只有全局设置不够）：
    //   提醒**强度**是按"还剩多久"自动算的（core/level.js 的 BAND_INTENSITY）：
    //   最后一小时/过期会到最高档；而最高档在 iOS 上会被做成**真闹钟** ——
    //   而真闹钟**穿专注模式**（那是它的定义，改不了）。
    //   若只有全局开关，用户就只剩两个选择：全都用（专注模式废掉）、
    //   或全都不用（等于白接 AlarmKit）。用户的真实要求是"专注时别响"，
    //   同时"绝对不能错过的事要能炸到人" —— 那就只能**按日程**决定。
    //   默认 false：**不勾就永远不会炸**；勾了才是"我认了它会穿过专注模式"。
    alarm: input.alarm === true,
    // periodDays：「周期（天）」—— 重复日程只浮「第一颗 + 周期」以内的实例。
    //
    // ⚠️⚠️ 这里曾经**漏了它**，于是编辑器里填的"周期"**存不进去**。用户实测表现为：
    //   · 编辑周期**无效**（重开一看还是旧值）
    //   · **超限的泡泡不消失**（core/recurrence.js 的 periodDaysOf → applyPeriodLimit 读不到它）
    //   根因和 `alarm` 那次一模一样：**这个 base 是"逐字段列举"的，
    //   不在这里写一句就会被静默丢掉，而且哪儿都不报错。**
    //   归一化方式**照抄 editor.js 的写入端**（空 → null；否则取整、最小 1），
    //   别在这里发明第二套规则。
    periodDays: (input.periodDays == null || input.periodDays === '')
      ? null
      : Math.max(1, Math.floor(Number(input.periodDays) || 1)),
    // future：「未来泡泡」—— `start` 的含义变成**出现日期**（到那天之前只在气泡区不显示），
    //   `end` 就是到期，提醒也改按 `end` 算（见 core/notify-plan.js 的锚点说明）。
    //
    // ⚠️ 同样是**枚举字段**，不在这里写一句就会被静默丢掉（表现又是"编辑无效"）。
    //    这一条现在由 tools/ios-bundle-check.mjs 的"编辑器 payload ⊆ base"检查自动盯着。
    future: input.future === true,
    createdAt: at,
    updatedAt: at,
  };

  const idx = db.events.findIndex((e) => e.id === base.id);
  if (idx >= 0) {
    // 改完之后可能违反层级（例如把自己的颜色调大、超过了父容器）→ 再校验一遍
    if (base.parentId) {
      const parent = db.events.find((e) => e.id === base.parentId);
      if (parent && !canNestInside(levelOf(parent), base.level)) {
        throw Object.assign(new Error('改完之后颜色比父气泡还大了，父气泡里放不下'), { status: 400 });
      }
    }
    db.events[idx] = { ...db.events[idx], ...base, createdAt: db.events[idx].createdAt };
  } else {
    db.events.push(base);
  }
  // 复活：这个 id 之前被删过（有墓碑），现在又被创建/更新了 → 把墓碑撤掉。
  // 不撤的话，同步时对方会按旧墓碑把它又删一次（"新建的日程一同步就没了"）。
  clearTombstone(db, 'events', base.id);
  return idx >= 0 ? db.events[idx] : base;
}

/**
 * `candidateId` 是不是 `ancestorId` 的后代？用于防套环。
 * 带 guard，防止脏数据里的 parentId 形成死循环。
 */
export function isDescendant(db, candidateId, ancestorId) {
  const byId = new Map((db.events || []).map((e) => [e.id, e]));
  let cur = byId.get(candidateId);
  let guard = 0;
  while (cur && guard < 256) {
    if (cur.parentId === ancestorId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
    guard += 1;
  }
  return false;
}

/**
 * 局部修改一条日程。
 *
 * 改颜色 / 改父气泡都要**重新过一遍套娃校验**（不能把自己塞进更小的容器里），
 * 并且要防三种情况：
 *   · 放进自己里
 *   · 放进**自己的后代**里（严格按等级排序时环其实不可能形成，但那是"靠巧合成立"的，
 *     万一以后放开等级约束就会立刻出环，所以显式挡一道）
 *   · 放进**已过期（紫）**的容器里 —— 拖拽改归属也走这条 patch，同样要守
 */
export function patchEvent(db, eventId, patch, now) {
  const e = (db.events || []).find((x) => x.id === eventId);
  if (!e) throw notFound();

  const nextLevel = patch.level && LEVEL_KEYS.has(patch.level) ? patch.level : levelOf(e);
  const nextParent = patch.parentId !== undefined
    ? (patch.parentId ? String(patch.parentId) : null)
    : e.parentId;
  if (nextParent) {
    if (nextParent === eventId) {
      throw Object.assign(new Error('不能把自己放进自己里'), { status: 400 });
    }
    const parent = db.events.find((x) => x.id === nextParent);
    if (!parent) throw Object.assign(new Error('父气泡不存在'), { status: 400 });
    if (isDescendant(db, nextParent, eventId)) {
      throw Object.assign(new Error('不能把气泡放进它自己的子气泡里'), { status: 400 });
    }
    if (isOverdueEvent(parent, db.events, now instanceof Date ? now : new Date())) {
      throw Object.assign(new Error('紫泡泡过期了，不能再往里放泡泡'), { status: 400 });
    }
    if (!canNestInside(levelOf(parent), nextLevel)) {
      throw Object.assign(new Error(
        `${levelByKey(levelOf(parent)).colorName}气泡里只能放更小的东西`,
      ), { status: 400 });
    }
  }
  // 改颜色后，已有子元素可能"比父还大"了 → 一并拦住
  if (nextLevel !== levelOf(e)) {
    const bad = db.events.find((c) => c.parentId === eventId && !canNestInside(nextLevel, levelOf(c)));
    if (bad) {
      throw Object.assign(new Error('改完之后比里面的气泡还小，装不下它们'), { status: 400 });
    }
  }

  Object.assign(e, patch, { id: e.id, updatedAt: isoNow(now) });
  return e;
}

// ---------------------------------------------------------------------------
// 课表导入 / 清空 / 备份恢复（4a 第三刀）
// ---------------------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

/** 算出"第 week 周、星期 dayOfWeek 的 hhmm"那个本地时刻字符串 */
export function buildCourseStart(termStart, dayOfWeek, week, hhmm) {
  const base = termStart ? new Date(`${termStart}T00:00:00`) : new Date();
  const monday = mondayOf(base);
  const target = new Date(monday);
  target.setDate(monday.getDate() + (week - 1) * 7 + (dayOfWeek - 1));
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  target.setHours(h || 0, m || 0, 0, 0);
  return `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}T${pad2(h || 0)}:${pad2(m || 0)}:00`;
}

/**
 * 课表导入：写入 courses 表，并把每门课展开成可提醒的 events。
 * **幂等** —— 同一 courseKey 重复导入是覆盖/合并，不是堆积。
 *
 * 这里有几个**踩出来的关键点**，别简化：
 *
 * ① `key` 必须包含**老师 + 周次**，不能只用「课程名|星期|节次」。
 *    排课器导出的「专业导论」有 8 行，课程名/星期/节次完全相同，只是每周换老师：
 *    旧 key 算出一样的字符串 → 第 2~8 行都落进"已存在"分支被覆盖 →
 *    课表上这门课只剩 1 周，**7 位老师凭空消失**。
 *
 * ② 同一门课的第 2、3 次上课要**并进 `meetings`**，不是覆盖。
 *    直接覆盖会让"高等数学"只剩周三那次，周一那次不见了。
 *
 * ③ 事件 id 必须把**上课时间**算进去，否则一门课的多次上课互相覆盖
 *    （实测：周一 1-3 节 + 周三 5-6 节，只活下来一条）。
 *
 * ④ 起止时间要按**最后一节**算，并把 `sections` 存进事件。
 *    只取 `sections[0]` 会让 1-2 节的课算成 8:00–8:45（实际到 9:35），
 *    而且事件里没字段记得它横跨两节 → 课表只能画在一行里。
 *
 * ⑤ mode='merge' 时要清理"上一轮导入留下、这次已不存在"的旧事件，
 *    否则某门课换了时间段，新旧时间会同时显示（脏数据）。
 *    但**只清理同源的**，手动加的课不动。
 */
export function importCourses(db, { courses = [], meta = {}, mode = 'merge' } = {}, now) {
  const at = isoNow(now);
  if (mode === 'replace') {
    // 整份替换 → 先把要没的记成墓碑，否则同步时它们会被对方合回来
    for (const c of (db.courses || [])) markDeleted(db, 'courses', c.key, at, 'courses');
    for (const e of (db.events || [])) {
      if (e.type === 'course') markDeleted(db, 'events', e.id, at, 'courses');
    }
    db.courses = [];
    db.events = db.events.filter((e) => e.type !== 'course');
  }
  let added = 0;
  let skipped = 0;
  const problems = [];
  /** 这一轮导入产生的所有事件 id（用于清理上一轮的残留） */
  const currentEventKeys = new Set();

  for (const raw of courses) {
    const title = String(raw.title || '').trim();
    const day = Number(raw.dayOfWeek);
    const sections = (raw.sections || []).map(Number).filter(Boolean);
    const weeks = (raw.weeks || []).map(Number).filter(Boolean);
    if (!title || !day || !sections.length) {
      skipped += 1;
      problems.push(`跳过无效课程：${title || '(无名称)'}（缺 dayOfWeek / sections）`);
      continue;
    }
    const weeksKey = (weeks.length ? weeks : []).join(',');
    const key = raw.key || `${title}|${day}|${sections.join(',')}|${raw.teacher || ''}|${weeksKey}`;
    const allWeeks = weeks.length ? weeks : Array.from({ length: meta.termWeeks || 20 }, (_, i) => i + 1);
    const record = {
      key,
      title,
      teacher: raw.teacher || '',
      location: raw.location || '',
      dayOfWeek: day,
      sections,
      weeks: allWeeks,
      color: raw.color || null,
      source: meta.source || 'manual',
      importedAt: at,
      /** 这门课的全部上课时段（一门课可能有多次课，如周一 + 周三） */
      meetings: [{ dayOfWeek: day, sections, weeks: allWeeks, location: raw.location || '' }],
    };
    const idx = db.courses.findIndex((c) => c.key === key);
    if (idx >= 0) {
      // 同一门课的第 2、3 次上课：并进已有记录的 meetings，而不是覆盖它（见 ②）
      const prev = db.courses[idx];
      const ms = Array.isArray(prev.meetings) ? prev.meetings : [];
      const sig = (m) => `${m.dayOfWeek}|${(m.sections || []).join(',')}`;
      if (!ms.some((m) => sig(m) === sig(record.meetings[0]))) ms.push(record.meetings[0]);
      db.courses[idx] = { ...prev, ...record, meetings: ms, sections: record.sections, dayOfWeek: record.dayOfWeek };
    } else {
      db.courses.push(record);
      added += 1;
    }

    // 展开为 events —— **一次上课 = 一条事件**（见 ③④）
    const evKey = String(raw.eventKey || `course:${key}|${day}|${sections.join(',')}`);
    const existing = db.events.find((e) => e.id === evKey);
    const firstSlot = (meta.sectionTimes || []).find((s) => Number(s.index) === sections[0]) || null;
    const lastIndex = sections[sections.length - 1];
    const lastSlot = (meta.sectionTimes || []).find((s) => Number(s.index) === lastIndex) || firstSlot;
    const base = {
      id: evKey,
      title,
      type: 'course',
      location: record.location,
      teacher: record.teacher,
      start: buildCourseStart(meta.termStart, day, allWeeks[0] || 1, firstSlot ? firstSlot.start : '08:00'),
      end: buildCourseStart(meta.termStart, day, allWeeks[0] || 1, lastSlot ? lastSlot.end : '09:40'),
      recurrence: { freq: 'none' },
      weeks: record.weeks,
      /** 这节课横跨的节次（第 1-2 节 → [1,2]）。课表靠它把格子连起来画 */
      sections,
      reminders: (db.settings && db.settings.defaultReminders) || [10, 0],
      tags: ['课程'],
      done: false,
      updatedAt: at,
    };
    if (existing) Object.assign(existing, base, { createdAt: existing.createdAt });
    else db.events.push({ ...base, createdAt: at });
    currentEventKeys.add(evKey);
  }

  // 清理残留（见 ⑤）
  if (mode === 'replace') {
    db.events = db.events.filter((e) => e.type !== 'course' || currentEventKeys.has(e.id));
  } else {
    const importedKeys = new Set(courses.map((c) => String(c.key || '')));
    db.events = db.events.filter((e) => {
      if (e.type !== 'course') return true;
      if (currentEventKeys.has(e.id)) return true;
      if (!String(e.id).startsWith('course:')) return true;
      const k = String(e.id).slice('course:'.length).split('|')[0];
      return !importedKeys.has(k);   // 这门课这次没导 → 保留（可能来自别的来源）
    });
  }

  if (meta.termStart) db.settings.termStart = meta.termStart;
  if (meta.termWeeks) db.settings.termWeeks = Number(meta.termWeeks);
  if (Array.isArray(meta.sectionTimes) && meta.sectionTimes.length) {
    db.settings.sectionTimes = meta.sectionTimes;
  }
  db.settings.importedSources = Array.from(new Set([...(db.settings.importedSources || []), meta.source || 'manual']));
  return { added, skipped, total: db.courses.length, problems };
}

/** 清空全部日程（保留课程记录时可传 keepCourses）。同样要记墓碑（4c） */
export function clearEvents(db, { keepCourses = false } = {}, now) {
  const at = isoNow(now);
  const before = (db.events || []).length;
  const removed = keepCourses
    ? (db.events || []).filter((e) => e.type !== 'course')
    : (db.events || []).slice();
  for (const e of removed) markDeleted(db, 'events', e.id, at, categoryOfEvent(e));
  if (!keepCourses) {
    for (const c of (db.courses || [])) markDeleted(db, 'courses', c.key, at, 'courses');
    db.courses = [];
  }
  db.events = keepCourses ? db.events.filter((e) => e.type === 'course') : [];
  return { removed: before - db.events.length };
}

/** 从备份恢复（整体覆盖；用于换电脑迁移）。整份替换 → 旧墓碑全部作废 */
export function restoreBackup(db, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) {
    throw Object.assign(new Error('备份文件格式不正确：缺少 events 数组'), { status: 400 });
  }
  db.settings = { ...db.settings, ...(payload.settings || {}) };
  db.events = payload.events;
  db.courses = Array.isArray(payload.courses) ? payload.courses : [];
  // 备份是**权威快照**：它里面没有的，就是没的。旧墓碑留着会在同步时
  // 把刚恢复出来的东西又删掉（"恢复完立刻消失"），所以清空。
  db.tombstones = { events: {}, courses: {} };
  return { events: db.events.length, courses: db.courses.length };
}

// ---------------------------------------------------------------------------
// 「到期」从此只有一个定义：上面的 `deadlineMsOf`（deadline > end > start）。
//
// 曾经有四份各自演化的实现 —— 本文件、core/urgency.js、web/ui/views/bubble.js、
// server/store.js —— 其中两份按 start、两份按 end。而"没填 deadline"的事件在
// 真实数据里占 33/62，所以这不是理论分歧，是每天都在发生的。
// 现已全部转调本文件；要改只改这里。
//
// ⚠️ 提醒**不**走这个定义：提醒点相对 `start` 算（core/reminder-plan.js、
//    server/scheduler.js 用 occurrence.start）。"什么时候提醒你"和"什么时候算过期"
//    是两个概念（用户选定的方案 C），**别合并**。
// ---------------------------------------------------------------------------
