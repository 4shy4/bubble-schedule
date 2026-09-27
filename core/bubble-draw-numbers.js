// 一颗气泡「要喂给 canvas 的全部数字」—— **纯函数，平台无关**（core/ 的规矩）。
//
// ⚠️⚠️ 为什么必须把这件事从 `web/ui/views/bubble.js` 里抽出来：
//
//   用户报的现象（iPad，0.10.11）：
//     · 错误条弹出 `The provided value is non-finite`（WebKit 的原话）
//     · **整个气泡区看不见泡泡了，可是还能点到**（命中的是几何模型，不是绘制）
//   这说明**绘制循环在某一颗泡泡上抛异常 → 整帧中断**。
//   `createRadialGradient` / `arc` / `ellipse` / `drawImage` 只要收到 NaN 或 Infinity
//   就抛 "non-finite"，**一颗坏泡泡能让整块气泡区变空白**。
//
//   而这个错误**在现场（平板）根本没法调试**：没有 DevTools、没有控制台。
//   所以这里的职责有两个，缺一不可：
//     ① 把数字**集中算出来**，这样它能被 Node 里的单元测试逐字段验证
//        （`tools/bubble-finite.test.mjs` 就是那条尺子）；
//     ② 每个数字都过一遍 `finiteOr()`，**非有限就退回一个安全值并记账**
//        （`problems` 数组），让上层能报出"到底哪个字段坏了"。
//
//   ⚠️ 三条容易写错的纪律：
//     1. **`??` 挡不住 NaN**。`NaN ?? 26` 还是 NaN —— 只有 `||` 才会替换掉它。
//        所以这里一律用 `Number.isFinite()` 判断，不用 `??` 兜数值。
//     2. `Math.max(1, NaN)` 也是 NaN（Math.max 不会吞掉 NaN）——
//        历史上"节日泡泡漏了 radius → mass = Math.max(1, NaN) = NaN"就是这么炸的。
//     3. 兜底**只在值非法时生效**。正常数据下这些数必须与抽出来之前**逐位相同**，
//        否则"修 bug"变成"改了观感"。
//
// 依赖方向：core → core（只依赖 level.js / urgency.js），**不碰 document/window/localStorage**。
import { levelByKey, DEFAULT_LEVEL, LEVELS } from './level.js';

/**
 * 兜底半径。用 `RADIUS_MIN`（26）而不是别的数：它是"正常气泡里最小的那一档"，
 * 一颗坏泡泡按它画出来**大小看着不突兀**，而且不会盖住别人。
 */
export const SAFE_RADIUS = 26;
/** 兜底位置的绝对值上限（只在中心点本身坏了时才用，正常永远碰不到） */
export const SAFE_COORD = 1000000;
/** 文字垫板兜底半径 */
const SAFE_PLATE_R = 12;
/** 画不出这颗时，那颗"最小安全圆"的透明度（比正常的 0.88 低一点，看得出来它有问题） */
export const SAFE_FALLBACK_ALPHA = 0.55;
/**
 * 抖动位移的绝对值上限（px）。正常路径下 `b.shake ≤ 1` → 位移 ≤ 2.2px，
 * 所以这个上限**永远不会碰到正常值**；它只防"shake 被污染成一个巨大的数"，
 * 那种情况下位置会被推到画布外（看起来同样是"泡泡不见了"）。
 */
export const SHAKE_MAX = 10;

/** 正常气泡的透明度：已完成最淡 / 超出预览范围次之 / 其余正常（与抽出来之前一致） */
export function alphaOfStyle(st) {
  const s = st || {};
  return s.done ? 0.34 : (s.dimmed ? 0.42 : 0.88);
}

/**
 * 数值兜底：**非法就换成一个安全值，并把"哪个字段坏了"记进 problems**。
 * @param {unknown} v 待检查的值
 * @param {number} fallback 安全值（必须自己就是有限数）
 * @param {string} field 字段名（报给用户看的）
 * @param {number} [lo] 下界（含）；给了就把合法值夹进来
 * @param {number} [hi] 上界（含）
 */
