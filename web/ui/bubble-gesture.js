// 气泡区的**指针手势状态机** —— 从 `web/ui/views/bubble.js` 里抽出来的那一段。
//
// ===========================================================================
// 为什么必须抽出来（这是用户报的 iPad bug 的真正教训）
// ===========================================================================
//
// 用户报（0.10.13，iPad 真机）：**"长按 2.5 秒无响应"** —— 长按到底也不戳破，
// 而且用户补了一句关键线索：**"之前长按有效，应该也和节日改动有关"**。
//
// 老实现的形状是这样的（bubble.js 里原来的 stepHold）：
//     · 长按的**计时、进度、以及"到点了没有"的判定**全都活在 `requestAnimationFrame`
//       的帧回调里（`stepHold(dt)` 每帧算 `(performance.now() - holdStart) / LONG_PRESS_MS`）；
//     · 而那一帧的最后一句才是 `raf = requestAnimationFrame(frame)`。
//     → 只要**帧里任何一处抛出**，这句就永远不再执行，**整个循环死掉**：
//          · 泡泡不再重画（用户之前报的"泡泡隐身了但还能点到"就是这个）
//          · **长按永远不触发**（计时器在死掉的循环里，2.5 秒再也不会被走完）
//          · 但单击/双击仍然正常 —— 它们直接在 pointerup 分支里处理，不依赖帧循环
//       这三条症状叠在一起，就是用户看到的"长按无响应"。
//
// 所以这个模块立了一条**不可退让的规矩**：
//
//   **长按的触发只能依赖"时钟 + 事件"，绝不能依赖渲染帧。**
//
// 具体做法：在 `pointerdown` 那一刻就挂一个 `setTimeout(…, LONG_PRESS_MS)`，
// 在 `pointerup` / `pointercancel` / 移动越界 / 多指 / 失焦 时清掉它。
// `progress()` 只提供**给画笔看**的进度（渲染循环活着时才有环，见下面"视觉反馈"），
// 它**不参与**"到没到时间"的判定 —— 循环死了，长按照样戳破，只是看不到那圈环。
//
// ===========================================================================
// 这条链路上另外几个真机上会咬人的点（逐条都在代码里）
// ===========================================================================
//
//  · **手指的位移阈值不能沿用鼠标的**：鼠标是像素级精确的；手指按在玻璃上
//    2.5 秒不抖是不可能的（这是触摸屏的物理事实，不是用户手不稳）。
//    原来 `pointerMoved > 12` 就取消 —— 那是给"拖动"用的阈值，拿来判断长按太紧。
//    这里分成两个数（见 MAX_TAP_SLOP_PX / MAX_HOLD_SLOP_PX）。
//
//  · **`pointercancel` 之后状态必须复位**：iOS 一旦把手势接管过去
//    （滚动/缩放/文字选择/系统菜单），会发 `pointercancel`，此后再不会有 pointerup。
//    如果这时只是"停止长按"而不把状态清干净，下一次长按会被上一次的残留卡住 ——
//    表现就是"第一次长按被系统掐断之后，后面怎么按都不灵了"。
//    这里所有退出路径（up / cancel / 多指 / 失焦）都走同一个 `reset()`。
//
//  · **多指**：第二根手指按下来时，第一根的手指还没松。触摸屏上"掌根/另一根手指
//    蹭到屏幕"是常事，一旦发生就必须**取消长按**（否则会在两指之间来回抢 hold）。
//
//  · **`contextmenu`**：iOS 13.4+ 在可交互元素上长按会发 `contextmenu`（长按菜单）。
//    它和"长按戳破"是同一个手势 —— 必须拦掉，而且**不能顺带把我们的计时器弄丢**
//    （这里的选择是：拦掉菜单 + 取消这一次长按并复位。理由见 onContextMenu 的注释）。
//
//  · **时钟只能有一种**：全程 `now()`（注入的，生产里就是 `performance.now()`）。
//    `Date.now()` 与 `performance.now()` 混用会让差值变成天文数字或负数，
//    判定"永远不成立"而且**一声不响**（这个项目在别处踩过同类坑）。
//
//  · **必须有 touch 兜底通道，而且两条通道必须去重**（见下面"两条通道"那一节）。
//    只挂 pointer 事件的风险是：**"这台设备的 WebView 到底给不给 pointer"我们无法验证**。
//    给不给不由我们决定（WKWebView 各版本、系统的滚动/长按菜单判定都会影响
//    pointer 序列是否完整送达）。所以这里**不做假设**：
//    pointer 有就收 pointer；pointer 一条都不来时由 touch 顶上。

