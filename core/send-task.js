// 发送任务：**状态机 + 通道能力表 + 幂等键**，平台无关。
//
// 用户已定的路线（第 48–49 轮）："先做「生成 + 预览 + 复制」，再做半自动发送，
// 最后才考虑官方通道"。这一轮把状态机定下来，界面和 server/ 下一轮接线。
//
// ---------------------------------------------------------------------------
// 这个模块存在的唯一理由：**绝对不许静默失败**
// ---------------------------------------------------------------------------
// 发祝福语和"点一下按钮"不是一回事：消息一旦发出去就**收不回来**，
// 而"我以为发了"和"真的发了"之间的差距，会直接毁掉人际关系（客户没收到祝福，
// 或者更糟：同一条祝福发了两遍）。
//
// 所以状态里必须有 `unverified` —— **"发送键按下去了，但无法确认"**。
// 这不是"失败"（可能已经发出去了），也不是"成功"（没有任何证据）。
// 现实里这个状态是主流而不是边角：微信没有开放个人号接口，半自动通道只能做到
// "把窗口调出来、把文本放进剪贴板、把焦点交给你"，之后那条消息到没到对方，
// 程序**根本无从知道**。谁要是在这里直接写 `ok: true`，他写的不是代码，是谎话。
//
// `confirmed` 只能由**明确证据**带进来（`markConfirmed(task, evidence)` 里
// evidence 为空直接 throw）。合法证据只有三种，别的都不算：
//   · 'user-confirmed' 用户在界面上点了"我确认发出去了"（人证）
//   · 'channel-receipt' 通道回执（企业微信机器人的 errcode=0 就是这种）
//   · 'screenshot-ocr'  截图里看到了已发出的消息（将来的路，先留位置）
//
// 失败原因**必须可区分**（`SEND_FAIL_REASONS`）。"发送失败"这四个字对被叫起来
// 处理问题的用户完全没有信息量：是微信没开？还是他根本不在你好友里？还是两个同名
// 好友程序不敢猜（那是**要用户选**，不是失败）？还是窗口被别的程序抢走了焦点
// （重试就好）？这几种的处置办法完全不同，糊成一句就等于把问题丢回给用户。

const nowDate = (now) => {
  if (now instanceof Date && Number.isFinite(now.getTime())) return new Date(now.getTime());
  if (typeof now === 'string' && now.trim()) {
    const t = new Date(now.length === 10 ? `${now}T00:00:00` : now).getTime();
    if (Number.isFinite(t)) return new Date(t);
  }
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
  return new Date();
};

const isoNow = (now) => nowDate(now).toISOString();

function base36(n) { return Math.max(0, Math.floor(Number(n) || 0)).toString(36); }