export function finiteOr(v, fallback, field, lo, hi) {
  void field;   // 字段名由调用方记进 problems（这里只管取值，保持它是个纯算术函数）
  // ⚠️ 只认**数字类型**或"能转成数字的字符串/布尔以外的东西"：
  //    `Number(null) === 0`、`Number('') === 0`、`Number([]) === 0` —— 这三个都会
  //    **悄悄通过 isFinite 检查**，把一个"根本没有值"当成合法的 0。
  //    0 半径 / 0 坐标进 canvas 不报错，但泡泡会缩成一个点 = 视觉上"消失"，
  //    所以这类"空的 0"必须当成坏值处理（这正是"隐身"的另一种形态）。
  if (v === null || v === undefined || v === '' || Array.isArray(v)) {
    return { value: fallback, bad: true };
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return { value: fallback, bad: true };
  if (lo != null && n < lo) return { value: lo, bad: true };
  if (hi != null && n > hi) return { value: hi, bad: true };
  return { value: n, bad: false };
}

/** 是不是"有限数"（渲染器读的每一个字段都要先过这一关） */
export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * "**有值才检查**"版兜底。
 *
 * ⚠️ 这条区别很重要，不然会报假警：
 *   `style.alpha` 这个字段**根本不存在**（透明度是按 done/dimmed 算出来的局部量），
 *   拿 `finiteOr(undefined, 0.88, 'alpha')` 去检查，会把**每一颗正常泡泡**
 *   都记成"alpha 坏了"，于是界面上每颗泡泡都弹一条错误 —— 修 bug 反而添乱。
 *   只有"赋了值、而且值非法"才该算坏字段。
 */
function pickIfGiven(v, fallback, field, problems) {
  if (v === undefined || v === null) return fallback;
  const out = finiteOr(v, fallback, field);
  if (out.bad) problems.push({ field, value: v });
  return out.value;
}

/**
 * 把任意输入归一成一个**合法的等级对象**。
 *
 * 为什么需要它（这是"数字非有限"最危险的一个入口）：
 *   渲染器里有一句 `1.16 + (st.level ? st.level.rank : 0) / 40`。
 *   `st.level` 存在但**没有 `rank`**（字符串 'red'、`{}`、旧数据、手写的 style……）
 *   → `undefined / 40 = NaN` → `r * NaN` 喂给 `createRadialGradient` → **当场抛非有限**。
 *   实测复现：把 `style.level` 设成 `'red'`（字符串），第一帧就在第 5 个参数（半径）炸。
 *
 * ⚠️ `levelByKey()` 返回的是**对象**（`core/level.js` 的 BY_KEY.get(...)），
 *    而 `DEFAULT_LEVEL` 是**字符串 'sky'** —— 这两个别混。凡是"把键当对象用"的地方
 *    都会得到 `undefined`。这里统一收口成对象，杜绝两种用法混用。
 * @returns {object} 保证有数字 `rank` 的等级对象
 */
export function safeLevelOf(levelish) {
  if (levelish && typeof levelish === 'object' && Number.isFinite(Number(levelish.rank))) {
    return levelish;
  }
  // 是对象但缺 rank（`{ key:'red' }`）→ **按它的 key 查回真档**，别一路降到 sky：
  // key 才是数据的真源，rank 只是查表结果；这里要修的是"没算出 rank"，不是"改颜色"。
  if (levelish && typeof levelish === 'object' && typeof levelish.key === 'string' && levelish.key) {
    return levelByKey(levelish.key);
  }
  const key = typeof levelish === 'string' && levelish ? levelish : DEFAULT_LEVEL;
  return levelByKey(key) || levelByKey(DEFAULT_LEVEL) || LEVELS[0];
}

/**
 * 一颗气泡在**这一帧**要用的全部数字。
 *
 * @param {object} item  `{ event, start, end, deadline, style }`（core/bubble-select.js 的产物）
 * @param {{
 *   x?:number, y?:number, r?:number,          // 物理模型里的位置与半径（必须传，见下）
 *   theta?:number, squash?:number, hold?:number, shakeX?:number,
 * }} geom
 *   ⚠️ `x`/`y`/`r` 是**物理模拟**维护的状态（每帧在变），纯函数算不出来，必须由调用方传入。
 *      它们恰恰是"隐身"那条链的载体（`b.r` 坏了 → 位置坏了 → 整帧抛），所以这里也逐字段兜。
 * @param {{
 *   measure?: (title:string, maxWidth:number, fontSize:number, maxLines:number) => {lines:string[], fontSize:number},
 * }} [env]
 *   `measure` = 文字排版（依赖 `ctx.measureText`，所以由调用方传进来）。
 *   不传也能用：退化成"按字号估宽度"的兜底排版，**永远给有限数**。
 * @returns {{
 *   values: object,   // 喂给 canvas 的全部数字
 *   problems: Array<{field:string, value:unknown}>,  // 哪些字段坏了、原值是什么
 *   levelKey: string, level: object, alpha: number, r: number,
 * }}
 */
export function drawNumbersOf(item, geom = {}, env = {}) {
  const it = item || {};
  const st = it.style || {};
  const g = geom || {};
  const problems = [];
  const bad = (field, value) => { problems.push({ field, value }); };
  const pick = (v, fallback, field, lo, hi) => {
    const out = finiteOr(v, fallback, field, lo, hi);
    if (out.bad) bad(field, v);
    return out.value;
  };

  // ---- 物理模型给的三件套（最危险：它们坏了就是"整块空白"的现场）----
  const x = pick(g.x, 0, 'x');
  const y = pick(g.y, 0, 'y');
  const r = pick(g.r, SAFE_RADIUS, 'r', 0.5, 4000);

  // ---- 等级：字符串 / 缺 rank 都在这里被修掉（见 safeLevelOf 的说明）----
  const rawLevel = st.level;
  const level = safeLevelOf(rawLevel);
  // level 不是对象（字符串/数字/…）→ 记 level；是对象但 rank 不是数（缺 rank / NaN）→ 记 level.rank
  if (rawLevel !== undefined && rawLevel !== null && typeof rawLevel !== 'object') {
    bad('level', rawLevel);
  } else if (rawLevel && !Number.isFinite(Number(rawLevel.rank))) {
    bad('level.rank（level 存在但没有数字 rank）', rawLevel.rank);
  }
  // `st.level` 缺 rank 时 glowScale 会变 NaN，这就是那一处最可疑的写法。
  // 注意：rank 顺带兼容数字字符串（'3' → 3），正常的数字 rank 逐位不变。
  const glowScale = 1.16 + Number(level.rank) / 40;

  const theta = pick(g.theta, 0, 'theta');
  const squash = pick(g.squash, 0, 'squash', -1, 1);
  const hold = pick(g.hold, 0, 'hold', 0, 1);
  const shakeX = pick(g.shakeX, 0, 'shakeX', -SHAKE_MAX, SHAKE_MAX);
  // ⚠️ 透明度：`style.alpha` 通常**不存在**（按 done/dimmed 算出来的），
  //    所以用"有值才检查"，否则每颗正常泡泡都会被记成坏字段。
  const alpha = pickIfGiven(st.alpha, alphaOfStyle(st), 'alpha', problems);

  // 形变：沿法线压扁、垂直方向拉长（面积近似守恒）
  const scaleAlong = Math.min(1.22, Math.max(0.78, 1 - squash));
  const scalePerp = Math.min(1.2, Math.max(0.8, 1 + squash * 0.8));

  // ---- 文字排版（依赖 measureText，由调用方传测量结果）----
  const titleSize = Math.max(10, Math.min(19, r * 0.30));
  const maxLines = r > 52 ? 3 : 2;
  const title = String((it.event && it.event.title) || '');
  let lines = [title];
  let fittedSize = titleSize;
  let measured = false;
  if (typeof env.measure === 'function') {
    try {
      const m = env.measure(title, r * 1.58, titleSize, maxLines);
      if (m && Array.isArray(m.lines) && m.lines.length && Number.isFinite(Number(m.fontSize)) && Number(m.fontSize) > 0) {
        lines = m.lines.filter((s) => typeof s === 'string');
        if (!lines.length) lines = [title];
        fittedSize = Number(m.fontSize);
        measured = true;
      } else {
        bad('measure（文字排版结果）', m);
      }
    } catch (err) {
      // measureText 自己在某些环境会抛（字体没就绪之类）→ 退化成不测宽
      bad('measureText', (err && err.message) || String(err));
    }
  }
  fittedSize = pick(fittedSize, titleSize, 'fittedSize', 1, 400);
  const lineH = fittedSize + 3;
  const blockH = lines.length * lineH;
  const showSub = r >= 34;
  const showLevel = r >= 56;
  const subSize = Math.max(10, Math.min(13, titleSize * 0.74));
  const gap = 3;
  const subBlock = showSub ? subSize : 0;
  const totalH = blockH + (showSub ? gap + subBlock : 0);
  const centerY = y + (showLevel ? r * 0.06 : 0);
  const textTop = centerY - totalH / 2;
  const textBottom = textTop + totalH;

  // 文字垫板：给亮色字垫一层"没有边"的圆形暗晕
  const plateR = Math.max(SAFE_PLATE_R, pick(Math.max(blockH * 0.95, (textBottom - textTop) * 0.8), SAFE_PLATE_R, 'plateR', 0.5, 800));
  const plateCY = pick((textTop + textBottom) / 2, centerY, 'plateCY', -SAFE_COORD, SAFE_COORD);
  const values = {
    x, y, r, alpha, theta, squash,
    // 形变后的两个缩放（绘制时不再就地算 —— 少一个 NaN 入口）
    scaleAlong,
    scalePerp,
    // 「自己过期」/「容器过期」两个标记（paintBubble 按它决定颜色和虚线环）
    overdue: !!st.overdue,
    ownOverdue: !!st.ownOverdue,
    inheritedOverdue: !!st.overdue && !st.ownOverdue,
    // 光从左上打进来，所有高光/明暗都按这个方向排布
    lx: x - r * 0.32,
    ly: y - r * 0.38,
    glowScale,
    // 渐变/描边的半径（全部由 r 派生，所以 r 坏了它们必然一起坏）
    bodyInnerR: r * 0.04,
    bodyOuterR: r * 1.03,
    rimInnerR: r * 0.74,
    rimOuterR: r * 1.0,
    outlineR: r * 0.955,
    outlineWidth: Math.max(1.1, r * 0.030),
    shadowArcR: r * 0.90,
    glintX: x - r * 0.523,
    glintY: y - r * 0.523,
    glintR: r * 0.34,
    sparkR: r * 0.07,
    centerGlowX: x - r * 0.10,
    centerGlowY: y - r * 0.12,
    centerGlowR: r * 0.9,
    innerX: x + r * 0.18,
    innerY: y + r * 0.30,
    innerInnerR: r * 0.30,
    innerOuterR: r * 1.08,
    innerRectX: x - r * 1.2,
    innerRectY: y - r * 1.2,
    innerRectW: r * 2.4,
    innerRectH: r * 2.4,
    strokeWidth: Math.max(0.8, r * 0.018),
    selectStrokeWidth: 2.5 + Math.abs(squash) * 8,
    // 长按进度环
    holdRingR: r * 1.22,
    holdProgress: hold,
    holdWidth: Math.max(2.5, r * 0.09),
    // 「容器过期」的暗紫虚线环
    inheritedRingR: r * 1.03,
    inheritedDashA: Math.max(3, r * 0.16),
    inheritedDashB: Math.max(3, r * 0.13),
    inheritedRingWidth: Math.max(2, r * 0.055),
    // 过期向内长的刺
    spikeInnerR: r * (1 - 0.16),
    spikeOuterR: r,
    spikeHalfW: Math.max(1.2, r * 0.055),
    // 文字
    titleSize,
    measuredFontSize: fittedSize,
    lineH,
    blockH,
    showSub,
    showLevel,
    subSize,
    gap,
    totalH,
    textTop,
    textBottom,
    centerY,
    plateR,
    plateCY,
    subY: textTop + blockH + gap + subSize / 2,
    tagPostSize: Math.max(9, titleSize * 0.62),
    tagY: y - r * 0.62,
    // 抖动后的绘制中心（气泡被撞/被长按时抖一下）
    drawX: x + shakeX,
    shakeX,
    // 描边/文字的线宽（跟着字号走）
    titleStrokeWidth: Math.max(2, titleSize * 0.24),
    subStrokeWidth: Math.max(2, subSize * 0.26),
    tagStrokeWidth: Math.max(2, titleSize * 0.2),
  };

  /**
   * ⚠️ 最后一道闸：上面每一处都兜过了，这里**再整体扫一遍**。
   *    理由很实在——"以前不会再有 NaN"是个不可信的假设（这个项目已经栽过两次），
   *    而漏掉一个字段的代价是"整块气泡区空白"。
   *    任何漏网的字段在这里变成一个明确的 problem，而不是一个 canvas 异常。
   */
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      bad(`values.${k}（漏网的非法值）`, v);
      values[k] = typeof values.r === 'number' ? values.r : SAFE_RADIUS;
    }
  }

  return {
    values,
    problems,
    level,
    levelKey: level.key,
    levelRank: Number(level.rank),
    alpha,
    r,
    lines,
    measured,
  };
}