/** 长按多久算"戳破"（用户指定 2.5 秒） */
export const LONG_PRESS_MS = 2500;

/**
 * "轻点 / 拖动"的位移阈值（沿用原来的手感，**这是给鼠标和精确点击用的**）。
 * 超过它就认为用户在拖气泡，不是点。
 */
export const MAX_TAP_SLOP_PX = 12;

/**
 * 长按期间允许的**手指漂移**（比点击阈值宽得多）。
 *
 * ⚠️ 为什么必须单独一个数、而且必须比 12 大很多：
 *    手指按在玻璃上 2.5 秒，指尖自己就会游走十几到几十像素（手掌重心在变），
 *    玻璃上的静电/形变也会让坐标跳。用 12px 当长按门槛 =
 *    "越是想稳稳按住不动，越容易被自己的手抖取消"。
 *    60px 的取法：比"点一下时的手抖"（十几像素）宽得多，
 *    又小于一颗泡泡的典型直径（半径 40–104 → 直径 80+），
 *    所以"手指真的想拖走气泡"照样会被判成拖动，而"按住不动"不会被误杀。
 *
 * ⚠️ 判据是**离按下点的直线距离**，不是累计路径长度。
 *    手指在原地来回蹭，累计路径能轻松超过这个数，但它从没离开过按下点 ——
 *    拿累计路径当长按门槛，长按必然时灵时不灵（真机上就是这个现象）。
 */
export const MAX_HOLD_SLOP_PX = 60;

/**
 * ===========================================================================
 * 两条通道：pointer（主）+ touch（兜底），**用"通道锁"去重**
 * ===========================================================================
 *
 * 为什么要两条：这一次的报障逼出来的教训是 ——
 *   **"事件到底有没有到我们的处理器"这件事，在平板上是看不见的**（没有控制台）。
 *   而 pointer 事件是否完整送达，取决于 WebView 版本、`touch-action` 的判定结果、
 *   系统的滚动/长按菜单/文字选择是否把手势抢走 —— **这些都不由我们决定**。
 *   所以不能赌"pointer 一定有"：touch 是 iOS 上**最古老、最不可能被绕开**的那条通道。
 *
 * 为什么要"通道锁"（这是本模块最容易写错的一处）：
 *   Safari 对**同一次**触摸既发 `pointerdown` 又发 `touchstart`（两条通道都在）。
 *   如果两边各跑一遍，一次触摸会被当成**两次按下** —— 第二次会落进"多指"分支，
 *   于是 `clearHold('multi-touch') + reset()`：**长按刚开始就被自己取消掉**。
 *   这正是最难查的一类（长得像"系统把手势抢走了"，其实是自己人打自己人）。
 *
 *   ⚠️ 去重的做法**不能**用时间窗（"350ms 内算同一次"）—— 那是猜。
 *      这里用的是确定性的**通道锁**：
 *        · **谁先送到，整次手势就归谁**（`channel` 记下来）；
 *        · 另**一条**通道在这次手势期间**全部忽略**（连同它的 up/cancel），
 *          手势结束（`reset`）时锁才释放。
 *      · 两条通道驱动的是**同一个状态机**，所以不管谁赢，判定/阈值/计时完全一样。
 *
 *   ⚠️ 顺序上说清楚（Safari 实测顺序是 pointerdown → touchstart）：
 *      · pointer 先到 → 锁 = pointer，后面那条 touchstart 被忽略 → 正常；
 *      · 万一某版本反过来（touch 先到）→ 锁 = touch，pointer 被忽略 → 照样正常。
 *        两种顺序都不会出现"被处理两遍"。
 *
 * 事件形状（由调用方归一化后传进来，模块本身不认识 DOM）：
 *   { pointerId, pointerType, isPrimary, clientX, clientY, touchCount? }
 *   · 坐标**必须是画布内坐标**（和 `pick` 同一个口径）；
 *   · `touchCount` = 这一刻屏上还有几根手指（touch 通道用；pointer 通道不用）。
 */