/** 稳定哈希（和 core/contacts.js / core/greetings.js 同一套；换实现会让幂等键失配） */
function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function textOf(v, max = 200) {
  if (v == null) return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/**
 * 发送任务的 8 个状态。
 *
 * ⚠️ 每个状态都对应一个**不同的用户动作**，少一个就会出现"不知道该干什么"：
 *
 *   pending     还没开始。可以改文本、可以换通道。
 *   preparing   正在做准备（找聊天窗/切通道/组装消息）。失败可重试。
 *   awaiting    已经把话递出去了，**在等对方或等人**（半自动通道：等用户按回车）。
 *               这个状态是"进行中"，不是"完成" —— 界面不能在这里就显示成已发送。
 *   sending     正在发送（网络/接口在跑）。
 *   confirmed   有**明确证据**证明发出去了。**只有带 evidence 才允许进入**。
 *   unverified  **按了发送键，但无法确认**（见文件头）。要人接手。
 *   failed      确定失败（原因可区分）。可以重试。
 *   cancelled   用户主动取消（不是失败，不该出现在"失败"计数里）。
 *
 * ⚠️ 状态名是**存进数据里的**（任务会落到 settings 或者日志里），
 *    改字面量就是迁移，所以这张表和 SEND_TRANSITIONS 一起当成"已存储的枚举"看待。
 */
export const SEND_STATES = Object.freeze({
  pending: { key: 'pending', label: '待发送', desc: '还没开始，可以改文本或换通道' },
  preparing: { key: 'preparing', label: '准备中', desc: '正在准备（找聊天窗/组装消息）' },
  awaiting: { key: 'awaiting', label: '等你确认发送', desc: '文本已就绪，等你按下发送' },
  sending: { key: 'sending', label: '发送中', desc: '通道正在发送' },
  confirmed: { key: 'confirmed', label: '已确认发出', desc: '有明确证据证明已经发出' },
  unverified: { key: 'unverified', label: '无法确认是否发出', desc: '按下去了，但没有证据 —— 要人接手核对' },
  failed: { key: 'failed', label: '发送失败', desc: '确定失败，原因见 reason' },
  cancelled: { key: 'cancelled', label: '已取消', desc: '用户主动取消' },
});

/** 合法状态键（校验用） */
export const SEND_STATE_KEYS = Object.freeze(Object.keys(SEND_STATES));

/**
 * 允许的状态转移。
 *
 * ⚠️ 这张表要按"**已发生的事实**能不能撤销"来读，不是按流程好看：
 *   · `sending` / `awaiting` → `pending` **不允许**。
 *     "把已经交出去的动作退回待发送"是重复发送的经典成因（用户看到它变回待发送，
 *     就再点一次）。要取消只能去 `cancelled`，而 cancelled 的语义是
 *     "不确定到底发没发，别再自动发了"。
 *   · `confirmed` 是**终态**（除了取消/失败一类的纠错不开放）。
 *     已确认发出的消息不存在"再改状态"，只能新开一条任务。
 *   · `unverified` **可以再转**：转 confirmed（用户后来翻聊天记录确认了）、
 *     转 failed（确认没发出去）、或原样留着 → 这一条是给人留的纠错通道。
 */
export const SEND_TRANSITIONS = Object.freeze({
  pending: ['preparing', 'awaiting', 'sending', 'confirmed', 'unverified', 'failed', 'cancelled'],
  preparing: ['awaiting', 'sending', 'unverified', 'failed', 'cancelled'],
  awaiting: ['sending', 'confirmed', 'unverified', 'failed', 'cancelled'],
  sending: ['confirmed', 'unverified', 'failed'],
  confirmed: ['cancelled'],
  unverified: ['confirmed', 'failed', 'cancelled'],
  failed: ['pending', 'preparing', 'awaiting', 'sending', 'cancelled'],
  cancelled: ['pending'],
});

/**
 * 允许的证据类型（`confirmed` 必须要一个）。
 * 用白名单而不是"非空字符串就行"：`evidence: 'ok'` 这种糊弄话必须被挡住。
 */
export const SEND_EVIDENCE_KINDS = Object.freeze([
  'user-confirmed',    // 用户在界面上点"我确认发出去了"
  'channel-receipt',   // 通道回执（机器人接口的 errcode=0）
  'screenshot-ocr',    // 截图里看到已发出的消息（将来的路）
]);

/**
 * 失败原因**分类表**。
 *
 * ⚠️ 每一条都对应一个**不同的处置**，这正是"不能只说发送失败"的原因：
 *   WECHAT_NOT_RUNNING    微信没开/没登录 → 用户去开一下，重试
 *   RECIPIENT_NOT_FOUND   搜不到这个人    → 很可能是昵称不对，让用户核对该好友
 *   AMBIGUOUS_RECIPIENT   搜出来好几个人  → **必须让用户选**，程序绝不许猜（见 contacts.findContactsByName）
 *   WINDOW_LOST_FOCUS     窗口被抢走焦点  → 直接重试，通常一次就好
 *   NETWORK_TIMEOUT       网络超时        → 稍后重试 / 换通道
 *   USER_NOT_CONFIRMED    等用户确认，用户没确认 → 不是错误，是把决定权交回给人
 *   CLIPBOARD_BLOCKED     剪贴板被占/被拒 → 关掉占用剪贴板的程序再试
 *   CHANNEL_UNAVAILABLE   这个通道当前不可用（没装/没配机器人）
 *   RATE_LIMITED          发太快被限流    → 慢一点，隔一会儿再发
 *   UNKNOWN               真的没归类       → 保留原始信息，别硬塞进上面任何一类
 *
 * `retryable`：程序能不能自动重试。`needsUser`：是否必须人接手
 * （`AMBIGUOUS_RECIPIENT` 和 `USER_NOT_CONFIRMED` 都属于"这不是失败，是要你选"）。
 */
export const SEND_FAIL_REASONS = Object.freeze({
  WECHAT_NOT_RUNNING: { label: '微信没有运行或没有登录', retryable: true, needsUser: true },
  RECIPIENT_NOT_FOUND: { label: '找不到这个好友', retryable: false, needsUser: true },
  AMBIGUOUS_RECIPIENT: { label: '搜出多个同名好友，需要你选一个', retryable: false, needsUser: true },
  WINDOW_LOST_FOCUS: { label: '聊天窗口失焦了', retryable: true, needsUser: false },
  NETWORK_TIMEOUT: { label: '网络超时', retryable: true, needsUser: false },
  USER_NOT_CONFIRMED: { label: '还没等到你确认', retryable: false, needsUser: true },
  CLIPBOARD_BLOCKED: { label: '剪贴板被其它程序占用', retryable: true, needsUser: true },
  CHANNEL_UNAVAILABLE: { label: '这个通道当前不可用', retryable: false, needsUser: true },
  RATE_LIMITED: { label: '发得太快被限流了', retryable: true, needsUser: false },
  UNKNOWN: { label: '未知原因', retryable: false, needsUser: true },
});

// ---------------------------------------------------------------------------
// 通道能力表
// ---------------------------------------------------------------------------

/**
 * 四个通道。
 *
 * ⚠️ `SEND_CHANNELS` / `SEND_STATES` / `SEND_TRANSITIONS` / `SEND_FAIL_REASONS`
 *    都是**存进数据或跨端共用**的东西，改动等于迁移，别随手重命名。
 *
 * ⚠️ `wecom` / `qqbot` 是**服务端群机器人**，不是"给好友私发"：
 *    它们只能发到「群」，而且必须先有人把这个机器人拉进群。
 *    这一点必须在 label/note 里说清 —— 用户以为配了机器人就能给好友逐个发祝福，
 *    结果发现只有群里能看到，这是**预期管理**问题，不是 bug。
 */
export const SEND_CHANNELS = Object.freeze([
  {
    key: 'manual',
    label: '手动复制',
    desc: '自己复制文本、自己切到聊天窗、自己粘贴发送',
    capability: {
      canSendDirectly: false,
      needsUserConfirm: true,
      platforms: ['wechat', 'qq', 'other'],
      requiresExtraInstall: false,
      reliability: 'high',
      note: '最笨也最不会出事：程序只说"该发了"，一个键都不替你按',
    },
  },
  {
    key: 'clipboard',
    label: '半自动（复制+唤出聊天窗）',
    desc: '程序复制好文本、把聊天窗调到前台，你按回车',
    capability: {
      canSendDirectly: false,
      needsUserConfirm: true,
      platforms: ['wechat', 'qq'],
      requiresExtraInstall: false,
      reliability: 'medium',
      note: '能把焦点和文本备好，但**按发送键的是你**，所以发没发出去只有你知道',
    },
  },
  {
    key: 'wecom',
    label: '企业微信群机器人',
    desc: '通过企业微信的群机器人 webhook 发到群里',
    capability: {
      canSendDirectly: true,
      needsUserConfirm: false,
      platforms: ['wechat'],
      requiresExtraInstall: false,
      reliability: 'high',
      note: '唯一能拿到**回执**的通道；但只能发群、且需要先配 webhook（不是给好友私发）',
    },
  },
  {
    key: 'qqbot',
    label: 'QQ 官方机器人',
    desc: '通过 QQ 开放平台的机器人接口发送',
    capability: {
      canSendDirectly: true,
      needsUserConfirm: false,
      platforms: ['qq'],
      requiresExtraInstall: true,
      reliability: 'medium',
      note: '要注册机器人、拉进群、还要过平台审核；且官方对主动推送有严格限制',
    },
  },
]);

/** 通道清单（**每一项都带 capability**，界面靠它决定"能不能一键发"） */
export function listSendChannels() {
  return SEND_CHANNELS.map((c) => ({ ...c, capability: { ...c.capability, platforms: [...c.capability.platforms] } }));
}

/** 一个通道的能力（未知通道 → null，界面要显式处理"这个通道我不认识"） */
export function capabilityOf(channelKey) {
  const c = SEND_CHANNELS.find((x) => x.key === channelKey);
  return c ? { ...c.capability, platforms: [...c.capability.platforms] } : null;
}

/** 这个通道**有没有资格**说自己发成功了（手动/半自动一律不许直接 confirmed） */
export function isDirectChannel(channelKey) {
  const cap = capabilityOf(channelKey);
  return !!(cap && cap.canSendDirectly);
}

// ---------------------------------------------------------------------------
// 建任务 / 幂等键
// ---------------------------------------------------------------------------

/** 从 contact / festival 里取稳定标识（允许传对象或字符串，界面两种都会传） */
function idOf(v, fallback = '') {
  if (v == null) return fallback;
  if (typeof v === 'object') {
    if (v.id != null && String(v.id).trim()) return String(v.id).trim();
    if (v.key != null && String(v.key).trim()) return String(v.key).trim();
    if (v.name != null && String(v.name).trim()) return String(v.name).trim();
    return fallback;
  }
  return String(v).trim() || fallback;
}

/** 日期归一成 'YYYY-MM-DD'（幂等键里**不能**带时分秒，否则每次生成都是一个新键） */
export function dateISOOf(v, now) {
  if (v instanceof Date && Number.isFinite(v.getTime())) {
    const d = v;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'string' && v.trim()) {
    const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const t = new Date(v).getTime();
    if (Number.isFinite(t)) return dateISOOf(new Date(t));
  }
  if (typeof v === 'number' && Number.isFinite(v)) return dateISOOf(new Date(v));
  const d = nowDate(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 幂等键：`contactId + festivalKey + 日期`。
 *
 * ⚠️ 为什么非要有它（这是本模块最不能省的一行）：
 *    节日祝福是**批量**动作（一次几十个人），而批量动作一定会遇到重试：
 *    网络超时重试、用户点两下、程序崩了重开、同步把旧任务又合回来。
 *    没有幂等键，"重试"和"再发一遍"在数据上长得一模一样 ——
 *    而重复发祝福的代价不是多一条数据，是**当着客户的面复制粘贴两遍**。
 *
 * ⚠️ 键里**故意不含文本、通道、时间**：
 *   · 不含文本 → 改一版文案重试，仍然是"同一次发送"，不该算新任务
 *   · 不含通道 → 微信发不出去改用企业微信，是**同一次发送换了路**
 *   · 不含时间 → 同一天同一个节日就该只有一个键（不然每次打开界面都新建一条）
 *   要"同一天给同一个人发两条不同的内容"（比如上午祝福、下午提醒日程），
 *   那是**另一类任务**，应该在 festivalKey 那一格区分（如 `festival:zhongqiu` vs `task:xxx`）。
 */
export function taskKey(task) {
  if (!task || typeof task !== 'object') return '';
  const contactId = idOf(task.contactId != null ? task.contactId : task.contact);
  const festivalKey = idOf(task.festivalKey != null ? task.festivalKey : task.festival);
  const dateISO = dateISOOf(task.dateISO);
  return `${contactId}|${festivalKey}|${dateISO}`;
}

/**
 * 新建一条发送任务（**pending**，不自动开跑）。
 *
 * ⚠️ 缺 contact / festival 直接 throw，不造一条"残缺任务"：
 *    任务的全部意义就是"把哪条文本发给谁"，缺任何一半都执行不了，
 *    而一条执行不了的任务混在列表里，用户只会以为程序坏了。
 */
export function createSendTask({ contact, festival, dateISO, text, channel, source } = {}, now) {
  const contactId = idOf(contact);
  const festivalKey = idOf(festival);
  if (!contactId) throw new Error('发送任务缺少好友（contact）');
  if (!festivalKey) throw new Error('发送任务缺少节日（festival）');
  const at = isoNow(now);
  const ch = SEND_CHANNELS.some((c) => c.key === channel) ? channel : 'manual';
  const cap = capabilityOf(ch);
  const date = dateISOOf(dateISO, now);
  const task = {
    id: `st-${base36(hash32(`${contactId}|${festivalKey}|${date}`))}${base36(Math.abs(hash32(textOf(text, 400))) % 1296)}`,
    contactId,
    festivalKey,
    dateISO: date,
    text: textOf(text, 2000),
    channel: ch,
    // source：这条文本是谁写的（'ai' | 'offline' | 'user'）。界面要能标出来，
    // 因为"模型写的"要允许用户改完再发，"用户手写的"不该被程序覆盖。
    source: (source === 'ai' || source === 'offline' || source === 'user') ? source : 'offline',
    state: 'pending',
    // ⚠️ needsUserConfirm 在**建任务时**就按通道能力定下来，而不是等状态变成 awaiting 再算：
    //    否则"这个通道本来就必须人工确认"这件事只活在某个分支里，界面读不到。
    needsUserConfirm: cap ? cap.needsUserConfirm : true,
    evidence: null,
    reason: null,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
  };
  return task;
}

// ---------------------------------------------------------------------------
// 状态迁移
// ---------------------------------------------------------------------------

/**
 * 迁到下一个状态。**非法转移必须 throw**（抛的是 `status: 400` 的业务错误，
 * 沿用 core/state-ops.js 的 `{ status }` 约定，api.js 依赖它）。
 *
 * ⚠️ 返回的是**新对象**（不改传入的那条）：
 *    任务列表会同时被界面和持久化读到，就地改会让"改了一半"可见，
 *    而且失败时没法回滚。要写回的地方自己替换。
 *
 * ⚠️ `confirmed` 必须带**合法证据**，否则 throw —— 见文件头那三种合法证据。
 *    这一条是"不许静默失败"的另一半：不许静默**成功**。
 */
export function transition(task, next, { reason, evidence, at } = {}) {
  if (!task || typeof task !== 'object') throw new Error('发送任务不存在');
  if (!SEND_STATE_KEYS.includes(next)) {
    throw Object.assign(new Error(`不认识的发送状态：${next}`), { status: 400 });
  }
  const cur = SEND_STATE_KEYS.includes(task.state) ? task.state : null;
  if (!cur) {
    throw Object.assign(new Error(`这条任务的当前状态不合法：${String(task.state)}`), { status: 400 });
  }
  if (cur === next) {
    throw Object.assign(new Error(`状态没有变化（已经是「${SEND_STATES[next].label}」）`), { status: 400 });
  }
  const allowed = SEND_TRANSITIONS[cur] || [];
  if (!allowed.includes(next)) {
    throw Object.assign(
      new Error(`不能从「${SEND_STATES[cur].label}」直接变成「${SEND_STATES[next].label}」`),
      { status: 400 },
    );
  }

  const stamp = isoNow(at);
  const out = { ...task, state: next, updatedAt: stamp };

  if (next === 'confirmed') {
    const kind = evidence && typeof evidence === 'object' ? evidence.kind : evidence;
    if (!kind || !SEND_EVIDENCE_KINDS.includes(kind)) {
      throw Object.assign(
        new Error(`「已确认发出」必须有证据（${SEND_EVIDENCE_KINDS.join(' / ')}），不能凭空确认`),
        { status: 400 },
      );
    }
    out.evidence = { kind, at: stamp, detail: textOf(evidence && evidence.detail, 400) };
    out.reason = null;
  }

  if (next === 'failed' || next === 'unverified') {
    const code = reason && typeof reason === 'object' ? (reason.code || reason.key) : reason;
    const key = code && SEND_FAIL_REASONS[code] ? code : 'UNKNOWN';
    // ⚠️ 认不出的原因**不丢**：塞进 detail 里保留原文。
    //    丢掉的后果是"用户看到未知原因、也看不到原始报错"，等于没有信息。
    const detail = textOf(
      (reason && typeof reason === 'object' ? (reason.detail || reason.message) : '') || (key === code ? '' : code),
      400,
    );
    out.reason = { code: key, label: SEND_FAIL_REASONS[key].label, detail };
    if (key === 'UNKNOWN' && !out.reason.detail) out.reason.detail = textOf(reason, 200);
  }

  if (next === 'cancelled') {
    out.reason = null;
    out.evidence = null;
  }

  if (next === 'preparing' || next === 'sending') {
    out.attempts = (Number.isFinite(Number(task.attempts)) ? Number(task.attempts) : 0) + 1;
  }

  return out;
}

/** 有证据地确认发出（证据类型走白名单，见 SEND_EVIDENCE_KINDS） */
export function markConfirmed(task, evidence, at) {
  return transition(task, 'confirmed', { evidence, at });
}

/**
 * 标成"按了发送键，但无法确认"。
 * ⚠️ 这是本模块**最常用的收尾状态**，不是异常分支：半自动通道的默认结局就是它。
 */
export function markUnverified(task, reason, at) {
  return transition(task, 'unverified', { reason, at });
}

/** 标成确定失败（原因必须是 SEND_FAIL_REASONS 里的 key，认不出会记成 UNKNOWN 并保留原文） */
export function markFailed(task, reason, at) {
  return transition(task, 'failed', { reason, at });
}

// ---------------------------------------------------------------------------
// 汇总 / 描述 / 去重
// ---------------------------------------------------------------------------

/**
 * 计数汇总。界面顶部的"已确认 N / 待确认 M / 失败 K"就是它。
 *
 * ⚠️ 键是**固定的**（哪怕 0 也要在），界面不该写 `summary.failed || 0` 这种兜底 ——
 *    一个键漏了就会显示成 `undefined`。
 */
export function summarizeTasks(tasks) {
  const out = { confirmed: 0, unverified: 0, failed: 0, pending: 0, sending: 0, cancelled: 0, total: 0 };
  const list = Array.isArray(tasks) ? tasks : [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    out.total += 1;
    const k = SEND_STATE_KEYS.includes(t.state) ? t.state : null;
    if (!k) continue;
    // preparing / awaiting 归到 pending 一档（对用户来说都是"还没发出去"），
    // 但 sending 单独计 —— 它是唯一"可能正在发生"的状态，界面要挡住重复操作。
    if (k === 'preparing' || k === 'awaiting') out.pending += 1;
    else out[k] += 1;
  }
  return out;
}

/** 状态的中文名（脏值别渲染成 undefined） */
export function stateLabel(state) {
  const hit = SEND_STATES[state];
  return hit ? hit.label : `未知状态（${String(state)}）`;
}

/**
 * 一行中文描述（任务列表用）。
 *
 * ⚠️ 硬要求：`unverified` 必须写出**"无法确认是否发出"**，并且明确"要人接手"。
 *    写成"已发送"是撒谎；写成"失败"会让用户重发（可能重复）；写成"发送中"
 *    会让用户一直等一个永远不会自己结束的状态。这三种写法都比不显示更糟。
 */
export function describeTask(task) {
  const t = (task && typeof task === 'object') ? task : {};
  const ch = SEND_CHANNELS.find((c) => c.key === t.channel);
  const chLabel = ch ? ch.label : `未知通道（${t.channel == null ? '没填' : (typeof t.channel === 'object' ? '一个不是字符串的值' : String(t.channel))}）`;
  const st = SEND_STATE_KEYS.includes(t.state) ? t.state : null;
  if (!st) {
    // ⚠️ 脏值（缺 state / state 是对象）都要给一句人话，**不许把 undefined 拼进界面**：
    //    "状态不合法（undefined）" 看起来像程序坏了，而它其实是数据坏了。
    const raws = t.state == null ? '' : (typeof t.state === 'object' ? '一个不是字符串的值' : String(t.state));
    return `${chLabel}：这条任务的状态不合法${raws ? `（${raws}）` : ''}，没法处理，建议删掉重建`;
  }
  const code = t.reason && t.reason.code;
  const why = t.reason && (t.reason.detail || t.reason.label || (code ? SEND_FAIL_REASONS[code] && SEND_FAIL_REASONS[code].label : ''));
  switch (st) {
    case 'pending':
      return `${chLabel}：还没发`;
    case 'preparing':
      return `${chLabel}：正在准备`;
    case 'awaiting':
      return `${chLabel}：文本已就绪，等你按下发送`;
    case 'sending':
      return `${chLabel}：正在发送`;
    case 'confirmed': {
      const kind = t.evidence && t.evidence.kind;
      const how = kind === 'user-confirmed' ? '你确认过' : kind === 'channel-receipt' ? '通道回了回执' : '有截图证据';
      return `${chLabel}：已确认发出（${how}）`;
    }
    case 'unverified':
      return `${chLabel}：无法确认是否发出${why ? `（${why}）` : ''} —— 要你接手核对一下，别直接重发`;
    case 'failed':
      return `${chLabel}：发送失败${why ? ` —— ${why}` : ''}`;
    case 'cancelled':
      return `${chLabel}：已取消`;
    default:
      return `${chLabel}：${stateLabel(st)}`;
  }
}

/** 同一个幂等键的**全部**任务（用来判断"这个键上出过什么事"） */
export function tasksByKey(tasks, key) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list.filter((t) => t && typeof t === 'object' && taskKey(t) === String(key));
}

/**
 * 同一个 taskKey **只保留最新一条**（防重发）。
 *
 * ⚠️ "最新"的判据按优先级来（不能只用 createdAt）：
 *   ① `updatedAt`：重试会更新它 —— 一条去年建的、昨天刚确认发出的任务，
 *      比一条昨天建的、还停在 pending 的任务"新"。
 *   ② 数组**靠后的**：稳定、可复现，且同步合并进来的新记录通常追加在后面。
 *   ③ `id`：最后的确定顺序（同一时刻的两条也不会因为遍历顺序而结果不同）。
 *   平局时若三条全都一样，保留靠后那条（同样的输入 → 同样的输出，测试要钉这一条）。
 *
 * ⚠️ 返回的数组**保持"每个键最后一条"的相对顺序**（按它们在原数组里最后一次出现的位置），
 *    不去重排 —— 界面列表的顺序不该被这个纯函数改掉。
 */
export function taskDedupe(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const best = new Map();   // key -> {task, score, index}
  list.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const key = taskKey(t);
    if (!key) return;
    const score = [
      nowDate(t.updatedAt).getTime() || nowDate(t.createdAt).getTime() || 0,
      i,
      String(t.id || ''),
    ];
    const prev = best.get(key);
    if (!prev || compareScore(score, prev.score) >= 0) best.set(key, { task: t, score, index: i });
  });
  const out = [...best.values()].sort((a, b) => a.index - b.index).map((x) => x.task);
  return out;
}

/** 三元组比较：时间 → 位置 → id。返回 >0 表示 a 更新 */
function compareScore(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}
