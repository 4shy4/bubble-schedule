// 气泡区的**手势诊断角标** —— 一个默认关闭、设置里可开的小角标。
//
// ===========================================================================
// 为什么必须有它（这是"在平板上没法诊断"这件事的正面解法）
// ===========================================================================
//
// 这一轮的报障是"长按 2.5 秒完全没看到（进度）环"。而我手上能用的手段：
//   · Node 假 DOM 里跑手势序列 —— 25 条全绿，**证明不了屏幕上发生了什么**；
//   · 真机/真浏览器 —— 这一轮里我连无头浏览器都起不来（沙箱禁命名管道）。
// 于是"到底哪一环断了"这件事**只能靠用户的眼睛**。而用户能说清的东西是有限的：
// 他看不到控制台、也不会去数事件。
//
// 所以这个角标的唯一目的是：**把"屏幕上发生了什么"变成用户可以照着念的一行字**。
//   · 有没有 `pointerdown`？→ `down=` 涨没涨
//   · pointer 一条都不来吗？→ `t=` 那一格（touch 通道的计数）会单独显示
//   · 是不是被谁取消了？→ `ev=` 说明哪条通道在带，`hold=` 那一格**直接写取消原因**
//   · 装的是不是新包？→ 末尾的版本标记
//
// ⚠️⚠️ 两条硬要求：
//   ① **`pointer-events: none`**（见 web/css/views.css 的 `.bubble-diag`）：
//      它是诊断器，**绝不能把长按手势吃掉** —— 否则"为了看清为什么没反应"
//      反而制造了一个新的"没反应"，那是最糟的结果。
//   ② **不许依赖渲染帧**：角标的更新由事件处理器直接触发（外加一个 200ms 的心跳），
//      **不放在 rAF 里**。理由和长按一样（见 bubble-gesture.js 文件头）：
//      要诊断的恰恰可能是"帧循环不动了"，诊断器自己不能跟着一起不动。
//
// 本模块**不认识 DOM**：角度格式化与计数在这里，挂到哪个元素上由调用方决定
// （这样它能在 Node 里被直接测，不需要假 DOM）。

/** 存"要不要显示角标"的键（默认关闭；`?diag=1` 或设置里打开） */
export const DIAG_KEY = 'timetable.bubble.diag';

/** 角标里"长按"那一格的阈值（毫秒）。默认与手势模块一致，测试里可覆盖。 */
const DEFAULT_LONG_PRESS_MS = 2500;

/** 秒数格式化：`1.2s` / `0.35s`（**一位小数够了** —— 用户是念给人听的，不是看日志） */
function sec(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  return `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`;
}

/**
 * 一次手势的计数与"最后一件事"。
 *
 * ⚠️ 计数按**阶段**（down/move/cancel/up）而不是按事件名分：用户要回答的问题是
 *    "按到了没有 / 有没有被取消"，那三个数就够了。但**原始事件名**（`last=`）
 *    必须原样留着 —— 它是唯一能区分"pointer 还是 touch 在送"的东西。
 *    touch 通道单独再记一套（`t=`）：两边**同时**有数说明两条通道都活着（正常），
 *    只有 `t=` 有数说明这台 WebView 没给 pointer（这正是要兜底的那种情况）。
 */