/**
 * 把一个"喂给 canvas 的数字"收干净 —— **画之前最后一道闸**。
 *
 * 为什么还要单独一个函数（`drawNumbersOf` 里不是已经兜过了吗）：
 *   因为绘制路径上还有几个数字**不是** `drawNumbersOf` 产出的（`b.x/b.y/b.r/b.squash`
 *   这些物理状态、以及未来谁新加的一个就地算式）。把它们统一过这里，
 *   就等于"任何数字在被交给 canvas 之前都过同一个闸门"——
 *   而不是指望每一处新代码都记得兜底（这条纪律已经被违反过两次了）。
 *
 * @param {number} value
 * @param {number} fallback 安全值
 * @param {string} field 字段名（会写进 problems，报给用户看）
 * @param {Array} problems 收集"哪个字段坏了"
 * @param {number} [lo] @param {number} [hi]
 */
export function sanitizeDrawNumber(value, fallback, field, problems, lo, hi) {
  const out = finiteOr(value, fallback, field, lo, hi);
  if (out.bad && Array.isArray(problems)) problems.push({ field, value });
  return out.value;
}

/**
 * 把这颗泡泡的"现场证据"写成人话。
 *
 * ⚠️ 这条是**远程诊断的唯一手段**：用户在 iPad 上看不到 DevTools，
 *    界面自己不说清楚"哪颗泡泡的哪个字段坏了"，现场就没法定位。
 *    所以标题/id、坏掉的量、以及 style/event 里相关的几个值都必须带上。
 *
 * @param {object} item
 * @param {Array<{field:string,value:unknown}>} problems
 * @param {'repair'|'safe'} [mode]
 *   `repair`（默认）= 算数字时发现坏字段、已用兜底值继续画；
 *   `safe`          = 整颗绘制都挂了、已补画一颗安全的圆（这时通常没有具体字段）。
 * @returns {string} 例如
 *   `泡泡「周五交材料」的半径算成了 NaN（已用默认大小继续画）｜坏字段: r=NaN｜…`
 */