/**
 * 创建一个手势状态机。
 *
 * 它**只管状态**，不碰 canvas、不碰物理模型：所有"该干什么"都通过回调还给调用方
 * （bubble.js 用它们去动 `dragBody` / `popBubble`）。这样同一个状态机
 * 既跑在真机上，也能在 Node 里被 `tools/bubble-longpress.test.mjs` 用
 * **合成事件序列**逐条钉住 —— 不需要假装一个 DOM。
 *
 * @param {object} o
 * @param {number} [o.longPressMs] 长按阈值（默认 LONG_PRESS_MS）
 * @param {number} [o.maxTapSlop]  轻点/拖动的位移阈值（默认 MAX_TAP_SLOP_PX）
 * @param {number} [o.maxHoldSlop] 长按期间的漂移容忍（默认 MAX_HOLD_SLOP_PX）
 * @param {() => number} [o.now]   时钟（默认 performance.now；**只允许这一种时钟**）
 * @param {(ms:number, fn:() => void) => any} [o.setTimer]   注入定时器（测试里可换）
 * @param {(id:any) => void} [o.clearTimer]
 * @param {(x:number, y:number, e:object) => any} o.pick     命中判定：返回命中的东西（假值 = 背景）
 * @param {(pos:{x:number,y:number}, e:object) => void} [o.onPressBubble]  按下就落在某个泡泡上（**立刻**给视觉反馈）
 * @param {(pos:{x:number,y:number}, dx:number, dy:number, e:object) => void} [o.onMove]
 * @param {(ctx:object) => void} [o.onRelease] 轻点/拖动结束（松手）
 * @param {(ctx:object) => void} [o.onCancel]  这次手势被取消（**调用方必须把状态复位**）
 * @param {(what:string, e:object) => void} [o.onHoldStart]
 * @param {(dx:number, dy:number) => void} [o.onHoldMove] 长按期间的手指漂移（还没取消）
 * @param {(what:string) => void} [o.onHoldCancel]
 * @param {(e:object) => void} [o.onHoldFire]  长按到点 → 戳破
 *
 * ⚠️ 交给调用方的入口分**两条通道**（`onPointerXxx` / `onTouchXxx`），它们驱动的是
 *    同一个状态机，所有回调（onPressBubble / onRelease / onCancel / …）只有一份。
 *    调用方要做的事只有一件：**把事件归一化成同一个形状再喂进来**
 *    （`{pointerId, pointerType, isPrimary, clientX, clientY, touchCount?}`，
 *     坐标必须是画布内坐标）。去重由模块内的"通道锁"负责，调用方不要自己判。
 */