export function createBubbleDiag({ longPressMs = DEFAULT_LONG_PRESS_MS, now } = {}) {
  const clock = typeof now === 'function'
    ? now
    : (typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now());

  const count = { down: 0, move: 0, cancel: 0, up: 0 };
  const touch = { down: 0, move: 0, cancel: 0, up: 0 };
  /** 最后一次收到的**原始 DOM 事件名**（`pointercancel` / `touchstart` / …） */
  let last = '';
  /** 最近一次手势由哪条通道驱动（`pointer` / `touch`）—— 见 bubble-gesture.js 的"通道锁" */
  let ev = '';
  /** 长按开始时刻（0 = 当前没有在长按） */
  let holdStartAt = 0;
  /** 长按结束之后的结局文本（`戳破@2.5s` / `取消:drifted-too-far@0.4s` / `松手@1.1s`） */
  let holdOutcome = '';
  /** 版本 / 构建标记（由调用方填，见下 setVersion） */
  let version = '';

  /** 原始事件名 → 它属于哪个阶段（认不出来的就不计数，只更新 `last`） */
  function phaseOf(type) {
    if (/(down|start)$/.test(type)) return 'down';
    if (/move$/.test(type)) return 'move';
    if (/cancel$/.test(type)) return 'cancel';
    if (/(up|end)$/.test(type)) return 'up';
    return null;
  }

  return {
    /**
     * 记一次**原始事件**（在调用真实处理器之前调，所以它不会漏记任何一条）。
     * @param {string} type 原始事件名，例如 'pointerdown' / 'touchcancel' / 'contextmenu'
     */
    hit(type) {
      const t = String(type || '');
      last = t;
      const ph = phaseOf(t);
      if (ph) {
        count[ph] += 1;
        if (t.startsWith('touch')) touch[ph] += 1;
      } else if (t === 'contextmenu') {
        // 系统长按菜单会掐断这一次手势 —— 它算一次"取消"，否则角标上看不出原因
        count.cancel += 1;
      }
    },
    /** 这一次手势由哪条通道在带（`pointer` / `touch`） */
    drove(channel) { ev = channel || ev; },

    /** 长按开始（手势模块的 onHoldStart：**只有真的命中泡泡**才会来） */
    holdStart() { holdStartAt = clock(); holdOutcome = ''; },
    /**
     * 长按结束。
     * @param {string} reason 手势模块给的原因（`pointerup` / `drifted-too-far` /
     *   `pointercancel` / `touchcancel` / `multi-touch` / `contextmenu` / `blur` / …）
     */
    holdEnd(reason) {
      if (!holdStartAt) return;
      const ms = clock() - holdStartAt;
      holdStartAt = 0;
      holdOutcome = `结束:${reason || '?'}@${sec(ms)}`;
    },
    /** 长按到点 → 真的戳破了 */
    holdFired() {
      const ms = holdStartAt ? clock() - holdStartAt : longPressMs;
      holdStartAt = 0;
      holdOutcome = `戳破@${sec(ms)}`;
    },
    /** 版本 / 构建标记（见 bubble.js 里 detectVersion 的说明：复用已有的版本来源） */
    setVersion(v) { version = String(v || ''); },
    get version() { return version; },

    /** 当前是否正在长按（给测试与"心跳刷新"用） */
    get holding() { return holdStartAt !== 0; },

    /** 只读快照（测试用；也便于角标以外的地方读） */
    snapshot: () => ({
      down: count.down, move: count.move, cancel: count.cancel, up: count.up,
      touch: { ...touch }, last, ev, holding: holdStartAt !== 0, holdOutcome, version,
      heldMs: holdStartAt ? clock() - holdStartAt : 0,
    }),

    /**
     * 角标那一行字。
     *
     * 形状（和用户被要求念的那句一致）：
     *   `down=3 move=41 cancel=1 up=2 · last=pointercancel · hold=1.2s/2.5s · ev=pointer`
     * touch 通道有数时**多一格** `t=`（down/move/cancel/up 四个数）——
     * 这一格是"这台设备到底给不给 pointer"的唯一证据，所以只在有数时显示，不占版面。
     * 长按结束之后 `hold=` 那一格换成**结局 + 取消原因**（这是最有用的一格）。
     */
    text() {
      const parts = [
        `down=${count.down} move=${count.move} cancel=${count.cancel} up=${count.up}`,
      ];
      const touchAny = touch.down + touch.move + touch.cancel + touch.up;
      if (touchAny) {
        parts.push(`t=${touch.down}/${touch.move}/${touch.cancel}/${touch.up}`);
      }
      parts.push(`last=${last || '—'}`);
      if (holdStartAt) {
        parts.push(`hold=${sec(clock() - holdStartAt)}/${sec(longPressMs)}`);
      } else {
        parts.push(`hold=${holdOutcome || '—'}`);
      }
      parts.push(`ev=${ev || '—'}`);
      if (version) parts.push(`v=${version}`);
      return parts.join(' · ');
    },
  };
}

/**
 * 读"要不要开角标"。
 *
 * 默认**关闭**（这是给排障用的东西，平时不该占屏幕）。
 * 两个入口：URL 上加 `?diag=1`（一次性的、刷新就没了）或设置面板里的开关
 * （写 localStorage，见 DIAG_KEY）。和 `?debug=1` 一个套路 —— 项目里已经有一个了，
 * 不另立门户。
 *
 * ⚠️ 读 URL / localStorage 都可能抛（无痕模式、被策略禁掉）→ 一律当"关闭"，
 *    绝不允许"读个偏好设置"把气泡区搞崩。
 */
export function diagRequested(search, storage) {
  try {
    if (search && new URLSearchParams(search).get('diag') === '1') return true;
  } catch { /* search 不是合法查询串就当没写 */ }
  try {
    if (storage && storage.getItem(DIAG_KEY) === '1') return true;
  } catch { /* 存储被禁 → 当关闭 */ }
  return false;
}