export function bubbleDrawDiagnostic(item, problems = [], mode = 'repair') {
  const it = item || {};
  const ev = it.event || {};
  const st = it.style || {};
  const who = ev.title
    ? `泡泡「${ev.title}」`
    : `泡泡（id=${ev.id != null ? ev.id : (it.key != null ? it.key : '(也没有 id)')}）`;
  const fields = [];
  for (const p of problems) {
    if (fields.length >= 6) { fields.push('…'); break; }
    fields.push(`${p.field}=${formatPart(p.value)}`);
  }
  // ⚠️ 措辞要说清"已经怎么补救了"，但**不要断言是哪种坏**（大小/颜色/图案都可能）：
  //    现场只有这一句话，说不准就会把人往错方向带。
  const what = mode === 'safe'
    ? '画不出来（已补画一颗安全的圆，其余泡泡不受影响）'
    : '的数字有问题（已用兜底值继续画）';
  const where = fields.length ? `坏字段: ${fields.join(' ')}` : '没有记录到具体字段';
  // ⚠️ 这几个字段就是历史上两次事故的现场证据，一个都不能省：
  //    radius         ← 第 48 轮"节日泡泡手写 style 漏了 radius"
  //    radiusRatio    ← 尺寸通道的唯一输入
  //    remaining      ← 倒计时（null = 未设期限，NaN = 脏时间）
  //    level/levelKey ← 颜色通道（level 是字符串/缺 rank 是本次那条链）
  //    tierKey/festival/deadline/done/ownOverdue ← 判断走的是哪条分支
  const styleBits = [
    `radius=${formatPart(st.radius)}`,
    `radiusRatio=${formatPart(st.radiusRatio)}`,
    `remaining=${formatPart(st.remaining)}`,
    `level=${formatPart(st.level)}`,
    `levelKey=${formatPart(st.levelKey)}`,
    `tierKey=${formatPart(st.tierKey)}`,
    `festival=${formatPart(st.festival)}`,
    `done=${formatPart(st.done)}`,
    `deadline=${formatPart(it.deadline)}`,
  ].join(' ');
  return `${who}${what}｜${where}｜style: ${styleBits}`;
}

/** 一个值 → 短、可读、绝不抛的字符串 */
function formatPart(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v);
  // ⚠️ Date 用**本地时刻**打印，不用 toISOString()：
  //    现场报回来的时间要能和用户看到的时间对上（东八区的 toISOString 会差 8 小时，
  //    半夜的日期甚至差一天 —— 那种"对不上"最费排查时间）。
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return 'Invalid Date';
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}`;
  }
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s && s.length > 40 ? `${s.slice(0, 40)}…` : String(s);
    } catch { return '[对象]'; }
  }
  const s = String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