export function createBubbleGesture(o) {
  const longPressMs = Number.isFinite(o.longPressMs) ? o.longPressMs : LONG_PRESS_MS;
  const maxTapSlop = Number.isFinite(o.maxTapSlop) ? o.maxTapSlop : MAX_TAP_SLOP_PX;
  const maxHoldSlop = Number.isFinite(o.maxHoldSlop) ? o.maxHoldSlop : MAX_HOLD_SLOP_PX;
  // ⚠️ 时钟兜底：`performance` 在很老的 WebView 里可能没有，但**绝不能**退回 `Date.now()`
  //    之外的东西之后又混用 —— 这里的兜底是"整个状态机统一用同一个函数"，
  //    不是"哪个方便用哪个"。
  const now = typeof o.now === 'function'
    ? o.now
    : (typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now());
  const setTimer = o.setTimer || ((ms, fn) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer || ((id) => clearTimeout(id));
  const pick = o.pick;
  const call = (fn, ...args) => { if (typeof fn === 'function') fn(...args); };

  /** 活跃指针 id（`null` = 当前没有手势）。
   *  ⚠️ 用它过滤"不属于这次手势的指针事件"：多点触控下第二根手指的
   *  pointerup/pointermove 会一起送进来，不区分就会把第一根的手指手势提前结束。 */
  let activeId = null;
  /** 长按计时器的 id（`null` = 没在计时） */
  let timerId = null;
  let holdActive = false;
  let holdFired = false;
  let pressAt = 0;
  let pressPos = null;
  let lastPos = null;
  let moved = 0;
  /** 这一轮手势里"拖动"有没有开始过（`onMove` 用它决定要不要让泡泡跟手） */
  let dragged = false;
  /** 这次手势按在哪个泡泡上（背景手势为 null） */
  let target = null;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** 清掉长按计时器。**只碰计时器**，不动 activeId —— 见 clearHold。 */
  function stopHoldTimer() {
    if (timerId !== null) {
      try { clearTimer(timerId); } catch { /* 定时器已经被清过了，无妨 */ }
      timerId = null;
    }
  }

  /**
   * 结束"长按"这件事（清计时器 + 复位 hold 状态）。
   * 反复调用是安全的 —— 所有退出路径都会走它，重复调用不能出错。
   */
  function clearHold(reason) {
    const wasActive = holdActive;
    holdActive = false;
    stopHoldTimer();
    if (wasActive) call(o.onHoldCancel, reason);
  }

  /**
   * 把**整次手势**复位干净。
   *
   * ⚠️⚠️ 这是"掐断之后下一次还灵不灵"的关键：`pointercancel` 之后再也不会来
   *  pointerup，如果这里漏掉任何一项（尤其是 `activeId`），下一次 pointerdown
   *  就会被当成"第二根手指"直接忽略 —— 用户看到的就是"掐断一次之后，怎么按都没反应"。
   */
  function reset(reason, { bubbleEnded = false } = {}) {
    clearHold(reason);
    if (activeId !== null || pressPos) {
      // 手势是被**打断**的：交给 onCancel 去复位（调用方要清 dragBody / 把泡泡放回原处）
      if (!bubbleEnded) {
        call(o.onCancel, { reason, pos: lastPos, pressPos, target, moved, holdFired });
      }
    }
    activeId = null;
    // ⚠️ 通道锁**必须在这里释放**：它和 `activeId` 是一对。
    //    漏掉它 = 这一次是 touch 驱动的、下一次 pointer 事件会被永远忽略
    //    （或者反过来）—— 症状是"第一次长按之后，某一条通道就再也不灵了"。
    channel = null;
    pressAt = 0;
    pressPos = null;
    lastPos = null;
    moved = 0;
    dragged = false;
    target = null;
    holdFired = false;
  }

  /**
   * 长按到点了 —— **由 setTimeout 直接调用，和渲染帧没有任何关系**。
   *
   * ⚠️ 这里必须 `try/catch`：这个函数是从定时器回调里跑的，
   *    抛出去就是一个**未捕获异常**（在 iPad 上连控制台都看不到，只有一个"没反应"）。
   *    业务回调（popBubble）自己也有兜底，这里是最后一道。
   */
  function fireHold() {
    timerId = null;
    if (!holdActive || !target) return;
    const t = target;
    const e = { pointerId: activeId, pointerType: lastPointerType };
    holdActive = false;
    holdFired = true;
    // 先复位"手势层面"的状态，再交给业务 —— 这样即使业务抛了，
    // 手势也不会卡在"正在长按"上（否则下一次长按会被上次的残留挡住）。
    activeId = null;
    pressPos = null;
    lastPos = null;
    moved = 0;
    dragged = false;
    target = null;
    pressAt = 0;
    try {
      call(o.onHoldFire, e, t);
    } catch (err) {
      call(o.onError, err);
    }
  }

  /** 最近一次按下的指针类型（`touch` / `mouse` / `pen`）—— 只用于诊断与回调 */
  let lastPointerType = '';

  /** 这次手势归哪条通道（见文件头"两条通道"）：`'pointer'` / `'touch'` / `null`（当前没手势） */
  let channel = null;

  /** 这个指针 id 是不是当前手势的那一个（touch 的 identifier 与 pointerId 是两个空间） */
  function isActivePointer(id) {
    return activeId !== null && (id === undefined || id === activeId);
  }

  /**
   * 一次手势的**共同起点** —— 两条通道都走这里。
   *
   * ⚠️ 为什么要抽出来：两条通道各写一份"起手"必然漂移（这个项目在
   *    `remainingOf` / `levelOf` 上已经因为"同一件事两份实现"栽过两次）。
   *    通道的差别**只有**"事件从哪来、要不要去重"，判定逻辑必须只有一份。
   *
   * @param {object} e 归一化后的事件（坐标已是画布内坐标）
   * @param {'pointer'|'touch'} from
   */
  function beginGesture(e, from) {
    // ⚠️ 顺序要紧：先判"已经有一次手势在跑"（多指），再定通道锁。
    //    否则第二根手指会被当成"另一条通道的同一次触摸"而被静默忽略。
    if (activeId !== null) {
      clearHold('multi-touch');
      reset('multi-touch', { bubbleEnded: true });
      call(o.onExtraPointer, e);
      return;
    }
    // 只认主指针：iOS 上非主指针是"附加触点"，不是新的手势
    if (e.isPrimary === false) { call(o.onExtraPointer, e); return; }

    const pos = { x: e.clientX, y: e.clientY };
    channel = from;
    activeId = e.pointerId === undefined ? 1 : e.pointerId;
    lastPointerType = e.pointerType || (from === 'touch' ? 'touch' : '');
    pressAt = now();
    pressPos = pos;
    lastPos = pos;
    moved = 0;
    dragged = false;
    holdFired = false;
    target = pick ? pick(pos.x, pos.y, e) : null;

    // 背景：没有"长按"这个手势（长按戳破只对泡泡有效），只记位置等 up 判单击/双击。
    if (!target) {
      holdActive = false;
      call(o.onPressBackground, pos, e);
      return;
    }

    holdActive = true;
    call(o.onPressBubble, pos, e);

    /**
     * ⚠️⚠️ **这就是这次 bug 的修法本体**：长按的触发挂在 `setTimeout` 上，
     *     和 `requestAnimationFrame` 完全解耦。
     *     即使帧循环死了（节日改动引入的某处抛出让 `raf` 续排被打断），
     *     这个定时器照样会到点，长按照样戳破。
     */
    stopHoldTimer();
    timerId = setTimer(longPressMs, fireHold);
    call(o.onHoldStart, target, e);
  }

  /** 一次手势的**共同移动**处理（两条通道共用） */
  function moveGesture(e) {
    const pos = { x: e.clientX, y: e.clientY };
    const d = dist(pos, lastPos || pos);
    moved += d;                       // 累计路径长度（只用于诊断/状态快照）
    lastPos = pos;

    if (target && holdActive) {
      /**
       * ⚠️⚠️ 这一段是"手指不是鼠标"那条教训的落点，两个数**各问一件事**：
       *
       *   · `drift`（离**按下点**的直线距离）
       *       - > `maxTapSlop`(12px) → 这一次**是拖动**（`dragged` 置位，
       *         上层会让泡泡跟手走）。滚动/嵌套判定在松手时做。
       *       - > `maxHoldSlop`(60px) → 跑得太远了，"按住原地"不成立 → **取消长按**。
       *       为什么长按用直线距离而不是累计路径：手指在原地来回蹭，
       *       累计路径能轻松超过 60px，可它**从没离开过按下点** ——
       *       用累计路径当门槛就是"越稳越容易被自己的手抖取消"，
       *       真机表现正是"长按怎么都不灵"。
       *
       *   · `moved`（累计路径长度）只留给诊断，**不参与任何判定**。
       *       （原来它是唯一的依据，阈值 12px，所以手指抖十几像素长按就废了。）
       */
      const drift = pressPos ? dist(pos, pressPos) : 0;
      if (!dragged && drift > maxTapSlop) dragged = true;
      if (drift > maxHoldSlop) clearHold('drifted-too-far');
    }
    // ⚠️ 只有"是拖动"才让泡泡跟手。否则手指在 12px 内的轻微游走会把泡泡
    //    拖着走十几像素 —— 用户看着就是"按一下泡泡自己跑了"。
    if (target && dragged) {
      call(o.onMove, pos, e.clientX - pressPos.x, e.clientY - pressPos.y, e);
    }
    if (target && holdActive) call(o.onHoldMove, lastPos.x - pressPos.x, lastPos.y - pressPos.y);
  }

  /**
   * 一次手势的**共同结束**（松手）—— 两条通道共用。
   *
   * ⚠️ 注意 `release` 的 reason 只是**记账用**：调用方（bubble.js）不按它分支，
   *    它只进诊断角标。"是单击还是拖动"由 `holdFired / dragged / heldMs` 判定。
   */
  function endGesture(e, reason) {
    const pos = { x: e.clientX, y: e.clientY };
    const ctx = {
      target, pos, pressPos, moved, dragged,
      heldMs: now() - pressAt, holdFired, pointerType: lastPointerType,
    };
    // 手指最后可能抬在别处：最后一段位移也算进去（否则"按着挪出去再松手"会漏判）
    if (lastPos) ctx.moved = moved + dist(pos, lastPos);
    lastPos = pos;
    clearHold(reason);
    if (holdFired) {
      // 长按已经戳破了：这次手势到此为止，**不要再当成单击/拖动**。
      reset('after-pop', { bubbleEnded: true });
      return;
    }
    // 先复位再回调（回调里可能会读状态；也保证回调抛了手势也复位了）
    activeId = null;
    channel = null;
    pressPos = null;
    lastPos = null;
    moved = 0;
    dragged = false;
    target = null;
    call(o.onRelease, ctx);
  }

  // ---------- pointer 通道（主）----------

  function onPointerDown(e) {
    // 通道锁：这次触摸已经归 touch 管了 → pointer 这一份是**同一次触摸的重复投递**，
    // 必须整条忽略（连同后面的 move/up/cancel），否则会被当成"第二根手指"。
    if (channel === 'touch') return;
    beginGesture(e, 'pointer');
  }

  function onPointerMove(e) {
    if (channel !== 'pointer') return;
    if (!isActivePointer(e.pointerId)) return;
    moveGesture(e);
  }

  function onPointerUp(e) {
    if (channel !== 'pointer') return;
    if (!isActivePointer(e.pointerId)) return;   // 别的指头松了，不关这次手势的事
    endGesture(e, 'pointerup');
  }

  /**
   * `pointercancel` / `touchcancel` —— 系统把手势接管了。
   *
   * ⚠️ 这是 iPad 上最容易被忽略、后果最难查的一条：iOS 判定为滚动/缩放/文字选择/长按菜单
   *    时会发 `pointercancel`，**之后再也不会发 pointerup**。
   *    所以这里必须做两件事：① 取消长按；② **把状态彻底复位**（`activeId` 一起清），
   *    否则紧接着的下一次长按会被残留状态挡掉 —— "第一次被掐断后就再也不灵了"。
   */
  function onPointerCancel(e) {
    if (channel !== 'pointer') return;
    if (!isActivePointer(e && e.pointerId)) return;
    reset('pointercancel');
  }

  // ---------- touch 通道（兜底）----------
  //
  // 只在"这次的 press 没被 pointer 接过"时起作用（见通道锁）。
  // ⚠️ 一条都不能少：touchstart/move/end/cancel 四件配齐，
  //    少了 touchend 会"永远按着不放"，少了 touchcancel 就会"被系统掐断一次之后再也不灵"。

  function onTouchStart(e) {
    if (channel === 'pointer') return;           // 去重：pointer 已经在带这次触摸
    // 多指：第二根手指落下来（`touchCount > 1`）。触摸屏上"掌根/另一根手指蹭上来"
    // 是常事，必须取消长按，否则两根手指会在 hold 上互相抢。
    if ((e.touchCount || 0) > 1) {
      if (activeId !== null) {
        clearHold('multi-touch');
        reset('multi-touch', { bubbleEnded: true });
      }
      call(o.onExtraPointer, e);
      return;
    }
    beginGesture(e, 'touch');
  }

  function onTouchMove(e) {
    if (channel !== 'touch') return;
    if (!isActivePointer(e.pointerId)) return;
    moveGesture(e);
  }

  /**
   * `touchend`。
   *
   * ⚠️ `touchCount > 0` 表示**还有别的手指按在屏幕上** —— 那说明这次是多指，
   *    不是"我们这根手指正常松开了"。这时按"被打断"处理（取消 + 复位），
   *    绝不当成单击/拖动派发出去 —— 否则会莫名其妙弹出编辑器。
   */
  function onTouchEnd(e) {
    if (channel !== 'touch') return;
    if (!isActivePointer(e.pointerId)) return;
    if ((e.touchCount || 0) > 0) { reset('multi-touch'); return; }
    endGesture(e, 'touchend');
  }

  function onTouchCancel(e) {
    if (channel !== 'touch') return;
    if (!isActivePointer(e && e.pointerId)) return;
    // 与 pointercancel 完全同一条：取消 + **彻底复位**，之后照样能再长按。
    reset('touchcancel');
  }

  /**
   * `contextmenu`（iOS 13.4+ 长按可交互元素会发）。
   *
   * 选择：**拦掉菜单 + 取消这一次长按并复位**。
   *   · 为什么不"拦掉菜单但让长按继续"：能弹出系统菜单说明系统已经把这次触摸
   *     判成"想选中/想要菜单"了，后面指针序列多半不会再完整送到（会跟着一个
   *     pointercancel）。硬留着计时器，用户会看到"菜单没弹、泡泡也没破"——
   *     最糟的一种半成品。取消掉、复位干净，用户抬手重按一次就好，行为可预测。
   *   · 注意**不能**在这里 `return false` 或者忘了清计时器：那样下一次长按会被残留卡住。
   */
  function onContextMenu(e) {
    if (e && typeof e.preventDefault === 'function') {
      try { e.preventDefault(); } catch { /* 有些宿主的事件是只读的，拦不住就算了 */ }
    }
    reset('contextmenu');
  }

  /**
   * 失焦 / 切到后台 / 页面隐藏：用户的手可能已经不在屏幕上了，
   * 但浏览器的 pointerup 可能永远不来（iOS 切 App 就是如此）——
   * 必须无条件取消并复位。
   */
  function onBlur() { if (activeId !== null) reset('blur'); }

  /**
   * 给画笔看的进度 0–1（**不参与判定**）。
   * 渲染循环还活着时，这个数每帧被读一次 → 用户能看到那圈环在走；
   * 循环死了就停在原地，但长按照样会在 2.5 秒时戳破（见 fireHold）。
   */
  function progress() {
    if (!holdActive || !target) return 0;
    const raw = longPressMs <= 0 ? 1 : (now() - pressAt) / longPressMs;
    if (!Number.isFinite(raw)) return 0;      // 时钟坏了也不能喂 NaN 给 canvas
    return Math.max(0, Math.min(1, raw));
  }

  return {
    // pointer 通道
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    // touch 通道（兜底；与 pointer 用通道锁去重，见文件头）
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    onContextMenu,
    onBlur,
    /** 供停掉视图时调用：清计时器 + 复位（**必须调**，否则定时器会在视图销毁后炸） */
    destroy(reason = 'destroy') { reset(reason); },
    progress,
    /** 只读快照，给测试和诊断用（生产代码不读它） */
    state: () => ({
      activeId, channel, holding: holdActive, target, pressPos, lastPos, moved, dragged, holdFired,
      pressAt, elapsed: pressAt ? now() - pressAt : 0,
    }),
    longPressMs,
    maxTapSlop,
    maxHoldSlop,
  };
}
