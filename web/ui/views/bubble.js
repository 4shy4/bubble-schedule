// 气泡浮动视图（主界面）
//
// 三个视觉通道，各管一件事：
//   大小   ← 事情多大（用户用工具栏的滑动条自己调，1–100）
//   颜色   ← 紧急度档位：天蓝=还早 / 翠绿=即将 / 黄=催促 / 红=紧急
//   通知强度 ← 同上，逐级加强（提前量更早、次数更多、弹窗更"硬"）
//
// 运动：缓慢四处飘浮（无向心引力、无固定中心），靠低频噪声驱动方向，
//       采用"转向"而不是"撞墙"来处理边界，避免气泡堆在边上。
// 碰撞：刚体弹开 + 弹性形变（沿碰撞法线挤扁、垂直方向拉长，然后弹回）。
//
// ---------------------------------------------------------------------------
// ⚠️⚠️ 绘制这条路径有一条**必须一直守住**的规矩（2026-09-27 的事故之后写死）：
//
//   **一颗泡泡画不出来，绝不许影响别的泡泡。**
//
//   事故现场（iPad 0.10.11）：错误条 `The provided value is non-finite`，
//   而且"整个气泡区看不见泡泡了、可还能点到"。原因是绘制循环里的一次抛出
//   会冒到 rAF 回调之外：那一帧**剩下的泡泡全都不画**，
//   连 `requestAnimationFrame(frame)` 都不再执行 —— **整个绘制循环死掉**。
//   命中判定走几何模型（位置/半径），所以"隐身"但"点得到"。
//
//   所以现在 `draw()` 的结构是固定的，改它之前先读这一段：
//     1. 每颗泡泡的**全部绘制**（算数字 + 画）包在 `try/catch` 里 —— 见 draw()
//     2. 数字**只在 core/bubble-draw-numbers.js 里算**（纯函数、逐字段兜底、可单测）；
//        这个文件里**不许**再出现就地算式（`r * 0.955` 这种）——
//        每多一处就地算式，就多一个"某个字段坏了就整帧空白"的入口
//     3. 抛了就要**报出是哪一颗、哪个字段**（平板没有控制台，界面是唯一的诊断手段），
//        然后补画一颗安全的圆（"看得见"永远比"少一颗"强），再继续画下一颗
//   `tools/bubble-finite.test.mjs` 是这条规矩的尺子（覆盖矩阵 + 假 canvas 当 WebKit）。
// ---------------------------------------------------------------------------
import { el, mount } from '../dom.js';
// 「哪些实例该浮出来」的规则本体在 core（**桌面泡泡共用同一份**，别在这里再写一遍）。
// `isRepeating` 也一起从那儿拿 —— 本文件原来自己定义了一份，属于同一个坑的种子。
import { selectBubbleItems, isRepeating, BUBBLE_VIEW_DEFAULTS } from '../../../core/bubble-select.js';
// 节日泡泡的背景图案（手绘矢量 / 用户自己的图）—— 形状清单在 core，这里只负责画
import { festivalArt } from '../../../core/festival-art.js';
// 节日名单（给"给哪个节日换背景图"的下拉用）和节日专用色（预览小图要用）
import { FESTIVALS, FESTIVAL_COLORS } from '../../../core/holidays.js';
// 「到期/过期」只有一个定义在 core/state-ops.js（方案 C：到期 = 结束时间）
import * as stateOps from '../../../core/state-ops.js';
import { asDate, hhmm } from '../../../core/time.js';
import {
  URGENCY_TIERS, tierByKey, tierFill, tierTextColor,
  radiusRangeForCanvas, areaScaleForCanvas, RADIUS_MIN_FLOOR,
  hexToRgba, luminance, mixColor, OVERDUE_COLOR, OVERDUE_EDGE,
} from '../../../core/palette.js';
import { bubbleStyle, levelOf } from '../../../core/urgency.js';
import {
  LEVELS, levelByKey, canNestInside, allowedChildLevels, isLeafLevel, rankOf,
} from '../../../core/level.js';
import { formatRemaining } from '../../../core/countdown.js';
// 每颗泡泡「喂给 canvas 的全部数字」—— 纯函数在 core，这里只负责测量文字 + 画。
// ⚠️ 抽出来的理由（用户报的 iPad 故障）：数字散在这一百多行里时，
//    **一个字段变 NaN 只能靠肉眼在平板上猜**；集中到 core 之后它能被 Node 单测逐字段钉死，
//    而且每个数都自带兜底 + 记账（哪个字段坏了）。
import {
  drawNumbersOf, bubbleDrawDiagnostic, alphaOfStyle, isFiniteNumber, SAFE_RADIUS, SAFE_FALLBACK_ALPHA,
} from '../../../core/bubble-draw-numbers.js';
import { emptyState } from '../viewkit.js';
import { wrapTextToFit, ellipsize } from '../textfit.js';
import * as store from '../../adapter/store.js';
import { toast } from '../toast.js';

void tierFill;

const MAX_BUBBLES = 90;
const HORIZON_KEY = 'timetable.bubble.horizon';
const SHOW_DONE_KEY = 'timetable.bubble.showDone';
/**
 * 气泡区要不要显示**课程**气泡。
 *
 * 用户的判断：课程是**周期性**的（一学期几十节、按周重复），
 * 而气泡区更像"临时事务的缓冲区" —— 让课程气泡在里面到处乱蹦没有意义。
 * 给个开关，默认**显示**（不改变现有行为，用户自己勾掉）。
 */
const SHOW_COURSE_KEY = 'timetable.bubble.showCourse';
// 节日气泡：还剩几天时浮出来（用户定的默认 4 天，可调；0 = 不显示）
const FESTIVAL_DAYS_KEY = 'timetable.bubble.festivalDays';

/** 长按多久算"戳破"（用户指定 2.5 秒） */
const LONG_PRESS_MS = 2500;
/** 长按进度条的最大半径（画在气泡外圈） */
const LONG_PRESS_RING = 1.22;

// ---------- 漂浮参数 ----------
const MAX_SPEED = 26;        // px/s，慢悠悠才像气泡
const WANDER = 15;           // 方向扰动强度
const DRAG = 0.55;           // 空气阻力（每秒保留比例）
const EDGE_TURN = 150;        // 靠近边缘时的转向力（偏大，让气泡主动离开边界）
// ---------- 碰撞参数 ----------
// 目标：真实、克制。真机上原参数太夸张（RESTITUTION 0.9 + SQUASH 0.55 看起来像橡皮球爆炸）。
const RESTITUTION = 0.62;    // 碰撞弹性（0.6 左右接近"有点弹的水球"）
const POSITION_CORRECTION = 1.0; // 每帧把重叠完全分开 —— 这是"不重叠"的关键
const SQUASH_PER_HIT = 0.16; // 单次撞击的形变量上限（原来 0.55，太夸张）
const SQUASH_MAX = 0.2;      // 形变绝对上限
const SQUASH_FREQ = 7.5;     // 形变回弹频率（越高越"紧实"）
const SQUASH_DAMPING = 0.22; // 阻尼（越小越快停下来，减少来回晃）
const RADIUS_EASE = 6;       // 半径变化速度（1/s）：剩余时间在走，半径要平滑长大

// ---------- 过期气泡：定点不动 + 暗紫 + 长刺 ----------
// ⚠️ 两个紫色从 core/palette.js 引入（**桌面泡泡也要画过期**，同一个语义别留两份颜色）
const OVERDUE_SPIKES = 13;            // 一圈多少根刺
// ⚠️ 刺长（相对半径）现在是 `drawNumbersOf` 里算的（`spikeInnerR = r * (1 - 0.16)`），
//    这个常量只作为那条算式的文档；绘制代码读的是已兜底的 `v.spikeInnerR`。
const OVERDUE_SPIKE_LEN = 0.16;
void OVERDUE_SPIKE_LEN;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const bubbleView = {
  id: 'bubble',
  label: '气泡',
  icon: '◍',

  title() { return '气泡面板'; },
  subtitle(state) {
    const items = selectItems(state);
    const counts = { sky: 0, emerald: 0, amber: 0, red: 0 };
    for (const i of items) counts[i.style.levelKey] += 1;
    const path = bubblePath(state);
    if (path.length) {
      return `第 ${path.length} 层 · ${items.length} 个气泡 · 红 ${counts.red} 黄 ${counts.amber}`;
    }
    return `${items.length} 个气泡 · 大事 ${counts.red + counts.amber} · 小事 ${counts.sky}`;
  },

  nav() {
    return [
      { label: '重排', action: 'reset', title: '重新散布气泡' },
      { label: paused ? '继续漂浮' : '暂停漂浮', action: 'toggle-run' },
    ];
  },

  onNav(action, ctx) {
    if (action === 'reset') { resetRequested = true; ctx.refresh(); }
    if (action === 'toggle-run') paused = !paused;
  },

  render(state, ctx, host) {
    // ⚠️ 先修剪套娃路径：sessionStorage 里可能存着一个**已经被删掉的容器 id**，
    //    不修就会出现"在幽灵容器里单击背景加子气泡 → 服务端报父气泡不存在"。
    //    放在最前面，后面所有逻辑看到的路径都是合法的。
    pruneBubblePath(state.events);

    const config = readConfig();
    const items = selectItems(state).slice(0, MAX_BUBBLES);
    const insideId = currentParentId();
    const insideParent = insideId ? state.events.find((e) => e.id === insideId) : null;

    // 空容器**不能**走"这个范围没日程"的空状态：
    // 用户要的是"双击空泡泡也能进去，然后点背景往里加子泡泡"。
    // 所以进了容器就一定要画出画布（背景 = 母气泡）。
    if (!items.length && !insideParent) {
      return void mount(host, emptyState({
        title: state.events.length ? '这个时间范围内没有日程' : '还没有日程',
        hint: state.events.length
          ? '点右上角 ⚙ 打开设置，把「时间范围」放宽一些。'
          : '新建一条日程，它就会变成一个气泡浮在这里。',
        actionLabel: '新建日程',
        onAction: () => ctx.newEventAt(new Date()),
      }));
    }

    const canvas = el('canvas.bubble-canvas', { 'aria-label': '日程气泡面板' });

    // 悬浮 HUD 上只留三样东西：退出一层、当前选中、以及"说明"开关。
    // 原来的 ＋（新建）和 ⚙（设置）都撤了（用户要求）：
    //   · 新建 → 改成**单击空白背景**（和子母泡泡的逻辑一致）
    //   · 设置 → 合进说明面板，点 ? 展开
    // 空文字时这一格会整格收起来（见 setHudChip 的说明）
    const pickChip = el('span.bubble-hud-chip.muted', { hidden: true });
    // 最外层 `hudHint()` 是空串 → 保持隐藏；进了容器就有话要说 → 显示
    setHudChip(pickChip, hudHint(state));
    const tally = el('span.bubble-hud-chip.muted');
    /**
     * 「点到了」的即时反馈（一圈扩散的涟漪）。
     *
     * 为什么要有它（不是装饰）：
     *   单击背景要等一个**双击窗口**（340ms）才能决定是"加子泡泡"还是"出去"，
     *   所以按下到有反应之间天然有一段静默期。用户按完没看到任何变化，
     *   会以为"这个 App 没反应"，然后再点一次 —— 恰好被当成双击，于是**退出一层**，
     *   更加确信"点了乱跳"。涟漪把这段静默期填上：**按下去就有东西动**。
     *
     * 它顺带还是个诊断器：如果按背景连通涟漪都不出现，那就是手势根本没进到画布，
     * 不用再猜业务逻辑（iPad 上排查"单击背景无响应"就靠这个分叉）。
     */
    const tapRipple = el('div.bubble-tap-ripple');
    const backBtn = el('button.icon-btn.bubble-hud-btn', {
      type: 'button', title: '退出一层（也可以双击背景）', 'aria-label': '退出一层', text: '↩',
    });
    const helpBtn = el('button.icon-btn.bubble-hud-btn', {
      type: 'button', title: '说明与设置', 'aria-label': '说明与设置', text: '?',
    });
    // 进了容器但里面还是空的：背景就是母气泡，明确告诉用户点它可以加东西。
    // 空画布什么都不画的话，用户会以为"进错了"或者卡住了。
    const insideHint = el('div.bubble-inside-hint', {
      hidden: !insideParent || items.length > 0,
    }, [
      el('strong', { text: insideParent ? insideParent.title : '' }),
      el('span', { text: '里面还是空的' }),
      el('span.bubble-inside-hint-key', { text: '单击背景 = 加一个子气泡　·　双击背景 = 出去' }),
    ]);
    /**
     * 投放区 = 一块**覆盖在左侧栏位置上的新区**（用户要求：只是位置共用，
     * 不是把侧栏换个色）。
     *
     * 外观：虚线边框 + 里面写明"这一区是干什么的" + 底色 = **目的地那一层**的颜色。
     *   · 蓝泡泡在绿泡泡里、绿在红里 → 蓝拖出去会和绿平级 = 进到"红的内部" → 底色红
     *   · 绿泡泡拖动 → 出去就是最外层（白底）→ 底色白
     * 所以颜色取"当前容器的父级"：有祖父用祖父色，没有就是最外层底色。
     *
     * 拖动时才出现，盖住左侧栏（侧栏此时会强制展开，见 CSS 的 .is-dropzone）。
     */
    const escapeColor = escapeColorFor(currentParentId(), state.events);
    const targetParent = (() => {
      const pid = currentParentId();
      if (!pid) return null;
      const p = state.events.find((e) => e.id === pid);
      return p && p.parentId ? state.events.find((e) => e.id === p.parentId) : null;
    })();
    const dropTitle = targetParent ? '拖到这里' : '拖到这里（最外层）';
    const dropDesc = targetParent
      ? `和母气泡平级 → 放进「${targetParent.title}」`
      : (() => {
        const pid = currentParentId();
        const p = pid ? state.events.find((e) => e.id === pid) : null;
        return p ? `脱离「${p.title}」，回到最外层` : '';
      })();
    const dropzoneEl = el('div.bubble-dropzone', { hidden: true }, [
      el('div.bdz-head', { text: dropTitle }),
      el('div.bdz-desc', { text: dropDesc }),
      el('div.bdz-color', {}, [
        el('i', { style: { background: escapeColor || 'var(--surface)' } }),
        el('span', {
          text: targetParent
            ? `这一层的颜色：${levelByKey(levelOf(targetParent)).colorName}`
            : '这一层的底色：最外层',
        }),
      ]),
    ]);

    const sidebarEl = document.getElementById('sidebar');
    const setDropMode = (on) => {
      const app = document.getElementById('app');
      if (!app || !sidebarEl) return;
      app.classList.toggle('is-dropping', on);
      sidebarEl.classList.toggle('is-dropzone', on);
      dropzoneEl.hidden = !on;
      if (on && escapeColor && typeof dropzoneEl.style.setProperty === 'function') {
        dropzoneEl.style.setProperty('--drop-color', escapeColor);
      }
    };

    const hud = el('div.bubble-hud', {}, [
      ...(bubblePathIds.length ? [backBtn] : []),
      pickChip,
      el('span', { style: { flex: '1' } }),
      tally,
      helpBtn,
    ]);

    // 说明面板：点 ? 才出现（默认隐藏，不占版面）
    const panel = el('div.bubble-panel.bubble-help', { hidden: true });
    const stage = el('div.bubble-stage', {}, [canvas, tapRipple, insideHint, hud, panel, dropzoneEl]);
    const legend = el('div.bubble-legend');

    // 进入气泡后：容器变成这层画布的背景色（视觉上"我们在这个气泡里面"）
    applyStageBackground(stage, state);

    // ⚠️ tapRipple 必须放进 `local` 传给 startSimulation —— 手势处理器（onDown/onUp）
    //    住在 startSimulation 里，**不在 render 的作用域内**。
    //    第一版直接引用这个 const，于是 pointerdown 一进 showTapRipple 就
    //    `ReferenceError: tapRipple is not defined`：涟漪不出现（这一层看得出来），
    //    但下面的 `local.setSelected(null)` 也被跳过，整条背景点击路径**没有报错、
    //    看着还"能工作"**（气泡照样加得出来）—— 正是那种最难发现的半坏。
    const local = { selected: null, panel, legend, config, pickChip, setDropMode, dropzoneEl, tapRipple };
    // ⚠️⚠️ `state` 必须传进去 —— 这是用户报的"**单击母气泡背景加不了子泡泡**"的真根因。
    //
    //    `renderPanel` 的函数体里有两处自由变量 `state`（`hudHint(state)` /
    //    `isOverdueContainer(state)`），而它的形参里**没有 state**。
    //    JS 不会在定义时报错，只在**调用那一刻**抛 `ReferenceError: state is not defined`：
    //      · `setSelected(null)` 在 pointerdown 里抛 → 被浏览器吞掉（控制台有，界面上没有）
    //      · `local.isOverdueContainer()` 在**340ms 的 setTimeout 回调里**抛 →
    //        连控制台都不一定看得到，而它后面那句 `ctx.addChild()` **永远不会执行**。
    //    表现就是"单击背景一点反应都没有"：没有编辑框、没有报错、没有 toast。
    //    **只有"在容器里"这一支会走到它** —— 最外层走的是 `ctx.newEventAt()`，
    //    所以"单击空白新建日程"一直是好的，这也正是它长期没被发现的原因
    //    （所有旧测试都只在最外层点过背景）。
    renderPanel(panel, legend, config, ctx, local, state);

    helpBtn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      helpBtn.setAttribute('aria-pressed', String(!panel.hidden));
    });
    // 退出一层：回到上一层容器（最外层时按钮不显示）
    backBtn.addEventListener('click', () => exitOneLevel(ctx));

    // 统计条：各档多少（一眼看出里面有几件大事）
    const counts = { sky: 0, emerald: 0, amber: 0, red: 0 };
    for (const it of items) counts[it.style.levelKey] += 1;
    tally.textContent = bubblePathIds.length
      ? `第 ${bubblePathIds.length} 层 · 共 ${items.length}`
      : `共 ${items.length} · 红 ${counts.red} 黄 ${counts.amber}`;

    mount(host, el('div.bubble-wrap', {}, [stage]));

    stopActiveSimulation();
    const stop = startSimulation({
      canvas, items, config, ctx, local, pickChip,
      events: state.events,
      // 用户给某个节日换的图（方案 C）；没换的走矢量图案（方案 A）
      customArt: (state.settings && state.settings.festivalArt) || {},
    });
    activeStop = stop;

    const cleanup = new MutationObserver(() => {
      if (!document.body.contains(canvas)) {
        stop();
        if (activeStop === stop) activeStop = null;
        cleanup.disconnect();
      }
    });
    cleanup.observe(host, { childList: true });
  },
};

// ---------- 状态 ----------
let resetRequested = false;
let paused = false;
let activeStop = null;

/** 套娃路径：[] = 最外层；[idA]、[idA,idB] = 进到了第几层容器里 */
const PATH_KEY = 'timetable.bubble.path';
let bubblePathIds = (() => {
  try { return JSON.parse(sessionStorage.getItem(PATH_KEY) || '[]') || []; } catch { return []; }
})();

/**
 * 用当前真实事件校验路径，砍掉已经不存在的部分。
 *
 * ⚠️ 这个校验是必须的，否则会出一个很隐蔽的 bug：
 *   `bubblePathIds` 存在 sessionStorage 里用来跨刷新保持，但**恢复时没有任何校验**。
 *   一旦那个容器被删掉（清空数据 / 导入替换 / 戳破 / 在别处删除），路径里就留着一个
 *   幽灵 id。于是：
 *     · 气泡视图仍以为"你在容器里"（背景显示成容器内部）
 *     · 单击背景 → addChild(幽灵 id) → 保存 → 服务端报「父气泡不存在」
 *   用户看到的就是"我一添加就报父气泡不存在"，而且怎么试都这样（因为路径一直留着）。
 *
 * 从第一个失效的 id 起整段砍掉 —— 父不存在时，孙辈不可能还合法。
 * @returns {boolean} 是否发生了修剪
 */
function pruneBubblePath(events) {
  if (!bubblePathIds.length) return false;
  // ⚠️ **没有校验依据时不要做破坏性修剪。**
  //    这一条是跑真触摸测试时发现的：App 起来会先用**本机缓存**渲染一次
  //    （store.init 里先 cache 后 network，而 subscribe 早就挂上了）。
  //    如果缓存里恰好还没有那个容器（比如刚在别处建的、或缓存是旧的），
  //    这里就会把用户的"我在第几层"**当成幽灵路径砍掉** —— 等他双击进去、
  //    刷新一次，人就莫名其妙回到了最外层。
  //    空列表时什么都不砍：真要是有幽灵 id，后面还有两道防线
  //    （渲染时 `insideParent` 找不到 → 画空状态；服务端会丢弃失效的 parentId）。
  if (!Array.isArray(events) || !events.length) return false;
  const ids = new Set(events.map((e) => e.id));
  const keep = [];
  for (const id of bubblePathIds) {
    if (!ids.has(id)) break;
    keep.push(id);
  }
  if (keep.length === bubblePathIds.length) return false;
  setBubblePath(keep);
  return true;
}

function bubblePath() { return bubblePathIds; }

function setBubblePath(ids) {
  bubblePathIds = Array.isArray(ids) ? ids : [];
  try { sessionStorage.setItem(PATH_KEY, JSON.stringify(bubblePathIds)); } catch { /* ignore */ }
}

/** 当前容器（null = 最外层） */
function currentParentId() {
  return bubblePathIds.length ? bubblePathIds[bubblePathIds.length - 1] : null;
}

/**
 * 双击进入气泡：把这层容器设成画布背景，只显示里面的气泡。
 * 用户要的动画是"气泡迅速扩大填满 + 内容虚化消失"，
 * 这里用 CSS 过渡做：先把背景色铺上（`.bubble-enter` 触发缩放淡入），再重绘。
 */
function enterBubble(id, ctx) {
  setBubblePath([...bubblePathIds, id]);
  ctx?.refresh?.();
}

function exitOneLevel(ctx) {
  if (!bubblePathIds.length) return;
  setBubblePath(bubblePathIds.slice(0, -1));
  ctx?.refresh?.();
}

/** 画布背景：进入容器后铺一层容器颜色的柔光，表示"我们在它里面" */
function applyStageBackground(stage, state) {
  const id = currentParentId();
  if (!id) return;
  const parent = state.events.find((e) => e.id === id);
  if (!parent) { setBubblePath([]); return; }
  // 同样要用 levelOf() 解析（旧数据只有 magnitude）
  const level = levelByKey(levelOf(parent));
  const overdue = isOverdueEvent(parent, state.events);
  stage.classList.add('bubble-inside');
  stage.classList.toggle('bubble-inside-overdue', overdue);
  stage.style.setProperty('--bubble-inside-color', overdue ? OVERDUE_COLOR : level.color);
  stage.dataset.container = parent.title;
}

/** 「到期/过期」判定：**转调共用实现**，不再自己写一份。
 *  原来这里有第二份 `remainingOf`（按 end）而 `bubbleStyle` 用第三份（按 start），
 *  于是同一条规则出现两个答案。现在只有 core/state-ops.js 那一份。 */
const isOverdueEvent = stateOps.isOverdueEvent;

/** 点是否落在一个矩形范围内（用于"拖到某块面板上松手"的判定） */
function hitRect(r, p) {
  if (!r || !p) return false;
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/**
 * "拖出去会落到哪一层" —— 也就是投放区该用什么底色。
 *
 * 用户定的规则（我第一版理解错了，这里写清楚）：
 *   投放区的颜色 = **目的地那一层的颜色**，不是当前母气泡的颜色。
 *
 *   例：红 → 绿 → 蓝 三层套娃
 *     · 在绿里拖蓝：蓝出去会和绿平级 = 进到"红的内部" → **红**
 *     · 在红里拖绿：绿出去就是最外层（背景是白的）      → **白**
 *   所以取"当前容器的父级"：有祖父就用祖父的颜色；没有祖父说明目的地是最外层，用底色。
 *
 * @param {string|null} parentId 当前容器
 * @param {Array} events 全部事件
 * @returns {string|null} 颜色（CSS 值）；不在容器里时返回 null
 */
export function escapeColorFor(parentId, events) {
  if (!parentId) return null;
  const parent = (events || []).find((e) => e.id === parentId);
  const grand = parent && parent.parentId
    ? (events || []).find((e) => e.id === parent.parentId)
    : null;
  return grand ? levelByKey(levelOf(grand)).color : 'var(--surface)';
}

/**
 * 当前这一层的"母气泡"几何 —— 进了容器才有。
 *
 * 用它判断"气泡被拖到容器外面了"。注意**不再画虚线圈**（用户觉得不好看）：
 * 离开容器的主入口是"拖到左侧栏"（左侧栏在拖动时本身就是投放区），
 * 这里只作为几何兜底。
 */
function parentBubbleGeom(width, height) {
  // 半径取短边的 42%：留出四周一圈"外面"，且整圆不越界
  const r = Math.min(width, height) * 0.42;
  return { cx: width / 2, cy: height / 2 + 6, r };
}

/** 拖出去要越过边界这么多（1 倍半径的 5%）才算，避免贴边误判 */
const OUT_MARGIN = 1.05;

function stopActiveSimulation() {
  if (typeof activeStop === 'function') {
    try { activeStop(); } catch { /* ignore */ }
  }
  activeStop = null;
}

/**
 * HUD 上的操作提示。
 *
 * 最外层**不再放常驻说明**（用户要求：说明收进 ? 面板）—— 取消了 ＋ 和 ⚙ 之后
 * 左上角空着最干净。只有在容器里才提示一句，因为那里的背景点击语义变了，
 * 不提示的话用户不知道背景可以点。
 *
 * 紫色（过期）容器**只读**：提示也要跟着改，否则界面在教用户做一件会被拒的事。
 *
 * [state] 由调用方传入 —— `state` 是渲染函数的局部变量，模块级拿不到它。
 * （我第一版在这里引用了 `lastState`，那个变量**根本不存在**。）
 */
function hudHint(state) {
  if (!currentParentId()) return '';
  if (isOverdueContainer(state)) {
    // 过期容器不能加子气泡 —— 提示里就别提它
    return '这个紫泡泡过期了，只能看看 · 拖动气泡到别的气泡上可放进去 · 拖到左侧栏就是拉出来 · 双击背景出去';
  }
  // 注意别再写"拖出虚线圈" —— 那个圈已经删掉了（用户觉得不好看），
  // 现在拉出来的方式是拖到左侧栏松手。
  return '单击背景加子气泡 · 拖动气泡到别的气泡上可放进去 · 拖到左侧栏就是拉出来 · 双击背景出去';
}

/**
 * 当前这一层的容器是不是紫色（过期）。
 *
 * 判据必须和渲染紫色用的是同一个 `isOverdueEvent` —— 否则会出现
 * "看着是紫的、逻辑却认为没过期"这类两条路径不一致的老问题
 * （这个项目已经在 `levelOf` 上栽过一次）。
 */
function isOverdueContainer(state) {
  const id = currentParentId();
  if (!id || !state) return false;
  const parent = state.events.find((e) => e.id === id);
  return parent ? isOverdueEvent(parent, state.events) : false;
}

function readConfig() {
  return {
    horizonDays: Number(localStorage.getItem(HORIZON_KEY) || BUBBLE_VIEW_DEFAULTS.horizonDays),
    showDone: localStorage.getItem(SHOW_DONE_KEY) === '1',
    // 没设过就是显示（保持老行为）
    showCourse: localStorage.getItem(SHOW_COURSE_KEY) !== '0',
    festivalDays: (() => {
      const raw = localStorage.getItem(FESTIVAL_DAYS_KEY);
      if (raw === null) return BUBBLE_VIEW_DEFAULTS.festivalDays;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.min(60, Math.floor(n)) : BUBBLE_VIEW_DEFAULTS.festivalDays;
    })(),
  };
}

/**
 * 「电脑桌面气泡区」那一块设置（用户要的软件入口）。
 *
 * ⚠️ 这一层是**本机的一个 Windows 程序**（不是网页的一部分），所以：
 *   · 状态要从服务端问（`/api/desktop-layer`）—— 只有 PC 版有，别的端 404；
 *   · 开/关也是让**服务端**去启动/结束那个进程（浏览器做不到这件事）。
 *
 * ⚠️ `desktopLayerState` 的三态要分清楚：
 *   `undefined` = 还没问过（先别画，问完再 rerender）
 *   `null`      = 这一端没有这个功能（平板上就是这种）→ 整块不出现
 *   对象        = 有，照它画
 */
let desktopLayerState;
let desktopLayerAsked = false;

function desktopLayerBlock(rerender) {
  // ⚠️ 公开 demo（public/bubble-demo）用的是一份**内存版 store**，
  //    上面根本没有这两个函数 —— 不先看一眼的话，这里一个 TypeError
  //    就会把整个气泡区的渲染打断（表现是白屏）。有的话才去问。
  if (typeof store.desktopLayerStatus !== 'function') { desktopLayerState = null; return []; }
  if (!desktopLayerAsked) {
    desktopLayerAsked = true;
    Promise.resolve(store.desktopLayerStatus())
      .then((st) => { desktopLayerState = st || null; if (st) rerender(); })
      .catch(() => { desktopLayerState = null; });
  }
  const st = desktopLayerState;
  if (!st) return [];

  const act = (action, on, okText) => {
    if (typeof store.desktopLayerAct !== 'function') return;
    Promise.resolve(store.desktopLayerAct(action, on))
      .then((r) => {
        if (r && r.status) desktopLayerState = r.status;
        if (r && r.ok === false) toast({ title: '没做成', body: r.error || '未知原因', kind: 'err', timeout: 4000 });
        else if (okText) toast({ title: okText, timeout: 1500 });
        rerender();
      })
      .catch((err) => toast({ title: '没做成', body: err.message, kind: 'err', timeout: 4000 }));
  };

  return [
    el('div.bubble-help-title', { text: '电脑桌面气泡区' }),
    el('div.bubble-panel-row', {}, [
      el('span.bubble-tool-label', { text: st.running ? '正在桌面上显示' : '没开' }),
      el('button.btn.btn-sm', {
        text: st.running ? '关掉它' : '显示到桌面',
        title: st.built ? '在桌面上画出气泡区（一个本机小窗口）' : '第一次会自动编译，可能要几秒',
        onclick: () => act(st.running ? 'stop' : 'start', undefined, st.running ? '已关掉' : '已经放到桌面上'),
      }),
      st.running ? el('span.bubble-tool-label', { text: '（在系统托盘图标上右键也有同样的菜单）' }) : null,
    ].filter(Boolean)),
    el('label.switch-row.bubble-course-toggle', {}, [
      el('span', { text: '浮在所有窗口之上' }),
      el('input', {
        type: 'checkbox',
        checked: st.topmost,
        onchange: (e) => act('topmost', e.target.checked, e.target.checked ? '已置顶' : '改成只在桌面显示'),
      }),
    ]),
    el('label.switch-row.bubble-course-toggle', {}, [
      // ⚠️ 代价直接写在标签里：打开之后**整屏都吃点击**（除任务栏），桌面就点不动了。
      el('span', { text: '空白处也吃点击（桌面暂时点不动，任务是：托盘还能点）' }),
      el('input', {
        type: 'checkbox',
        checked: st.captureBackground,
        onchange: (e) => act('capture', e.target.checked, e.target.checked ? '已打开：现在在桌面空地上单击就能新建' : '已关掉：桌面又能点了'),
      }),
    ]),
    st.captureBackground
      ? el('div.bubble-panel-row', {}, [
        el('span.bubble-tool-label', {
          text: '⚠️ 开着"空白处也吃点击"时桌面点不动（任务栏除外）—— 想改回来就在桌面那个小窗口的托盘图标上右键',
        }),
      ])
      : null,
    el('label.switch-row.bubble-course-toggle', {}, [
      el('span', { text: '开机自动显示' }),
      el('input', {
        type: 'checkbox',
        checked: st.autostart,
        onchange: (e) => act('autostart', e.target.checked, e.target.checked ? '已设为开机自启' : '已取消开机自启'),
      }),
    ]),
  ].filter(Boolean);
}

/**
 * 把"气泡区显示设置"同步给服务端 —— **Windows 桌面气泡层读的就是这一份**。
 *
 * 用户第 41 轮的原话是"桌面气泡的显示与软件气泡区设置保持一致"。
 * 网页这边的真值在 localStorage（每台设备自己记），原生那侧**读不到浏览器的 localStorage**，
 * 所以每次渲染时把这三个数推给服务端（`settings.bubbleView`），桌面那侧读服务端。
 *
 * ⚠️ 已经在服务端存着的值**不要重复写**：这段代码在每次渲染时都会跑，
 *    不加这个判断就会变成"每渲染一次写一次盘"（还带一次 setState → 再渲染一轮）。
 * ⚠️ 写失败**不要抛**：这只是"把显示偏好同步过去"，失败了桌面那侧退回默认值，
 *    不该让气泡区因为一个偏好同步而报错（离线模式下它本来就会进 outbox）。
 */
function syncBubbleView(config, state) {
  const cur = (state && state.settings && state.settings.bubbleView) || {};
  const curView = {
    horizonDays: Number(cur.horizonDays) || BUBBLE_VIEW_DEFAULTS.horizonDays,
    showCourse: cur.showCourse !== false,
    showDone: cur.showDone === true,
  };
  if (curView.horizonDays === Number(config.horizonDays)
    && curView.showCourse === config.showCourse
    && curView.showDone === config.showDone) return;
  try {
    Promise.resolve(store.saveSettings({
      bubbleView: {
        horizonDays: Number(config.horizonDays),
        showCourse: !!config.showCourse,
        showDone: !!config.showDone,
      festivalDays: Number(config.festivalDays) || 0,
      },
    })).catch(() => { /* 同步失败不影响气泡区 */ });
  } catch { /* 同上 */ }
}

/**
 * ⚠️ 原来这里有一份本文件自己的 `occurrenceKeyOf` 和 `isRepeating`，现在都搬走了：
 *   · "已经被戳破的那一颗要不要跳过"随选择规则一起进了 `core/bubble-select.js`
 *     （它用 core/state-ops.js 的 `occurrenceKey` —— 那边才是服务端同一份）
 *   · `isRepeating` 从 core 引入（同一个判断留两份，迟早会出现
 *     "网页上标了周几、桌面上没标"这种没人会想到去查的差异）
 */

/**
 * 这个事件的实例会不会**有多颗同时存在**（也就是"重复"到需要区分是哪一天）。
 *
 * 一周勾了 7 天 → 是；只勾周一 → 一周只有一颗，标"周一"是噪音。
 * 但"每天跑步"只勾一天也是每周一次，仍然可能同时看到多周的实例 —— 所以
 * 只要整体是重复的，就标周几（简单、可预测，不会因为勾选数量变化而忽隐忽现）。
 */
function showsWeekday(item) {
  return isRepeating(item.event);
}

function selectItems(state) {
  const config = readConfig();
  // 把这份显示设置推给服务端，桌面气泡层读的就是它（用户要的"两端一致"）
  syncBubbleView(config, state);
  // ⚠️ 规则本体已经搬到 core/bubble-select.js —— **桌面泡泡和这里共用同一份**。
  //    这里只负责把"界面上的选择"喂进去（当前在第几层容器、时间范围、显不显示课程）。
  //    如果哪天要改"哪些泡泡该浮出来"，改 core 那一份，两处一起变。
  return selectBubbleItems(state.events, {
    termStart: state.settings.termStart,
    parentId: currentParentId(),
    horizonDays: config.horizonDays,
    showCourse: config.showCourse,
    showDone: config.showDone,
    // 节日气泡（只在最外层、只报重要的、只报快到的）
    festivalDays: config.festivalDays,
  });
}

// ---------- 说明面板（含少量设置）----------
// 面板默认隐藏（气泡区全屏展示），点 HUD 上的 ? 才出现。
// 内容是"解释这个界面"：颜色、大小、操作、套娃规则。
// ---------- 节日背景图（方案 C：用户自己换） ----------
//
// 默认每颗节日泡泡都有一张**手绘矢量图案**（方案 A，见 core/festival-art.js）；
// 这个块让用户可以把某个节日的图案换成**自己的一张图**。
//
// 三个决定，都是被"离线 + 平板 + 别把备份撑爆"逼出来的：
//   1. 图**存在设置里**（data URL），不是存成文件路径 ——
//      平板/安卓没有"文件路径"这回事，存路径的话换端就全裂了；存设置里还能跟着备份走。
//   2. 上传前**先压到 256×256 的 JPEG**。不压的话一张手机照片 3–8 MB，
//      塞进 db.json 会让每次同步都传好几兆，备份也变得巨大。
//   3. 只认 `data:image/`（本机压好的），不许用外链 —— 外链在离线/平板上就是白框。
const CUSTOM_ART_PX = 256;   // 跟 core 里的 CUSTOM_ART_MAX 对齐
let artPicked = '';          // 下拉里正在编辑的节日（面板重画时保住选择）

/** 把用户选的图片压成 CUSTOM_ART_PX 的方图（cover 裁切）。 */
function shrinkImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读不出这个文件'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('这不是一张能解码的图片'));
      img.onload = () => {
        const side = CUSTOM_ART_PX;
        const cv = document.createElement('canvas');
        cv.width = side;
        cv.height = side;
        const c2 = cv.getContext('2d');
        // 先铺白底：PNG 的透明区压成 JPEG 会变黑，黑块贴在红泡泡上很难看
        c2.fillStyle = '#ffffff';
        c2.fillRect(0, 0, side, side);
        const ratio = Math.max(side / img.naturalWidth, side / img.naturalHeight);
        const w = img.naturalWidth * ratio;
        const h = img.naturalHeight * ratio;
        c2.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function festivalArtBlock(state, rerender) {
  const saved = (state.settings && state.settings.festivalArt) || {};
  const choices = [];
  for (const f of FESTIVALS) if (!choices.some((k) => k.key === f.key)) choices.push({ key: f.key, name: f.name });
  if (!choices.length) return el('div.spacer');
  if (!artPicked || !choices.some((k) => k.key === artPicked)) artPicked = choices[0].key;

  const status = el('span.bubble-art-status', {});
  const nowLabel = el('span.bubble-tool-label', {});

  // 设置里直接给一张**小预览图**：不然"选完了长什么样"只能回到气泡区去猜，
  // 而节日泡泡要等到"还剩 N 天"才浮出来 —— 想看一眼得等好几个月，等于没法验收。
  const PV = 44;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const preview = el('canvas.bubble-art-preview', {
    width: String(Math.round(PV * dpr)),
    height: String(Math.round(PV * dpr)),
    style: { width: `${PV}px`, height: `${PV}px` },
    title: '当前图案的预览',
  });
  const drawPreview = () => {
    const c2 = preview.getContext('2d');
    if (!c2) return;
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.clearRect(0, 0, PV, PV);
    const R = PV / 2 - 1;
    const cx = PV / 2;
    const cy = PV / 2;
    const body = c2.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.05, cx, cy, R * 1.02);
    body.addColorStop(0, FESTIVAL_COLORS.fillLight);
    body.addColorStop(0.55, FESTIVAL_COLORS.fill);
    body.addColorStop(1, FESTIVAL_COLORS.fillDark);
    c2.beginPath();
    c2.arc(cx, cy, R, 0, Math.PI * 2);
    c2.fillStyle = body;
    c2.fill();
    drawFestivalArt(c2, { x: cx, y: cy }, R, artPicked, saved, 1);
    c2.beginPath();
    c2.arc(cx, cy, R - 1, 0, Math.PI * 2);
    c2.lineWidth = 1.5;
    c2.strokeStyle = FESTIVAL_COLORS.ring;
    c2.globalAlpha = 0.85;
    c2.stroke();
    c2.globalAlpha = 1;
  };

  const refresh = () => {
    const a = festivalArt(artPicked, { customArt: saved });
    nowLabel.textContent = a.custom ? '当前：你自己选的图片' : `当前：矢量图案「${a.label}」`;
    status.textContent = saved[artPicked] ? '已换图' : '';
    drawPreview();
  };
  refresh();

  const picker = el('input', {
    type: 'file',
    accept: 'image/*',
    style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';                                  // 允许连着选同一个文件
      if (!file) return;
      try {
        const dataUrl = await shrinkImageFile(file);
        await store.saveSettings({ festivalArt: { ...saved, [artPicked]: dataUrl } });
        rerender();
      } catch (err) {
        status.textContent = (err && err.message) ? `${err.message}，换一张试试` : '这张图用不了，换一张试试';
      }
    },
  });

  return el('div.bubble-panel-row.bubble-art-row', {}, [
    el('span.bubble-tool-label', { text: '节日背景图' }),
    preview,
    el('select.bubble-art-select', {
      'aria-label': '要换背景图的节日',
      onchange: (e) => { artPicked = e.target.value; refresh(); },
    }, choices.map((k) => el('option', {
      value: k.key,
      selected: k.key === artPicked,
      text: saved[k.key] ? `${k.name} · 已换图` : k.name,
    }))),
    nowLabel,
    el('button.btn.btn-sm', { text: '选一张图', onclick: () => picker.click() }),
    el('button.btn.btn-sm', {
      text: '恢复矢量图案',
      onclick: async () => {
        if (!saved[artPicked]) { status.textContent = '本来就是矢量图案'; return; }
        const next = { ...saved };
        delete next[artPicked];
        await store.saveSettings({ festivalArt: next });
        rerender();
      },
    }),
    picker,
    status,
  ]);
}

function renderPanel(host, legendHost, config, ctx, local, state) {
  const seg = (options, current, onPick) => el('div.seg', {}, options.map((o) =>
    el('button', {
      type: 'button',
      'aria-pressed': String(o.value === current),
      text: o.label,
      title: o.title || '',
      onclick: () => onPick(o.value),
    })));

  const rerender = () => ctx.refresh();

  // 选中气泡的信息 + 颜色（事情多大）
  const pickLabel = el('span.bubble-pick-label', { text: '未选中气泡' });
  const infoLabel = el('span.bubble-size-value', { text: '—' });
  const levelRow = el('div.bubble-level-row', {});

  const applyLevel = async (key) => {
    const sel = local.selected;
    if (!sel) { toast({ title: '先点一个气泡', timeout: 1600 }); return; }
    // 容器约束：里面已经有气泡时，不能把容器改得比它们还小
    const kids = store.childrenOf(sel.item.event.id);
    const tooSmall = kids.find((k) => !canNestInside(key, levelOf(k)));
    if (tooSmall) {
      toast({ title: '装不下里面的气泡', body: `「${tooSmall.title}」比这个颜色大`, kind: 'err' });
      return;
    }
    try {
      await store.saveEvent({ ...sel.item.event, level: key });
    } catch (err) {
      toast({ title: '改颜色失败', body: err.message, kind: 'err' });
    }
  };

  const renderLevels = () => {
    const current = local.selected ? levelOf(local.selected.item.event) : null;
    mount(levelRow, LEVELS.map((l) => el('button.chip.level-chip', {
      type: 'button',
      'aria-pressed': String(l.key === current),
      title: `${l.colorName} = ${l.label}`,
      onclick: () => applyLevel(l.key),
    }, [
      el('i', { style: { background: l.color } }),
      el('span', { text: l.label }),
    ])));
  };

  const setSelected = (sel) => {
    local.selected = sel;
    if (!sel) {
      pickLabel.textContent = '未选中气泡';
      infoLabel.textContent = '—';
    } else {
      pickLabel.textContent = sel.item.event.title;
      infoLabel.textContent = sel.item.style.countdownText || '—';
    }
    renderLevels();
    // 选中就显示"哪一颗 · 还剩多久"，取消选中就回到这一层的操作提示；
    // 两者都是空的时候整格收起来（别留一个空胶囊）
    setHudChip(
      local.pickChip,
      sel ? `${sel.item.event.title} · ${sel.item.style.countdownText}` : hudHint(state),
      !sel,
    );
  };

  mount(host, [
    el('div.bubble-help-head', {}, [
      el('strong', { text: '这个面板怎么看' }),
      el('span.tiny', { text: '气泡的两种含义 + 全部操作' }),
    ]),

    // —— 操作说明 ——
    el('div.bubble-help-grid', {}, [
      helpLine('单击气泡', '编辑这条日程'),
      helpLine('拖动气泡', '拖到另一个气泡上松手就放进去（小的能进大的）；放不进去会抖一下'),
      helpLine('拉出来', '在容器里把子气泡拖到左侧栏松手 = 拉出来，变成和母气泡平级'),
      helpLine('双击气泡', '进到它里面（套娃）；最小档（蓝）装不下东西，双击只会抖一下'),
      helpLine('长按 2.5 秒', '戳破气泡（里面的子气泡会被放出来，不会跟着消失）'),
      helpLine('单击背景', '新建一条日程；在容器里则是往里加子气泡'),
      helpLine('双击背景', '从容器里出来（相当于镜头拉远）'),
    ]),

    // —— 颜色含义 ——
    el('div.bubble-help-title', { text: '颜色 = 事情多大（你自己选）' }),
    el('div.bubble-help-grid', {}, LEVELS.slice().reverse().map((l) =>
      helpLine(l.label, `用来装「${l.label}」的事；方块越大能装越小的气泡`, l.color))),

    // —— 大小含义 ——
    el('div.bubble-help-title', { text: '大小 = 还剩多久（自动算，越近越大）' }),
    el('div.bubble-help-grid', {}, [
      helpLine('越大越紧', '一周内会明显长大，最后一天长得最快'),
      helpLine('过期变紫', '暗紫 + 向内长刺 + 原地不动，表示已经过点了；母气泡过期时里面的子气泡也一起变紫'),
      helpLine('通知强度', '跟着"还剩多久"走：一年/一月/一周 1 级、一天 2 级、小时 3 级、分秒 4 级'),
    ]),

    legendHost,

    // —— 少量设置 ——
    el('div.bubble-help-title', { text: '显示设置' }),
    el('div.bubble-panel-row', {}, [
      el('span.bubble-tool-label', { text: '时间范围' }),
      seg([
        { value: 3, label: '3 天' },
        { value: 7, label: '7 天' },
        { value: 14, label: '14 天' },
        { value: 30, label: '30 天' },
      ], config.horizonDays, (v) => { localStorage.setItem(HORIZON_KEY, String(v)); rerender(); }),
      // 「自调」：用户要的不只是 3/7/14/30 这几档，还能自己填一个天数。
      // ⚠️ 值要**夹到 1–365**：填 0 或者空会让气泡区只剩"今天"甚至什么都不剩，
      //    而那种表现看起来像"气泡区坏了"，没人会想到是设置里填了个 0。
      el('input.bubble-horizon-input', {
        type: 'number',
        min: '1',
        max: '365',
        step: '1',
        value: String(config.horizonDays),
        title: '自定义天数（1–365）',
        'aria-label': '自定义时间范围天数',
        onchange: (e) => {
          const raw = Number(e.target.value);
          const v = Math.max(1, Math.min(365, Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 14));
          e.target.value = String(v);
          localStorage.setItem(HORIZON_KEY, String(v));
          rerender();
        },
      }),
      el('span.bubble-tool-label', { text: '天（可自填）' }),
      el('div.spacer'),
      el('button.btn.btn-sm', {
        text: config.showDone ? '隐藏已完成' : '显示已完成',
        onclick: () => { localStorage.setItem(SHOW_DONE_KEY, config.showDone ? '0' : '1'); rerender(); },
      }),
      el('button.btn.btn-sm', { text: '重排', onclick: () => { resetRequested = true; rerender(); } }),
    ]),
    // 节日气泡：还剩几天时浮出来（用户定的默认 4 天、可调；0 = 不显示）
    el('div.bubble-panel-row', {}, [
      el('span.bubble-tool-label', { text: '节日气泡' }),
      el('input.bubble-horizon-input', {
        type: 'number', min: '0', max: '60', step: '1',
        value: String(config.festivalDays),
        'data-field': 'festival-days',
        title: '节日还剩几天时浮出节日气泡（0 = 不显示）',
        'aria-label': '节日气泡提前天数',
        onchange: (e) => {
          const raw = Number(e.target.value);
          const v = Number.isFinite(raw) && raw >= 0 ? Math.min(60, Math.round(raw)) : 4;
          e.target.value = String(v);
          localStorage.setItem(FESTIVAL_DAYS_KEY, String(v));
          rerender();
        },
      }),
      el('span.bubble-tool-label', { text: '天前出现（0 = 不显示）' }),
    ]),
    festivalArtBlock(state, rerender),
    // 课程开关（用户要求）：课程是周期性的，气泡区更适合放临时事务。
    // 用 `label.switch-row` 的现成样式（勾选框 + 文字一行，点哪都能切换）。
    el('label.switch-row.bubble-course-toggle', {}, [
      el('span', { text: '在气泡区显示课程' }),
      el('input', {
        type: 'checkbox',
        checked: config.showCourse,
        onchange: (e) => {
          localStorage.setItem(SHOW_COURSE_KEY, e.target.checked ? '1' : '0');
          rerender();
        },
      }),
    ]),

    // —— 桌面气泡区（**只有 Windows 的 PC 版会显示这一整块**）——
    // 用户要的"软件入口"就在这里：打开/关闭那一层、两个开关、开机自启。
    // 平板上接口不存在（404）→ store 回答 null → 这一块整个不出现。
    ...desktopLayerBlock(rerender),

    el('div.bubble-panel-row.bubble-size-row', {}, [
      el('span.bubble-tool-label', { text: '当前选中' }),
      pickLabel,
      infoLabel,
    ]),
    el('div.bubble-panel-row', {}, [
      el('span.bubble-tool-label', { text: '改成' }),
      levelRow,
    ]),
  ]);

  local.setSelected = setSelected;
  /**
   * 当前这一层的容器是不是紫色（过期）。
   *
   * 用途：过期容器**只读** —— 能进去看，但不能往里加子泡泡（用户要求）。
   * 直接复用模块级的 `isOverdueContainer`，别在这里再写一份判定 ——
   * 两份判定迟早会不一致，而这个项目已经因为"两条路径不一致"栽过（levelOf）。
   */
  local.isOverdueContainer = () => isOverdueContainer(state);
  renderLevels();
  renderLegend(legendHost);
}

/**
 * HUD 上那一格（"点了哪个气泡 / 这一层怎么操作"）。
 *
 * ⚠️ **空文字时必须整格收起来**：`.bubble-hud-chip` 有边框和底色，
 * 留着空文字就会画成一个**空的白色小胶囊**，看起来像"界面坏了"。
 * 最外层没有容器时 `hudHint()` 返回的就是空串 —— 用户截图里左上角那个空盒子就是它。
 * （配套的 CSS 里必须有 `.bubble-hud-chip[hidden] { display: none }`，
 *   否则 `display: inline-flex` 会盖过 `[hidden]`。）
 */
function setHudChip(chip, text, muted) {
  if (!chip) return;
  const t = text || '';
  chip.textContent = t;
  chip.hidden = !t;
  chip.classList.toggle('muted', muted == null ? !t : !!muted);
}

/**
 * ⚠️ 这个文件里已经栽过三次"自由变量"（`state` / `tapRipple` / `state.events`），
 * 三次的表现都是**静默半坏**：异常要么被浏览器吞掉，要么发生在 setTimeout 回调里，
 * 用户只看到"点了没反应"。所以留一条自查的说明：
 *
 *   在**任何**函数体里引用 `state` / `ctx` / `config` / `local` 之前，
 *   先确认它们出现在**本函数的形参或本作用域的 const** 里。
 *   尤其是「渲染期建立、手势期才调用」的闭包（`setSelected`、`isOverdueContainer`）——
 *   它们抛错的时间点离定义点很远，看代码看不出来。
 *
 * 现在由真浏览器测试兜着（`tools/bubble-touch.test.mjs` 会真的在容器里点背景），
 * 但别因此就敢随便加闭包。
 */

/** 说明面板里的一行：左边做法，右边解释；可选一个色块 */
function helpLine(action, desc, color) {
  return el('div.bubble-help-line', {}, [
    el('span.bubble-help-key', {}, [
      ...(color ? [el('i', { style: { background: color } })] : []),
      el('span', { text: action }),
    ]),
    el('span.bubble-help-desc', { text: desc }),
  ]);
}

function renderLegend(host) {
  mount(host, [
    el('div.bubble-legend-block', {}, [
      el('div.bubble-legend-title', { text: '颜色 = 事情多大（手选）' }),
      el('div.bubble-legend-ramp', {}, URGENCY_TIERS.map((t) =>
        el('div.bubble-legend-item.tier-' + t.key, { title: t.description }, [
          el('i', { style: { background: t.color } }),
          el('span', { text: t.label }),
        ]))),
    ]),
    el('div.bubble-legend-block', {}, [
      el('div.bubble-legend-title', { text: '大小 = 还剩多久（自动，越近越大）' }),
      el('div.bubble-size-demo', {}, [
        [0.06, '一年后'], [0.16, '一个月'], [0.28, '一周'], [0.45, '一天'], [0.68, '一小时'], [1.0, '马上'],
      ].map(([ratio, label]) => el('div.bubble-size-item', {}, [
        el('i', { style: { width: `${Math.round(8 + ratio * 26)}px`, height: `${Math.round(8 + ratio * 26)}px` } }),
        el('span', { text: label }),
      ]))),
    ]),
  ]);
}

// ---------- 动力学模拟 ----------
function startSimulation({ canvas, items, config, ctx, local, events = [], customArt = {} }) {  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return () => {};

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let width = 0;
  let height = 0;
  let raf = 0;
  let last = performance.now();
  let time = 0;

  const bodies = items.map((item, i) => {
    // ⚠️ 这里是一颗泡泡的"尺寸入口"，**必须挡住非法值**。
    //    踩过：节日泡泡的 style 漏了 radius → 这里是 undefined → mass 变 NaN
    //    → 位置全变 NaN → createRadialGradient 抛异常 → 整个气泡区空白。
    //    宁可这一颗用兜底尺寸（40），也不能让一个坏字段把整块画布带走。
    const rawR = item.style && item.style.radius;
    const r = Number.isFinite(rawR) && rawR > 0 ? rawR : 40;
    const angle = i * 2.399963;
    return {
      item,
      key: item.key,
      r,
      r0: r,
      targetR: r,
      x: 0, y: 0,
      vx: 0, vy: 0,
      mass: Math.max(1, (r * r) / 900),
      phase: Math.random() * Math.PI * 2,
      drift: 0.5 + Math.random() * 0.9,
      angle,
      // 过期气泡：定点不动（用户要求"在最后一秒待的位置不再浮动"）
      frozen: !!item.style.overdue,
      // 长按进度 0–1（画外圈进度环）
      hold: 0,
      shake: 0,
      // 形变
      squash: 0,
      squashVel: 0,
      squashT: 0,
      nx: 1,
      ny: 0,
      dragging: false,
    };
  });

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    width = Math.max(280, rect.width);
    height = Math.max(320, rect.height);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 按当前画布大小算出每个气泡的"目标半径"。
   * 手机上画布很窄，固定半径会让气泡挤成一团还被边缘裁掉，
   * 所以半径上限跟着画布短边缩放，气泡太多时再整体缩一次。
   *
   * 尺寸来源 = item.style.radiusRatio（= 还剩多久的连续曲线，见 core/countdown.js），
   * 不直接用 style.radius：那个是按默认 26–104 算的，换算成画布实际区间才对。
   * 只设 targetR，实际半径在每帧里平滑逼近 —— 剩余时间在走，气泡是"慢慢长大"的。
   */
  function applySizes() {
    const { min, max } = radiusRangeForCanvas(width, height);
    const wanted = bodies.map((b) => min + (max - min) * (b.item.style.radiusRatio || 0));
    const scale = areaScaleForCanvas(wanted, width, height);
    bodies.forEach((b, i) => {
      b.targetR = Math.max(RADIUS_MIN_FLOOR, wanted[i] * scale);
    });
  }

  /** 顶部要给 HUD 留出的高度：气泡不许进这一条，否则会盖住 ⚙ / 计数条 */
  function hudInset() { return 46; }

  // -------------------------------------------------------------------------
  // 定时重算「还剩多久」
  //
  // ⚠️ 为什么必须有这一段（用户实测报的 bug，原话："时间不动，删进程重进才会变"）：
  //    `bubbleStyle()` 在渲染时**只算一次**；之后帧循环只做物理
  //    （半径向 targetR 逼近、漂浮、碰撞），**完全不重算时间**。
  //    app.js 里也没有任何周期性 refresh —— 于是"剩余 X"和气泡大小**冻住**，
  //    只有数据变化 / 切视图 / 手动操作才会更新，用户得杀进程重进。
  //    而"大小 = 还剩多久"是气泡区的核心表达，不刷新等于废掉一半。
  //
  // 为什么**不用** `ctx.refresh()`：那会把整棵视图重建、气泡**重新散开**，
  //    位置每隔几秒全跳一次，很难受。这里只重算 style + 目标半径，
  //    位置和速度都不动；半径由 step() 平滑逼近 → 气泡"慢慢长大"，
  //    正是 countdown.js 那套曲线的设计意图。
  //
  // 15 秒够用：倒计时本身是分钟粒度，而重算只是几十次纯函数调用，成本可忽略。
  // -------------------------------------------------------------------------
  // 1 秒重算一次。为什么可以这么勤：
  //   `bubbleStyle()` 是纯函数（日期算术 + 查表），气泡上限 90 颗，
  //   即每秒九十次纯计算 —— 成本可忽略。好处是倒计时在分钟边界后 1 秒内就跳，
  //   气泡生长也足够平滑。
  //
  // ⚠️ 但要写清楚一件容易误会的事（用户就问过）：
  //   **提醒的触发完全不走这里。** 网页端由 `web/adapter/reminder.js` 自己的
  //   `setInterval` 驱动；iOS 壳里更是**提前注册成系统的定时通知**
  //   （UNCalendarNotificationTrigger），App 关掉都会响。
  //   所以这个间隔只影响"画面上的字和大小多久更新一次"，
  //   **调大调小都不会让提醒早响或晚响**。
  const RESTYLE_MS = 1000;
  // 用 performance.now() 起算而不是 0：帧循环里的 now 也是 performance.now()，
  // 若从 0 起算，页面活过 15 秒后**第一次渲染完的下一个帧就会立刻重算一次**
  // （无害，但没必要）。这样第一次重算是"渲染后 15 秒"。
  let lastRestyle = performance.now();
  // 只警告一次，别每 15 秒刷一条
  let restyleFailed = false;

  function restyleAll() {
    const now = new Date();
    for (const b of bodies) {
      const item = b.item;
      if (!item || !item.event) continue;
      // ⚠️ 这里是 `events`（startSimulation 的解构参数），**不是 `state.events`**。
      //    写成 state.events 会 ReferenceError，而且异常会**打断 rAF 循环** ——
      //    表现是"气泡不动了 + 倒计时也不走"，比原来的 bug 更糟。
      //    （实测踩到：tools/bubble-clock.test.mjs 精确报出了这行。）
      const style = bubbleStyle(item, {
        now,
        // 同上：只看**祖先链**，不要拿自己的 base 期限当"容器过期"（那圈紫齿轮的根因）
        forceOverdue: stateOps.inheritedOverdueOf(item.event, events, now),
        // 重复事件才显示"周几"（单次日程显示是噪音）
        showWeekday: isRepeating(item.event),
      });
      // 「时间范围」预览造成的淡化是按渲染时算的，和 now 无关 —— 要保留，
      // 否则重算一次就把虚线预览的淡化弄没了。
      if (item.style && item.style.dimmed) style.dimmed = true;
      item.style = style;
      // 过期状态可能刚刚发生变化：过期气泡要**定点不动**
      b.frozen = !!style.overdue;
    }
    applySizes();
  }

  function clampAll() {
    for (const b of bodies) {
      b.x = clamp(b.x, b.r + 2, Math.max(b.r + 2, width - b.r - 2));
      b.y = clamp(b.y, b.r + hudInset(), Math.max(b.r + hudInset(), height - b.r - 2));
    }
  }

  function scatter() {
    for (const b of bodies) {
      const margin = b.r + 8;
      const topMin = b.r + hudInset() + 4;
      b.x = margin + Math.random() * Math.max(1, width - margin * 2);
      b.y = topMin + Math.random() * Math.max(1, height - topMin - margin);
      const a = Math.random() * Math.PI * 2;
      const speed = 5 + Math.random() * 8;
      b.vx = Math.cos(a) * speed;
      b.vy = Math.sin(a) * speed;
      b.squash = 0; b.squashVel = 0;
    }
  }

  function step(dt) {
    const dtSec = dt / 1000;

    // 半径平滑逼近目标值（拖大小滑块时不会有突兀的跳变）
    for (const b of bodies) {
      if (b.targetR && Math.abs(b.r - b.targetR) > 0.4) {
        const k = Math.min(1, RADIUS_EASE * dtSec);
        b.r += (b.targetR - b.r) * k;
        b.mass = Math.max(1, (b.r * b.r) / 900);
      }
    }

    for (const b of bodies) {
      if (b.dragging) { decaySquash(b, dtSec); continue; }

      // 过期气泡：**定点不动**（用户要求"在最后一秒待的位置不再浮动"）。
      // 但它仍然参与碰撞分离，所以别的气泡撞上来时它会被推开、并做出形变。
      if (b.frozen) {
        b.vx = 0; b.vy = 0;
        b.shake = Math.max(0, b.shake - dtSec * 2.2);
        decaySquash(b, dtSec);
        continue;
      }
      if (b.shake > 0) b.shake = Math.max(0, b.shake - dtSec * 2.2);

      // 低频噪声推动方向：缓慢、无固定中心地四处飘
      b.phase += dt * 0.00035 * b.drift;
      const wanderAngle = b.phase * 2.1 + b.angle;
      b.vx += Math.cos(wanderAngle) * WANDER * dtSec * b.drift;
      b.vy += Math.sin(wanderAngle * 1.3) * WANDER * dtSec * b.drift;

      // 边界：软转向 + 硬约束兜底。
      // 顶部额外留出 HUD 的高度，否则气泡会盖住 ⚙ 和计数条。
      const topMin = b.r + hudInset();
      const m = b.r + 6;
      if (b.x < m) b.vx += EDGE_TURN * dtSec * (1 - Math.max(0, b.x) / m);
      if (b.x > width - m) b.vx -= EDGE_TURN * dtSec * (1 - Math.max(0, width - b.x) / m);
      if (b.y < topMin) b.vy += EDGE_TURN * dtSec * (1 - Math.max(0, b.y) / topMin);
      if (b.y > height - m) b.vy -= EDGE_TURN * dtSec * (1 - Math.max(0, height - b.y) / m);

      // 阻力 + 限速
      const drag = Math.pow(DRAG, dtSec);
      b.vx *= drag; b.vy *= drag;
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > MAX_SPEED) {
        b.vx = (b.vx / speed) * MAX_SPEED;
        b.vy = (b.vy / speed) * MAX_SPEED;
      }

      b.x += b.vx * dtSec;
      b.y += b.vy * dtSec;

      decaySquash(b, dtSec);
    }

    // 碰撞：位置修正 + 冲量 + 记录形变
    //
    // ⚠️ **拖动时整块跳过**（用户要求："只有自由浮动状态才碰撞"）。
    //    否则手指把一个气泡推向目标时会被弹开、还会"越推越远"，根本放不进去。
    //    拖动中的气泡可以穿过别的气泡，松手后碰撞立刻恢复正常。
    if (!dragBody) {
      for (let i = 0; i < bodies.length; i += 1) {
        const a = bodies[i];
        for (let j = i + 1; j < bodies.length; j += 1) {
          const b = bodies[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          const minD = a.r + b.r;
          if (d2 >= minD * minD) continue;
          let d = Math.sqrt(d2);
          if (d < 0.0001) { d = 0.0001; dx = 0.0001; dy = 0; }
          const nx = dx / d;
          const ny = dy / d;
          const overlap = minD - d;
          const totalMass = a.mass + b.mass;

          // 分离：按质量分配，并**完全消除重叠**。
          // 这是"气泡不再互相重叠"的关键 —— 原来用的是软修正，重叠会残留。
          // 过期（frozen）的气泡不会被推开：过期的要"钉在原地"。
          const aFixed = a.frozen;
          const bFixed = b.frozen;
          if (!aFixed && !bFixed) {
            a.x -= nx * overlap * POSITION_CORRECTION * (b.mass / totalMass);
            a.y -= ny * overlap * POSITION_CORRECTION * (b.mass / totalMass);
            b.x += nx * overlap * POSITION_CORRECTION * (a.mass / totalMass);
            b.y += ny * overlap * POSITION_CORRECTION * (a.mass / totalMass);
          } else if (aFixed && !bFixed) {
            b.x += nx * overlap * POSITION_CORRECTION;
            b.y += ny * overlap * POSITION_CORRECTION;
          } else if (bFixed && !aFixed) {
            a.x -= nx * overlap * POSITION_CORRECTION;
            a.y -= ny * overlap * POSITION_CORRECTION;
          }

          // 冲量（各自按自己的质量）；固定的那方不动，等于"被撞了一下"
          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const sep = rvx * nx + rvy * ny;
          if (sep < 0) {
            const invA = aFixed ? 0 : 1 / a.mass;
            const invB = bFixed ? 0 : 1 / b.mass;
            const impulse = (invA + invB) > 0
              ? -(1 + RESTITUTION) * sep / (invA + invB)
              : 0;
            if (!aFixed) { a.vx -= impulse * invA * nx; a.vy -= impulse * invA * ny; }
            if (!bFixed) { b.vx += impulse * invB * nx; b.vy += impulse * invB * ny; }

            // 形变：只跟"撞击有多猛"有关，而且幅度很小（克制、真实）
            const hit = Math.min(1, Math.abs(sep) / 140);
            addSquash(a, -1, nx, ny, hit * SQUASH_PER_HIT);
            addSquash(b, 1, nx, ny, hit * SQUASH_PER_HIT);
            // 固定的那一方被撞：抖一下（过期气泡"扎手"的反馈）
            if (aFixed && !bFixed) b.shake = Math.max(b.shake, hit * 0.6);
            if (bFixed && !aFixed) a.shake = Math.max(a.shake, hit * 0.6);
          } else if (overlap > 1) {
            // 只是被挤着：给极小的形变，看得出是软的，但不夸张
            const hit = Math.min(0.5, overlap / Math.max(1, minD));
            addSquash(a, -1, nx, ny, hit * SQUASH_PER_HIT * 0.35);
            addSquash(b, 1, nx, ny, hit * SQUASH_PER_HIT * 0.35);
          }
        }
      }
    }

    // 碰撞分离可能把气泡推到画布外，这里兜一次（否则会被边缘裁掉）
    for (const b of bodies) {
      if (b.dragging) continue;
      const m = b.r + 2;
      const topMin = b.r + hudInset();
      if (b.x < m) { b.x = m; if (!b.frozen) b.vx = Math.abs(b.vx) * 0.5; }
      if (b.x > width - m) { b.x = width - m; if (!b.frozen) b.vx = -Math.abs(b.vx) * 0.5; }
      if (b.y < topMin) { b.y = topMin; if (!b.frozen) b.vy = Math.abs(b.vy) * 0.5; }
      if (b.y > height - m) { b.y = height - m; if (!b.frozen) b.vy = -Math.abs(b.vy) * 0.5; }
      // 过期气泡位置只夹不推，速度保持归零
      if (b.frozen) { b.vx = 0; b.vy = 0; }
    }
  }

  function decaySquash(b, dtSec) {
    if (b.squash === 0 && b.squashVel === 0) return;
    // 阻尼弹簧：回弹并轻微过冲，像软的东西被挤了一下就复原
    const k = SQUASH_FREQ * SQUASH_FREQ;
    const c = 2 * SQUASH_DAMPING * SQUASH_FREQ;
    b.squashVel += (-k * b.squash - c * b.squashVel) * dtSec;
    b.squash += b.squashVel * dtSec;
    if (b.squash > SQUASH_MAX) b.squash = SQUASH_MAX;
    if (b.squash < -SQUASH_MAX) b.squash = -SQUASH_MAX;
    if (Math.abs(b.squash) < 0.0015 && Math.abs(b.squashVel) < 0.015) {
      b.squash = 0; b.squashVel = 0;
    }
  }

  // ---------- 绘制 ----------
  /**
   * 一颗泡泡画挂了 → **在界面上说出是哪一颗、哪个字段坏的**。
   *
   * ⚠️ 为什么必须弹给用户看（而不是只 console.error）：
   *   现场是 iPad，**没有 DevTools、没有控制台**。用户能提供的只有"App 出了个错"。
   *   所以这条 toast 是**远程诊断的唯一手段**：它要说清「哪颗泡泡 / 哪个量 / 相关字段的值」。
   *
   * ⚠️ 两种坏消息都要能报出来，而且不能互相吃掉：
   *   · `calc`：一颗泡泡的**数字**里有 NaN（`drawNumbersOf` 兜住了，但字段名要报）
   *   · `draw`：数字都正常，却**在画的时候**抛了（未预料到的 canvas 调用）
   *   只报第一种会漏掉真正的绘制异常；只报第二种就说不清"是哪个字段"。
   */
  const bubbleErrorKeys = new Set();
  const reportedProblemFields = new Set();
  /** @param {object} b @param {'calc'|'draw'} kind @param {Array} problems @param {Error} [err] */
  function reportBubbleFailure(b, kind, problems, err) {
    const fields = (problems || []).map((p) => p.field);
    const key = `${b.key}|${fields.join(',')}|${kind}|${(err && err.message) || ''}`;
    if (bubbleErrorKeys.has(key)) return;      // 同一颗、同一个原因，只报一次
    bubbleErrorKeys.add(key);
    // `safe` = 整颗都画挂了（这时通常没有具体字段，措辞要说清"已补画一颗圆"）
    const detail = bubbleDrawDiagnostic(b.item, problems, kind === 'draw' ? 'safe' : 'repair');
    const isNewField = fields.some((f) => !reportedProblemFields.has(f));
    fields.forEach((f) => reportedProblemFields.add(f));
    try {
      console.error(`[bubble] ${kind === 'calc' ? '算出了非法数字' : '画不出来'}：${detail}`, err || '');
      // 同一条根因（同一批字段）已经在屏幕上留过一条了 → 不再重复弹窗，免得把泡泡区刷满
      if (kind === 'calc' && !isNewField) return;
      toast({
        title: kind === 'calc' ? '泡泡的大小/位置算错了' : '有一颗泡泡画不出来',
        // ⚠️ 异常原文要留着：真机上报回来的那句话，是和我们这张表对齐的唯一证据
        body: `${detail}${err && err.message ? `｜异常：${err.message}` : ''}`,
        kind: 'err',
        timeout: 12000,
      });
    } catch { /* toast/console 自己炸了不能再抛，否则每帧递归 */ }
  }

  /**
   * 最小安全画法：**画一颗看得见的圆**（颜色用它的档位色、透明度低一点）。
   *
   * 这条兜底的目的是"不消失"：用户报的是"泡泡隐身了但还能点到"，
   * 那就宁可画一颗朴素的圆，也不要让这一颗从视觉上消失（那会让人以为数据丢了）。
   */
  function drawSafeBubble(b, alpha) {
    const st = b.item.style || {};
    // 档位色：优先用 style.tier（节日泡泡的专用色就是它），没有就按 key 查回真档。
    // ⚠️ 别在这里写死一个 '#38bdf8' 兜底 —— 那会让"红泡泡"画成蓝的，
    //    比"少一颗"更容易让人误判（以为是数据错了）。
    const tier = (st.tier && typeof st.tier === 'object' && typeof st.tier.color === 'string') ? st.tier
      : tierByKey(st.tierKey || st.levelKey);
    const color = (tier && typeof tier.color === 'string') ? tier.color : '#38bdf8';
    const r = isFiniteNumber(b.r) && b.r > 0 ? b.r : SAFE_RADIUS;
    const x = isFiniteNumber(b.x) ? b.x : 0;
    const y = isFiniteNumber(b.y) ? b.y : 0;
    // 透明度：能算出就沿用（正常泡泡兜底时观感不变），算不出才用更低的那一档
    const a = isFiniteNumber(alpha) ? alpha : SAFE_FALLBACK_ALPHA;
    try {
      ctx2d.beginPath();
      ctx2d.arc(x, y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = hexToRgba(color, 0.5 * a);
      ctx2d.fill();
      ctx2d.lineWidth = Math.max(1, r * 0.03);
      ctx2d.strokeStyle = hexToRgba(color, 0.9 * a);
      ctx2d.stroke();
    } catch { /* 连圆都画不出来就只能放弃了（不能让它把整帧带走） */ }
  }

  /**
   * 画**一颗**泡泡的全部内容。
   *
   * ⚠️ 这个函数的边界是这次事故的止血点：调用方（draw）用 try/catch 把它整个包住，
   *    所以**一颗泡泡抛异常绝不会影响别的泡泡**。
   *    以前是一百多行直接摊在 `for` 循环里 —— 一次抛出就打断整帧，
   *    用户看到的是"整个气泡区空白"（而不是"少一颗"），这就是"隐身"的由来。
   */
  function paintBubble(b, v, lines) {
    const st = b.item.style;
    // ⚠️ `st.tier` 也可能是坏的（null / 字符串 / 没颜色）。以前这里写的是
    //    `ownOverdue ? OVERDUE_COLOR : tier.color` —— tier 一坏就是 TypeError，
    //    而 TypeError 同样会**打断整帧**（症状和"非有限"一模一样）。
    //    所以档位色也走"合法就用、不合法查回真档"这一条路。
    const tier = (st.tier && typeof st.tier === 'object' && typeof st.tier.color === 'string')
      ? st.tier : tierByKey(st.tierKey || st.levelKey);
    const isSelected = local.selected && local.selected.bubble === b;
    const tierC = v.ownOverdue ? OVERDUE_COLOR : tier.color;
    const litC = mixColor(tierC, '#ffffff', 0.42);
    const bodyC = mixColor(tierC, '#ffffff', 0.06);
    const shadowC = mixColor(tierC, '#0b1220', 0.45);
    const alpha = v.alpha;
    const r = v.r;
    const theta = v.theta;
    const scalePerp = v.scalePerp;
    const scaleAlong = v.scaleAlong;
    const ldx = -Math.SQRT1_2;
    const ldy = -Math.SQRT1_2;

    // -----------------------------------------------------------------------
    // 真气泡的画法（参考 glassmorphism / 玻璃折射的通行做法）：
    //   1) 软外晕          —— 把气泡"垫"在背景上
    //   2) 受光的球体      —— 左上亮、右下暗；外轮廓留一圈色，否则会糊
    //   3) 边缘光带        —— 很薄的一圈浅色渐变，不是实心粗亮环
    //   4) 镜面轮廓光      —— 偏一侧的弧形亮带 + 背光侧浅暗边 = 体积感
    //   5) 双高光          —— 一个大的柔光斑 + 一个很小的细点（真实反射）
    //   6) 底部内暗影      —— 圆的下缘积暗，立体感
    //   7) 文字            —— 淡暗色垫片 + 柔和描边，保证半透明底上的可读性
    // -----------------------------------------------------------------------

    // 0) 过期的刺：从泡壁**向内**长一圈尖刺（用户要求"向内长出一圈刺"）。
    //    先画，后面泡体盖上去，只留刺尖露在泡内，看起来是扎进泡里的。
    //    只有「自己过期」才长刺 —— 容器过期的那颗自己还没到期，不该被刺。
    if (v.ownOverdue) drawOverdueSpikes(ctx2d, b, v);

    // 1) 软外晕
    const glow = ctx2d.createRadialGradient(v.x, v.y, v.r * 0.7, v.x, v.y, v.r * v.glowScale);
    glow.addColorStop(0, hexToRgba(tierC, 0.16 * alpha));
    glow.addColorStop(1, hexToRgba(tierC, 0));
    ctx2d.fillStyle = glow;
    ctx2d.beginPath();
    ctx2d.arc(v.x, v.y, v.r * v.glowScale, 0, Math.PI * 2);
    ctx2d.fill();

    // 2) 泡体：左上偏亮、右下偏深。外轮廓要有一圈色，但只能**很薄的一圈**：
    //    圈一厚就变成"透镜/按钮"，而不是泡（真机放大后就是这个观感）。
    const body = ctx2d.createRadialGradient(v.lx, v.ly, v.bodyInnerR, v.x, v.y, v.bodyOuterR);
    body.addColorStop(0.00, hexToRgba(litC, 0.30 * alpha));
    body.addColorStop(0.42, hexToRgba(bodyC, 0.17 * alpha));
    body.addColorStop(0.80, hexToRgba(tierC, 0.24 * alpha));
    body.addColorStop(0.97, hexToRgba(shadowC, 0.34 * alpha));
    body.addColorStop(1.00, hexToRgba(shadowC, 0.10 * alpha));
    ellipsePath(ctx2d, v, 1);
    ctx2d.fillStyle = body;
    ctx2d.fill();

    // 2.5) 节日泡泡：铺一层背景图案（月亮/灯笼/粽子…，或用户自己换的图）。
    //      只给节日泡泡画 —— 普通事项泡泡上糊个图案会变成噪声。
    //
    // ⚠️ 这里**必须兜住异常**：图案来自 core/festival-art.js 的形状清单 + 用户自己换的图，
    //    抛一次就是"这一颗少一张背景"（现在更是只影响这一颗，见 paintBubble 的边界）。
    const festKey = b.item && b.item.event && b.item.event.festivalKey;
    if (festKey) {
      try {
        drawFestivalArt(ctx2d, b, v.r, festKey, customArt, alpha);
      } catch (err) {
        if (!artDrawWarned) {
          artDrawWarned = true;
          console.error('[节日图案] 画不出来，已跳过（只报一次）：', festKey, err);
        }
        ctx2d.restore && ctx2d.restore();
      }
    }

    // 3) 边缘光带：更薄、更淡的一圈浅色渐变（原来 0.93R/0.38 偏重，会形成双环）。
    const rim = ctx2d.createRadialGradient(v.x, v.y, v.rimInnerR, v.x, v.y, v.rimOuterR);
    rim.addColorStop(0.00, hexToRgba(litC, 0));
    rim.addColorStop(0.80, hexToRgba(litC, 0.03 * alpha));
    rim.addColorStop(0.95, hexToRgba(litC, 0.20 * alpha));
    rim.addColorStop(1.00, hexToRgba(litC, 0.03 * alpha));
    ellipsePath(ctx2d, v, 1);
    ctx2d.fillStyle = rim;
    ctx2d.fill();

    // 4) 被照亮那一侧的轮廓光：偏左上的一段弧，是玻璃感的主要来源。
    ctx2d.beginPath();
    ctx2d.ellipse(v.x, v.y, v.outlineR * scalePerp, v.outlineR * scaleAlong, theta, 0, Math.PI * 2);
    ctx2d.lineWidth = v.outlineWidth;
    ctx2d.lineCap = 'round';
    const arcA = Math.atan2(ldy, ldx);
    const arc = Math.PI * 1.05;
    void arc;
    const rimLight = ctx2d.createLinearGradient(
      v.x + Math.cos(arcA) * r, v.y + Math.sin(arcA) * r,
      v.x - Math.cos(arcA) * r, v.y - Math.sin(arcA) * r,
    );
    rimLight.addColorStop(0, `rgba(255,255,255,${(st.done ? 0.20 : 0.56) * alpha})`);
    rimLight.addColorStop(0.55, `rgba(255,255,255,${(st.done ? 0.08 : 0.22) * alpha})`);
    rimLight.addColorStop(1, 'rgba(255,255,255,0)');
    ctx2d.strokeStyle = rimLight;
    ctx2d.stroke();
    // 背光侧压一道浅暗边，泡泡才有体积（不然看着像贴纸）。
    // 弧必须画得够长、两端必须淡到 0，否则它和受光弧的接缝会露出来一条"鬼影"斜线。
    const arcBack = Math.PI * 0.62;
    const shadowArc = ctx2d.createLinearGradient(
      v.x + Math.cos(arcA + Math.PI) * r, v.y + Math.sin(arcA + Math.PI) * r,
      v.x - Math.cos(arcA + Math.PI) * r, v.y - Math.sin(arcA + Math.PI) * r,
    );
    shadowArc.addColorStop(0.00, 'rgba(11,18,32,0)');
    shadowArc.addColorStop(0.16, `rgba(11,18,32,${0.20 * alpha})`);
    shadowArc.addColorStop(0.46, 'rgba(11,18,32,0)');
    shadowArc.addColorStop(1.00, 'rgba(11,18,32,0)');
    ctx2d.strokeStyle = shadowArc;
    ctx2d.beginPath();
    ctx2d.ellipse(v.x, v.y, v.shadowArcR * scalePerp, v.shadowArcR * scaleAlong, theta,
      arcA + Math.PI - arcBack, arcA + Math.PI + arcBack);
    ctx2d.stroke();
    ctx2d.lineCap = 'butt';

    // 5) 高光：真气泡上的反射**没有边界**。
    //    v2 用"压扁的圆"画，被拉长的那个圆其边缘曲率跟着变形，看起来就是一片
    //    贴在泡上的椭圆色块（真机上一眼假）。这里改成**纯粹由渐变构成的亮度场**：
    //    只有圆心和径向衰减，没有"块的轮廓"。
    //    位置也必须挪到 **0.74R 的贴边处**：文字的排版块会占到 ±0.36R，
    //    高光放在泡中央会正好压在字上（真机实测就是这个问题）。
    const glint = ctx2d.createRadialGradient(v.glintX, v.glintY, 0, v.glintX, v.glintY, v.glintR);
    glint.addColorStop(0.00, `rgba(255,255,255,${(st.done ? 0.05 : 0.16) * alpha})`);
    glint.addColorStop(0.45, `rgba(255,255,255,${(st.done ? 0.02 : 0.07) * alpha})`);
    glint.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx2d.beginPath();
    ctx2d.arc(v.glintX, v.glintY, v.glintR, 0, Math.PI * 2);
    ctx2d.fillStyle = glint;
    ctx2d.fill();

    const spark = ctx2d.createRadialGradient(v.glintX, v.glintY, 0, v.glintX, v.glintY, v.sparkR);
    spark.addColorStop(0.00, `rgba(255,255,255,${(st.done ? 0.12 : 0.26) * alpha})`);
    spark.addColorStop(0.50, `rgba(255,255,255,${(st.done ? 0.04 : 0.09) * alpha})`);
    spark.addColorStop(1.00, 'rgba(255,255,255,0)');
    ctx2d.beginPath();
    ctx2d.arc(v.glintX, v.glintY, v.sparkR, 0, Math.PI * 2);
    ctx2d.fillStyle = spark;
    ctx2d.fill();

    // 5b) 非常淡的中央亮场：不是为了"高光"，是为了让泡体有个球心，
    //     否则去掉那团假高光之后泡面会显得平。半径大、峰值低，所以看不出形状。
    const centerGlow = ctx2d.createRadialGradient(
      v.centerGlowX, v.centerGlowY, 0,
      v.centerGlowX, v.centerGlowY, v.centerGlowR,
    );
    centerGlow.addColorStop(0.00, `rgba(255,255,255,${(st.done ? 0.03 : 0.10) * alpha})`);
    centerGlow.addColorStop(0.55, `rgba(255,255,255,${(st.done ? 0.01 : 0.04) * alpha})`);
    centerGlow.addColorStop(1.00, 'rgba(255,255,255,0)');
    ellipsePath(ctx2d, v, 1);
    ctx2d.fillStyle = centerGlow;
    ctx2d.fill();

    // 6) 底部内暗影：圆的下缘积一点暗，立体感立刻出来（暗得太重会变"按钮"）
    ctx2d.save();
    ellipsePath(ctx2d, v, 1);
    ctx2d.clip();
    const inner = ctx2d.createRadialGradient(
      v.innerX, v.innerY, v.innerInnerR,
      v.x, v.y, v.innerOuterR,
    );
    inner.addColorStop(0.58, 'rgba(11,18,32,0)');
    inner.addColorStop(0.86, `rgba(11,18,32,${0.08 * alpha})`);
    inner.addColorStop(1.00, `rgba(11,18,32,${0.17 * alpha})`);
    ctx2d.fillStyle = inner;
    ctx2d.fillRect(v.innerRectX, v.innerRectY, v.innerRectW, v.innerRectH);
    ctx2d.restore();

    // 7) 选中态：外面加一圈深色描边（比白色更清楚）
    if (isSelected) {
      ellipsePath(ctx2d, v, 1);
      ctx2d.lineWidth = v.selectStrokeWidth;
      ctx2d.strokeStyle = luminance(tierC) > 0.45 ? 'rgba(20,26,40,.75)' : 'rgba(255,255,255,.9)';
      ctx2d.stroke();
    } else {
      // 常规外描边：一条极细的深色边，把泡泡从背景里"切"出来
      ellipsePath(ctx2d, v, 1);
      ctx2d.lineWidth = v.strokeWidth;
      ctx2d.strokeStyle = v.overdue
        ? hexToRgba(OVERDUE_EDGE, 0.55 * alpha)
        : `rgba(15,23,42,${0.14 * alpha})`;
      ctx2d.stroke();
    }

    // 7b) 长按进度环：按住 2.5 秒就戳破，环走满即触发
    if (v.hold > 0.001) {
      ctx2d.beginPath();
      ctx2d.arc(v.x, v.y, v.holdRingR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * v.hold);
      ctx2d.lineWidth = v.holdWidth;
      ctx2d.lineCap = 'round';
      ctx2d.strokeStyle = `rgba(239,68,68,${0.55 + 0.35 * v.hold})`;
      ctx2d.stroke();
      ctx2d.lineCap = 'butt';
    }

    // 7a) 「容器过期」标记：一圈暗紫**虚线**环。
    //
    // 为什么要单独一种画法：这颗泡泡自己没到期（文字写的是"剩余 N 天"），
    // 只是它所在的容器过期了。整颗变紫会让文字和颜色互相矛盾（用户报的 bug）。
    // 虚线环表达"有约束加在你身上，但你自己还没到期"——和实心紫（自己过期）区分得开。
    if (v.inheritedOverdue) {
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.arc(v.x, v.y, v.inheritedRingR, 0, Math.PI * 2);
      ctx2d.setLineDash([v.inheritedDashA, v.inheritedDashB]);
      ctx2d.lineWidth = v.inheritedRingWidth;
      ctx2d.strokeStyle = hexToRgba(OVERDUE_COLOR, 0.85 * alpha);
      ctx2d.stroke();
      ctx2d.restore();
    }

    if (r >= 18) {
      const textColor = tierTextColor(st.tierKey);
      // 暗色字 → 浅色底衬；亮色字 → 深色底衬。底衬**必须和圆的形状一致**：
      // v2 用的是一块矩形渐变，真机放大后能清楚看到方形边缘戳在圆里，非常假。
      const darkText = luminance(textColor) < 0.5;
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      // ⚠️ 字号/行高/垫板位置全部来自 core 的 drawNumbersOf（那里逐字段兜过底）；
      //    这里只负责把已经算好的数交给 canvas —— 多一个就地算式就多一个 NaN 入口。
      const titleSize = v.titleSize;
      ctx2d.font = `650 ${v.measuredFontSize}px system-ui, "Segoe UI", sans-serif`;
      const lineH = v.lineH;
      const blockH = v.blockH;
      const showSub = v.showSub;
      const showLevel = v.showLevel;
      const subSize = v.subSize;
      const textTop = v.textTop;
      const textBottom = v.textBottom;

      if (!darkText) {
        // 亮色字：一层圆形的径向暗晕垫在文字后面（没有边，不会露出方块）
        const plate = ctx2d.createRadialGradient(v.x, v.plateCY, 0, v.x, v.plateCY, v.plateR);
        plate.addColorStop(0.00, `rgba(9,14,26,${0.30 * alpha})`);
        plate.addColorStop(0.62, `rgba(9,14,26,${0.16 * alpha})`);
        plate.addColorStop(1.00, 'rgba(9,14,26,0)');
        ctx2d.beginPath();
        ctx2d.arc(v.x, v.plateCY, v.plateR, 0, Math.PI * 2);
        ctx2d.fillStyle = plate;
        ctx2d.fill();
      }
      void textBottom;

      ctx2d.save();
      ctx2d.lineJoin = 'round';
      ctx2d.lineWidth = Math.max(2, titleSize * (darkText ? 0.26 : 0.24));
      ctx2d.strokeStyle = darkText
        ? `rgba(255,255,255,${0.42 * alpha})`
        : `rgba(9,14,26,${0.32 * alpha})`;
      ctx2d.fillStyle = textColor;
      let ty = textTop;
      for (const line of lines) {
        ctx2d.strokeText(line, v.x, ty + titleSize / 2);
        ctx2d.fillText(line, v.x, ty + titleSize / 2);
        ty += lineH;
      }

      if (showSub) {
        ctx2d.font = `650 ${subSize}px system-ui, "Segoe UI", sans-serif`;
        ctx2d.lineWidth = v.subStrokeWidth;
        // 第一行是"还剩多久"（v0.4 的主角），时间点跟在后面。
        // ⚠️ 重复事件的实例还要带**周几** —— 一周勾了 7 天时，
        //    7 个泡泡标题一样、时间数字也可能一样，只有周几能区分是哪一个。
        //    （用户报："我选了 7 个泡泡你不能都显示剩一个时间吧，要有周几的区别"）
        const sub = st.weekdayLabel
          ? `${st.countdownText} · 周${st.weekdayLabel} ${hhmm(b.item.start)}`
          : `${st.countdownText} · ${hhmm(b.item.start)}`;
        ctx2d.strokeText(sub, v.x, v.subY);
        ctx2d.fillStyle = textColor;
        ctx2d.globalAlpha = 0.95;
        ctx2d.fillText(sub, v.x, v.subY);
        ctx2d.globalAlpha = 1;
      }
      if (showLevel) {
        ctx2d.font = `700 ${v.tagPostSize}px system-ui, sans-serif`;
        ctx2d.lineWidth = v.tagStrokeWidth;
        const tag = `● ${(st.level && st.level.label) || ''}`;
        ctx2d.strokeText(tag, v.x, v.tagY);
        ctx2d.fillStyle = hexToRgba('#ffffff', 0.92 * alpha);
        ctx2d.fillText(tag, v.x, v.tagY);
      }
      ctx2d.restore();
    }
  }

  function draw() {
    ctx2d.clearRect(0, 0, width, height);

    // 说明：这里**不画**母气泡边界虚线圈（用户明确说不好看）。
    // "离开容器"改由"拖到左侧栏"完成 —— 左侧栏在拖动时会变成投放区。

    for (const b of bodies) {
      /**
       * ⚠️⚠️ 这是这次事故（iPad 上 `The provided value is non-finite` + 泡泡隐身）
       * 的**止血点**：每颗泡泡的"算数字 + 画"整段包在 try/catch 里。
       *
       *   为什么必须包在这里（而不是只包节日图案那一段）：
       *     `for` 循环里任何一次抛出都会冒到 rAF 回调外 —— 那一帧剩下的泡泡**全都不画**，
       *     而且 `requestAnimationFrame(frame)` 那句也不再执行，**整个绘制循环就此死掉**。
       *     用户看到的就是"气泡区一片空白"，但命中判定走几何模型，所以"还能点到"。
       *
       *   一颗坏泡泡的代价必须**只限于它自己**：这里抛了就补画一颗安全的圆，
       *   然后**继续画下一颗**。
       */
      try {
        // ---- 第一步：把这一帧要用的数字**集中算出来**（纯函数，在 core）----
        //      `measure` 是文字排版（依赖 ctx.measureText），所以由这里传进去。
        const calc = drawNumbersOf(b.item, {
          x: b.x, y: b.y, r: b.r,
          theta: Math.atan2(b.ny, b.nx),
          squash: b.squash,
          hold: b.hold,
          // 被撞/被按时的抖动（帧相关，纯函数算不出来，所以只能传进去）。
          // ⚠️ 别在这里"顺手取整"：这个数直接决定绘制偏移，取整就是改观感。
          //    上限由 core 的 SHAKE_MAX(10) 兜着，正常值（≤ 4.5）原样通过。
          shakeX: b.shake > 0 ? Math.sin(performance.now() * 0.05) * (b.shake * 2.2) : 0,
        }, {
          measure: (title, maxWidth, fontSize, maxLines) =>
            wrapTextToFit(ctx2d, title, maxWidth, fontSize, maxLines),
        });
        // 算数字时发现坏字段 → 先把现场报出去（画还是要画，用的是兜底值）
        if (calc.problems.length) reportBubbleFailure(b, 'calc', calc.problems);

        // ⚠️ 跟几何模型对账：命中判定读的是 `b.x/b.y/b.r`，绘制读的是兜底后的数字。
        //    两者不一致就会出现"看得见、点不到"（或反过来）。
        //    所以**一旦发现物理状态里有非有限值，就把它修回有限值**（同一颗，同一次）。
        let repaired = false;
        if (!isFiniteNumber(b.x)) { b.x = calc.values.x; repaired = true; }
        if (!isFiniteNumber(b.y)) { b.y = calc.values.y; repaired = true; }
        if (!isFiniteNumber(b.r) || b.r <= 0) { b.r = calc.values.r; repaired = true; }
        if (!isFiniteNumber(b.squash)) { b.squash = 0; repaired = true; }
        if (!isFiniteNumber(b.nx)) b.nx = 1;
        if (!isFiniteNumber(b.ny)) b.ny = 0;
        if (!isFiniteNumber(b.shake)) b.shake = 0;
        if (!isFiniteNumber(b.hold)) b.hold = 0;
        if (!isFiniteNumber(b.targetR) || b.targetR <= 0) b.targetR = calc.values.r;
        if (repaired) reportBubbleFailure(b, 'calc', [{ field: '物理状态(x/y/r/squash…)', value: 'NaN' }]);

        // ---- 第二步：画 ----
        paintBubble(b, calc.values, calc.lines);
      } catch (err) {
        // 画挂了：报出现场 + **补一颗圆**（"看得见"比"少一颗"强得多），然后继续下一颗
        reportBubbleFailure(b, 'draw', [], err);
        drawSafeBubble(b, alphaOfStyle(b.item && b.item.style));
      }
    }
  }

  function frame(now) {
    const dt = Math.min(34, now - last);
    last = now;
    // 长按进度要每帧推进（长按 2.5 秒戳破）
    stepHold(dt);
    if (!paused) {
      time += dt;
      step(dt);
    }
    // 每 RESTYLE_MS 重算一次「还剩多久」——
    // 否则倒计时文字和气泡大小会冻住，必须杀进程重进才更新（见 restyleAll 的说明）。
    // 放在 step 之后、draw 之前：这样这一帧画出来的就是刚算好的新值。
    //
    // ⚠️ 必须 try/catch。重算里一旦抛异常，异常会**从这里冒出去**，
    //    于是函数末尾那句 `raf = requestAnimationFrame(frame)` 不再执行 ——
    //    **整个动画循环就死了**（气泡不漂了、倒计时也不走了）。
    //    我实测踩过：restyleAll 里写错一个变量名，表现是"动都不动了"，
    //    比原来的"时间不动"更难查。宁可真算不出来（退化成旧行为），
    //    也不能把新加的一个功能变成整块界面停摆。
    if (now - lastRestyle > RESTYLE_MS) {
      lastRestyle = now;
      try {
        restyleAll();
      } catch (err) {
        if (!restyleFailed) {
          restyleFailed = true;
          console.warn('[bubble] 重算剩余时间失败（倒计时会停，但界面仍然可用）：', err);
        }
      }
    }
    draw();
    if (debugHost) updateDebug();
    raf = requestAnimationFrame(frame);
  }

  // ---------- 调试信息（?debug=1）----------
  // 把画布尺寸和每个气泡的坐标以纯文字放进 DOM：这样用 adb 的 uiautomator
  // 就能读到，不必开 DevTools 远程调试也能核实布局。
  const debugOn = (() => {
    try {
      return new URLSearchParams(location.search).get('debug') === '1'
        || localStorage.getItem('timetable.bubble.debug') === '1';
    } catch { return false; }
  })();
  const debugHost = debugOn ? el('div.bubble-debug') : null;
  if (debugHost) canvas.parentElement.appendChild(debugHost);

  /**
   * 把气泡的实时位置暴露到 window 上，**只给自动化测试用**。
   *
   * 为什么需要：气泡画在 canvas 上，DOM 里查不到它们的位置。
   * 测试要点"气泡区空白处"，只能用一个固定坐标 —— 而气泡是浮动的，
   * 布局一变那个坐标就可能压在泡泡上，于是"点空白"变成了"点某颗泡泡"，
   * 断言从「新建日程」变成「编辑日程」而失败（`tools/bubble-path.test.mjs` 以前就偶发这个）。
   *
   * 暴露的是**只读快照函数**（每次调用重新取），不影响渲染与物理模拟。
   */
  if (typeof window !== 'undefined') {
    window.__bubbleBodies = () => bodies.map((b) => ({
      key: b.key, x: b.x, y: b.y, r: b.r,
      title: (b.item && b.item.event && b.item.event.title) || '',
      // 这两个字段是给「倒计时会不会自己走」那条测试用的。
      // 没有它就只能看 canvas 像素，而"文字变了没有"是测不出来的。
      remaining: (b.item && b.item.style) ? b.item.style.remaining : null,
      countdown: (b.item && b.item.style) ? b.item.style.countdownText : null,
      frozen: !!b.frozen,
      // 过期三兄弟也暴露出来：**画在 canvas 上的东西没法用 DOM 断言**
      // （"这一颗到底是不是被判成过期/继承过期"只能从这里读）。
      // 截图里那圈"紫齿轮"就是 overdueInherited 画出来的，测试必须能直接问它。
      overdue: !!(b.item && b.item.style && b.item.style.overdue),
      ownOverdue: !!(b.item && b.item.style && b.item.style.ownOverdue),
      overdueInherited: !!(b.item && b.item.style && b.item.style.overdueInherited),
    }));
    /**
     * 把**这次参与绘制的 item 数组**也暴露出去，只给自动化测试用。
     *
     * ⚠️ 为什么必须是 item（而不是 bodies）：`draw()` 每帧都现读 `b.item.style`，
     *    所以测试只要往这里塞一个坏字段（例如 `style.level = 'red'` 字符串、
     *    `style.radiusRatio = NaN`），**下一帧的绘制就会用上它** ——
     *    这正是"注入一颗坏泡泡，看其余泡泡还在不在"这条验收断言需要的入口。
     *    （第一版想用"篡改 bodies 里闭包对象"的办法，从测试侧根本够不到。）
     */
    window.__bubbleItems = () => items;
    window.__bubbleCanvasSize = () => ({ width, height });
    // 手动触发一次重算（测试用；生产代码里由帧循环每 RESTYLE_MS 调一次）
    window.__bubbleRestyle = () => { restyleAll(); return true; };
  }
  // 拖拽诊断的暂存区（只有 debug 打开时才写入）
  const debugState = debugOn ? {} : null;
  if (debugState) local.debug = debugState;

  function updateDebug() {
    const off = bodies.filter((b) => b.x < 0 || b.y < 0 || b.x > width || b.y > height).length;
    // 统计还有多少对气泡在重叠 —— 这是"碰撞模型是否真实"的量化指标
    let overlapPairs = 0;
    let maxOverlap = 0;
    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        const a = bodies[i];
        const c = bodies[j];
        const d = Math.hypot(c.x - a.x, c.y - a.y);
        const overlap = a.r + c.r - d;
        if (overlap > 1.5) {
          overlapPairs += 1;
          maxOverlap = Math.max(maxOverlap, overlap);
        }
      }
    }
    const lines = [
      `debug canvas=${Math.round(width)}x${Math.round(height)} n=${bodies.length}`
      + ` off=${off} overlap=${overlapPairs} maxOv=${maxOverlap.toFixed(0)}`,
    ];
    bodies.slice(0, 4).forEach((b, i) => {
      lines.push(`#${i} r=${Math.round(b.r)} x=${Math.round(b.x)} y=${Math.round(b.y)} mag=${b.item.style.magnitude} ${b.item.style.tierKey} sq=${b.squash.toFixed(3)}`);
    });
    // 拖拽诊断（只在 debug 打开时有用）：看松手时算出的是谁、距离多少
    if (local.debug && local.debug.lastDrop) {
      const d = local.debug.lastDrop;
      lines.push(`DROP dragged=${d.dragged}@${d.x},${d.y} r=${d.r} target=${d.target || '(无)'} others=[${d.others.join(' ; ')}]`);
    }
    debugHost.textContent = lines.join(' | ');
  }

  // ---------- 交互 ----------
  let dragBody = null;
  let pointerDownAt = 0;
  let pointerMoved = 0;
  let lastPos = null;
  let lastTapKey = null;
  let lastTapTime = 0;
  let holdBody = null;      // 正在长按的气泡（2.5 秒戳破）
  let holdStart = 0;
  let tapTimer = 0;         // 单击/双击的判定窗口
  let bgTapAt = 0;          // 背景按下的时刻（0 = 当前不是背景手势）
  let bgTapPos = { x: 0, y: 0 };
  let bgLastTap = 0;        // 背景上一次单击的时刻（判断"双击背景 = 出去"）
  let bgTapTimer = 0;

  function pick(x, y) {
    for (let i = bodies.length - 1; i >= 0; i -= 1) {
      const b = bodies[i];
      const dx = x - b.x;
      const dy = y - b.y;
      if (dx * dx + dy * dy <= b.r * b.r) return b;
    }
    return null;
  }

  function localPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** 背景被按下 → 立刻给一圈涟漪（见 tapRipple 的说明）。
   *  重播动画的写法不能省：只 remove/add class 有时不会重新触发（浏览器会合并样式变更），
   *  中间读一次 offsetWidth 强制重排才稳。 */
  function showTapRipple(x, y) {
    const tapRipple = local.tapRipple;
    if (!tapRipple) return;
    tapRipple.style.left = `${x}px`;
    tapRipple.style.top = `${y}px`;
    tapRipple.classList.remove('on');
    void tapRipple.offsetWidth;
    tapRipple.classList.add('on');
  }

  function onDown(e) {
    const p = localPos(e);
    const b = pick(p.x, p.y);
    pointerDownAt = performance.now();
    pointerMoved = 0;
    lastPos = p;
    if (!b) {
      // 点在背景上。两种可能，要等 onUp 才知道是哪一种：
      //   · 在容器里 → 单击背景 = 往这个容器里加子气泡；双击背景 = 出去
      //   · 在最外层 → 只是取消选中
      bgTapAt = performance.now();
      bgTapPos = p;
      showTapRipple(p.x, p.y);
      if (local.setSelected) local.setSelected(null);
      return;
    }
    bgTapAt = 0;
    dragBody = b;
    b.dragging = true;
    // 拖动时把左侧栏变成投放区（用户的设计：投放区与左侧栏共用）
    if (currentParentId()) local.setDropMode?.(true);
    b.hold = 0;
    holdBody = b;
    holdStart = performance.now();
    canvas.setPointerCapture?.(e.pointerId);
    canvas.classList.add('grabbing');
  }

  function onMove(e) {
    if (!dragBody || !lastPos) return;
    const p = localPos(e);
    pointerMoved += Math.abs(p.x - lastPos.x) + Math.abs(p.y - lastPos.y);
    // 移动超过一点就认为"在拖"，取消长按
    if (pointerMoved > 12 && holdBody) { holdBody.hold = 0; holdBody = null; }
    dragBody.vx = (p.x - lastPos.x) * 3;
    dragBody.vy = (p.y - lastPos.y) * 3;
    dragBody.x = p.x;
    dragBody.y = p.y;
    // 拖动时也让它有一点形变，手感更"软"
    addSquash(dragBody, 1, 0, 1, Math.min(0.12, Math.hypot(dragBody.vx, dragBody.vy) / 900));
    lastPos = p;
  }

  /**
   * 拖拽结束后的"归属判定"：放进某个气泡、或者拉出母气泡。
   *
   * 规则（用户定）：
   *   · 小的能进大的（`canNestInside`：子级必须严于父级，红>黄>绿>蓝）
   *   · **过期的紫色气泡不能进**（也不许进任何东西）→ 抖一下 + 说明原因
   *   · 子气泡拖到母气泡边界之外 → 拉出来，变成和母泡泡平级
   *     （紫色母气泡的子气泡**也允许**拉出来）
   *
   * 只在"松手"时判定，所以气泡之间日常碰撞不会误触发嵌套。
   */
  async function resolveDrop(b) {
    const parentId = currentParentId();
    const dragLevel = levelOf(b.item.event);

    // 松手位置换算成"视口坐标"（lastPos 是画布内坐标）
    const cRect = canvas.getBoundingClientRect();
    const pagePoint = lastPos ? { x: cRect.left + lastPos.x, y: cRect.top + lastPos.y } : null;
    const inDropzone = Boolean(
      pagePoint && local.dropzoneEl && hitRect(local.dropzoneEl.getBoundingClientRect(), pagePoint),
    );
    // "拖出浮动区"的另一半：松手落在浮动区之外（画布以外）
    const outsideStage = Boolean(pagePoint && (
      pagePoint.x < cRect.left || pagePoint.x > cRect.right
      || pagePoint.y < cRect.top || pagePoint.y > cRect.bottom
    ));

    // ---- 情况一：拉出去（只在容器里才谈得上"出去"）----
    // 判定标准：**拖出浮动区** —— 松手落在画布之外，或落在左侧投放区里。
    // 不做几何近似兜底（曾经按"离圆心超过 r 倍"判断，容易误触，用户不要）。
    if (parentId && (inDropzone || outsideStage)) {
      const parent = events.find((e) => e.id === parentId);
      // 目的地 = 当前容器的父级。没有父级说明已是最外层，出去就是"平级、最外层"。
      const destination = parent && parent.parentId
        ? events.find((e) => e.id === parent.parentId)
        : null;
      try {
        await store.patchEvent(b.item.event.id, { parentId: destination ? destination.id : null });
        toast({
          title: '已拉出来',
          body: destination
            ? `「${b.item.event.title}」现在和「${parent.title}」平级，都在「${destination.title}」里`
            : `「${b.item.event.title}」现在和母气泡平级`,
          timeout: 2200,
        });
      } catch (err) {
        toast({ title: '拉出失败', body: err.message, kind: 'err' });
      }
      return;
    }

    // ---- 情况二：松手时压着另一个气泡 → 试着放进去 ----
    // 注意：**任何一层都能这么干**，这才是"套娃"。在容器里拖另一个气泡压到
    // 同层的气泡上，照样要能放进去（内外逻辑一致）。
    const target = bestDropTarget(b);
    if (local.debug) {
      local.debug.lastDrop = {
        dragged: b.item.event.title,
        x: Math.round(b.x), y: Math.round(b.y), r: Math.round(b.r),
        target: target ? target.item.event.title : null,
        others: bodies.filter((o) => o !== b).map((o) => `${o.item.event.title}@${Math.round(o.x)},${Math.round(o.y)} r=${Math.round(o.r)} d=${Math.round(Math.hypot(b.x - o.x, b.y - o.y))}`),
      };
    }
    if (!target) return;
    const targetId = target.item.event.id;
    if (targetId === b.item.event.id) return;                       // 不能进自己
    if ((b.item.event.parentId || null) === targetId) return;       // 已经在这个容器里了

    const targetLevel = levelOf(target.item.event);

    // 过期（紫）气泡：既不进别人，也不装别人
    if (b.item.style.overdue || target.item.style.overdue) {
      target.shake = 1;
      toast({
        title: '紫色气泡不能套',
        body: '过期了的气泡不能放进去，也不能被放进去',
        timeout: 2200,
      });
      return;
    }

    if (!canNestInside(targetLevel, dragLevel)) {
      target.shake = 1;
      const relation = rankOf(targetLevel) <= rankOf(dragLevel)
        ? `「${target.item.event.title}」比它小，装不下`
        : '颜色层级不对';
      toast({ title: '放不进去', body: relation, timeout: 2200 });
      return;
    }

    // 还要防"套出环"：不能把气泡放进它自己的后代里
    if (isDescendantOf(targetId, b.item.event.id)) {
      target.shake = 1;
      toast({ title: '放不进去', body: '不能把气泡放进它自己的子气泡里', timeout: 2200 });
      return;
    }

    try {
      await store.patchEvent(b.item.event.id, { parentId: targetId });
      toast({
        title: '已放进气泡',
        body: `「${b.item.event.title}」→ 「${target.item.event.title}」`,
        timeout: 2000,
      });
    } catch (err) {
      target.shake = 1;
      toast({ title: '放不进去', body: err.message, kind: 'err', timeout: 4000 });
    }
  }

  /** 当前被拖的气泡"压住"了哪个气泡：优先"圆心在对方圆内"，其次重叠够多 */
  function bestDropTarget(b) {
    let byCenter = null;
    let byOverlap = null;
    let bestOverlap = 0;
    for (const o of bodies) {
      if (o === b || o.dragging) continue;
      const d = Math.hypot(b.x - o.x, b.y - o.y);
      if (d <= o.r) {
        // 圆心落在对方体内 —— 最明确的意图，取最大的那个
        if (!byCenter || o.r > byCenter.r) byCenter = o;
      }
      const overlap = b.r + o.r - d;
      if (overlap > 0 && overlap > bestOverlap) {
        bestOverlap = overlap;
        byOverlap = o;
      }
    }
    if (byCenter) return byCenter;
    // 重叠门槛：**至少盖住小球的一半**。
    // ⚠️ 原来用"重叠 ≥ 目标半径 × 0.8"，那个门槛实际上到不了：
    //    两个半径 68/77 的气泡，要重叠 61px 得几乎同心（实测圆心距 99 时只重叠
    //    46px，于是永远判不出目标，看起来就是"怎么拖都放不进去"）。
    if (byOverlap && bestOverlap >= Math.min(b.r, byOverlap.r) * 0.5) return byOverlap;
    return null;
  }

  /** target 是否是 root 的后代（防环：不能把气泡放进它自己的子气泡里） */
  function isDescendantOf(targetId, rootId) {
    const byId = new Map(events.map((e) => [e.id, e]));
    let cur = byId.get(targetId);
    let guard = 0;
    while (cur && guard < 64) {
      if (cur.parentId === rootId) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
      guard += 1;
    }
    return false;
  }

  function onUp() {
    canvas.classList.remove('grabbing');
    if (holdBody) { holdBody.hold = 0; holdBody = null; }

    // ---- 点在背景上：单击 = 加子气泡，双击 = 出去 ----
    //
    // ⚠️⚠️ 这里原来写的是 `moved < 8 && performance.now() - bgTapAt < 400`
    //     —— **按住的时长不超过 400 毫秒**才算"轻点"。这就是 iPad 上
    //     "单击母气泡背景想加子泡泡，一点反应都没有"的根因：
    //       · 鼠标点一下是瞬时事件（几十毫秒），永远过关
    //       · **手指按在玻璃上的时长普遍在 100–300ms，犹豫一下/等反馈就超过 400ms**
    //       · 超过就 `return` —— 不报错、不提示、什么都不发生，用户只能看到"无响应"
    //     而且前半句其实**恒等于 0**：背景这一支不会设 dragBody，`onMove` 直接 return，
    //     `lastPos` 永远等于按下时的 `bgTapPos` —— 所以这就是一个纯粹的时长闸门。
    //
    //     修法（有依据，不是调参数）：**背景上没有"长按"这个手势**（长按戳破只对气泡有效），
    //     所以时长不携带任何信息，只有"移动了多远"才有意义 —— 拖动才是另一种意图。
    //     于是判据改成只看位移（12px 容手指抖动），时长不再参与。
    if (!dragBody && bgTapAt) {
      const moved = Math.hypot(lastPos.x - bgTapPos.x, lastPos.y - bgTapPos.y);
      const isTap = moved < 12;
      bgTapAt = 0;
      if (!isTap) return;
      handleBackgroundTap();
      return;
    }

    if (!dragBody) return;
    const b = dragBody;
    b.dragging = false;
    dragBody = null;
    local.setDropMode?.(false);
    // ⚠️ 气泡这一支同理：400ms 对**手指**太短了。长按戳破是 2.5 秒（LONG_PRESS_MS），
    //    而且真戳破之后 dragBody 已被清空、根本走不到这里，所以这里的时间闸门
    //    只要卡在"不是长按"就够 —— 取长按时长的一半，给手指留足余量。
    const quick = pointerMoved < 8 && performance.now() - pointerDownAt < LONG_PRESS_MS * 0.5;

    // 拖过又松手（不是轻点）→ 判定"放进哪个气泡 / 是否拉出母气泡"。
    // 只在松手时判定，所以气泡日常互相碰撞不会误触发嵌套。
    if (!quick) {
      void resolveDrop(b);
      return;
    }

    // 单击 vs 双击：等一个"双击窗口"再决定，避免单击被双击抢掉
    const now = performance.now();
    if (lastTapKey === b.key && now - lastTapTime < 320) {
      clearTimeout(tapTimer);
      lastTapKey = null;
      tryEnterBubble(b);                   // 双击 = 进入气泡
      return;
    }
    lastTapKey = b.key;
    lastTapTime = now;
    if (local.setSelected) {
      local.setSelected({ bubble: b, item: b.item, canvasW: width, canvasH: height });
    }
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      if (lastTapKey !== b.key) return;
      lastTapKey = null;
      ctx.editEvent?.(b.item.event);       // 单击 = 编辑
    }, 330);
  }

  /**
   * 背景被点击（背景 = 当前这一层的"母气泡"，最外层则是没有母气泡的空白）。
   *
   * 用户要的语义：**双击母气泡 = 拉近镜头**，进去之后背景还是那个母气泡，所以
   *   · 双击背景 = 再双击一次母气泡 = 拉远镜头（出去）
   *   · 单击背景 = 点到了母气泡本身 = 往它里面加子气泡
   * 最外层没有母气泡，于是"单击空白 = 新建一条日程"——
   * 这样带子和不带子的气泡区行为一致（用户要求把 ＋ 按钮撤掉换成这个）。
   *
   * 两种操作靠双击窗口区分，否则"单击新建"会把"双击出去"抢掉。
   */
  function handleBackgroundTap() {
    const containerId = currentParentId();
    const now = performance.now();
    if (bgLastTap && now - bgLastTap < 330) {
      // 双击背景：在容器里就是出去；最外层没有上一层，忽略
      bgLastTap = 0;
      clearTimeout(bgTapTimer);
      if (containerId) exitOneLevel(ctx);
      return;
    }
    bgLastTap = now;
    clearTimeout(bgTapTimer);
    bgTapTimer = setTimeout(() => {
      bgLastTap = 0;
      if (containerId) {
        // ⚠️ 紫色（过期）容器**只读**：能进去看，但不能往里加子泡泡。
        //    过期意味着这件事翻篇了，还往上挂新东西没有意义（用户明确要求）。
        //
        // ⚠️⚠️ 这里原来写的是 `ctx.toast?.({...})` —— 而 app.js 的 `ctx` 上
        //    **根本没有 `toast` 这个属性**，`?.` 于是**静默跳过**：
        //    结果"过期容器不加泡泡"这条规矩**挡住了操作、却一句话都不说**，
        //    用户看到的就是"点了没反应"。这跟 `state` 那个 bug 是同一类：
        //    **`?.` 用在"其实不存在"的东西上 = 把错误藏起来**。
        //    直接用本文件顶部 import 进来的 `toast()`（文件里其它地方都这么用）。
        if (local.isOverdueContainer?.()) {
          toast({
            title: '紫泡泡不能再加泡泡了哦·-·',
            body: '过期了，只能看看',
            timeout: 2000,
          });
          return;
        }
        ctx.addChild?.(containerId);                    // 容器里：加子气泡
      } else {
        ctx.newEventAt?.(new Date());                    // 最外层：新建日程
      }
    }, 340);
  }

  /**
   * 双击进入气泡。
   *
   * ⚠️ 等级必须用 `levelOf()`（core/urgency.js）解析，**不能读原始的 `event.level`**：
   * 旧数据只有 `magnitude`（1–100）没有 `level`，读原始字段会得到 undefined，
   * 再 `|| 'sky'` 兜底就变成"蓝色" —— 于是**红色/紫色的旧气泡双击也提示"蓝色进不去"**
   * （用户实测报的就是这个）。渲染那条路走的是 `levelOf()`，所以颜色是对的，
   * 两条路径不一致才暴露出这个 bug。
   *
   * 注意：**过期的泡泡是可以打开的**（用户明确）—— 只有"蓝色档"打不开。
   * 过期只是不能再往里放东西，不影响进去看。所以这里不判 overdue。
   *
   * 空容器**也允许进去**（用户要求）：进去之后背景就是母气泡，
   * 单击背景可以往里加子气泡。
   */
  function tryEnterBubble(b) {
    const levelKey = levelOf(b.item.event);
    if (isLeafLevel(levelKey)) {
      b.shake = 0.9;
      toast({ title: '元泡泡无法添加泡泡了哦·-·', body: '最小档的泡泡装不下东西，双击只抖一下', timeout: 1800 });
      return;
    }
    enterBubble(b.item.event.id, ctx);
  }

  /** 长按进度：在主循环里推进，到 2.5 秒就戳破 */
  function stepHold(dtMs) {
    void dtMs;
    if (!holdBody || !holdBody.dragging) return;
    holdBody.hold = Math.min(1, (performance.now() - holdStart) / LONG_PRESS_MS);
    if (holdBody.hold >= 1) {
      const b = holdBody;
      holdBody = null;
      b.hold = 0;
      b.dragging = false;
      dragBody = null;
      canvas.classList.remove('grabbing');
      popBubble(b);
    }
  }

  /** 戳破：调服务端（会释放直接子级），成功后刷新视图 */
  async function popBubble(b) {
    try {
      // **按实例记账**：带上这次发生的日期和"戳破那一刻还剩多久"。
      // 服务端算不出这一次的剩余时间（那要用 occurrenceDeadline），所以由前端传。
      // 重复事件只会结束这一颗（下周照常新生）；非重复事件仍然整条完成。
      const res = await store.popEvent(b.item.event.id, {
        occurrence: b.item.start instanceof Date ? b.item.start.toISOString() : b.item.start,
        remainingMs: b.style && Number.isFinite(b.style.remaining) ? b.style.remaining : null,
      });
      const n = (res && res.released) ? res.released.length : 0;
      const isInstance = res && res.mode === 'instance';
      toast({
        title: `戳破了「${b.item.event.title}」`,
        body: n
          ? `放出了 ${n} 个里面的气泡`
          : (isInstance ? '这一颗算完成了，下次还会新生' : '这件事算完成了'),
        timeout: 2000,
      });
    } catch (err) {
      toast({ title: '戳破失败', body: err.message, kind: 'err' });
    }
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  // 双击空白处 = 新建
  canvas.addEventListener('dblclick', (e) => {
    const p = localPos(e);
    if (!pick(p.x, p.y)) ctx.newEventAt(new Date());
  });

  const ro = new ResizeObserver(() => { resize(); applySizes(); clampAll(); });
  ro.observe(canvas.parentElement);
  resize();
  applySizes();   // 必须在 scatter 之前：半径决定了随机散布的边距
  scatter();
  resetRequested = false;
  raf = requestAnimationFrame(frame);

  const onVisibility = () => { last = performance.now(); };
  document.addEventListener('visibilitychange', onVisibility);

  return function stop() {
    cancelAnimationFrame(raf);
    clearTimeout(tapTimer);
    ro.disconnect();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// ---------- 过期气泡的刺 ----------
/**
 * 过期未戳破的气泡：沿泡壁**向内**长一圈尖刺。
 *
 * 形状：以泡壁为底、向圆心方向收成一个尖，所以看起来是"从壁里扎进来"。
 * 刺用暗紫渐变，越靠尖越深，和变紫的泡体是一个色系。
 */
// ---------- 节日泡泡的背景图案 ----------
//
// 图案本体（月亮/灯笼/粽子/雪花…）在 `core/festival-art.js` 里，是一串**形状清单**；
// 这里只负责按泡泡半径缩放、裁成圆形、压低透明度画上去。
//
// 为什么要压透明度：这些图案是**背景**，泡泡上还有标题、倒计时、剩余天数三行字。
// 图案一浓，文字就读不清了（用户最在意的是"还剩几天"能不能一眼看到）。
// 所以：图案整体只有 ~40% 的存在感，而且永远画在文字下面。
const FESTIVAL_ART_ALPHA = 0.42;
/** 图案画挂了只报一次（每帧都报会把控制台刷爆，反而找不到别的问题） */
let artDrawWarned = false;

/** 用户自己那张图的解码缓存（data URL → Image）。解码是异步的，先画别的，加载好下一帧自然就出现。 */
const artImageCache = new Map();

function artImageFor(src) {
  if (artImageCache.has(src)) return artImageCache.get(src);
  const img = new Image();
  // ⚠️ 只认 data:（自己在设置里压好的图）。外链图片在离线/平板上会变白框，不许用。
  img.src = src;
  artImageCache.set(src, img);
  return img;
}

/**
 * 画节日图案。坐标是 **100×100 的方框**，映射到泡泡内切圆的 ~86%。
 * @param {CanvasRenderingContext2D} ctx2d
 * @param {{x:number,y:number}} b 泡泡中心
 * @param {number} r 泡泡半径
 * @param {string} key 节日 key
 * @param {object} customArt `settings.festivalArt`
 * @param {number} alpha 泡泡整体的透明度（done/dimmed 的泡泡图案也要跟着淡）
 */
function drawFestivalArt(ctx2d, b, r, key, customArt, alpha) {
  const art = festivalArt(key, { customArt });
  const s = ((r * 2) / 100) * 0.86;
  const x0 = b.x - 50 * s;
  const y0 = b.y - 50 * s;

  ctx2d.save();
  // 裁成圆形：图案绝不允许溢出泡泡（溢出就成了"贴纸跑了"，一眼难看）
  ctx2d.beginPath();
  ctx2d.arc(b.x, b.y, r * 0.985, 0, Math.PI * 2);
  ctx2d.clip();
  ctx2d.globalAlpha = FESTIVAL_ART_ALPHA * alpha;

  if (art.image) {
    const img = artImageFor(art.image);
    if (img && img.complete && img.naturalWidth) {
      // 自定义图片：按"填满圆形"（cover）画，不然一张竖图会被拉扁
      const side = r * 2;
      const ratio = Math.max(side / img.naturalWidth, side / img.naturalHeight);
      const w = img.naturalWidth * ratio;
      const h = img.naturalHeight * ratio;
      ctx2d.drawImage(img, b.x - w / 2, b.y - h / 2, w, h);
    }
  } else {
    for (const sh of art.shapes) {
      ctx2d.globalAlpha = FESTIVAL_ART_ALPHA * alpha * (sh.a === undefined ? 1 : sh.a);
      ctx2d.fillStyle = sh.color;
      if (sh.t === 'c') {
        ctx2d.beginPath();
        ctx2d.arc(x0 + sh.x * s, y0 + sh.y * s, Math.max(0.5, sh.r * s), 0, Math.PI * 2);
        ctx2d.fill();
      } else if (sh.t === 'e') {
        ctx2d.beginPath();
        ctx2d.ellipse(x0 + sh.x * s, y0 + sh.y * s, Math.max(0.5, sh.rx * s), Math.max(0.5, sh.ry * s),
          ((sh.rot || 0) * Math.PI) / 180, 0, Math.PI * 2);
        ctx2d.fill();
      } else if (sh.t === 'l' && sh.pts && sh.pts.length >= 2) {
        // 折线（描边）：灯笼的金带、柳枝、雪花的轴都是它。圆头，不然一根根都像针。
        ctx2d.strokeStyle = sh.color;
        ctx2d.lineWidth = Math.max(0.6, (sh.w || 3.6) * s);
        ctx2d.lineCap = 'round';
        ctx2d.lineJoin = 'round';
        ctx2d.beginPath();
        ctx2d.moveTo(x0 + sh.pts[0][0] * s, y0 + sh.pts[0][1] * s);
        for (let i = 1; i < sh.pts.length; i += 1) ctx2d.lineTo(x0 + sh.pts[i][0] * s, y0 + sh.pts[i][1] * s);
        ctx2d.stroke();
      } else if (sh.t === 'p' && sh.pts && sh.pts.length) {
        ctx2d.beginPath();
        ctx2d.moveTo(x0 + sh.pts[0][0] * s, y0 + sh.pts[0][1] * s);
        for (let i = 1; i < sh.pts.length; i += 1) ctx2d.lineTo(x0 + sh.pts[i][0] * s, y0 + sh.pts[i][1] * s);
        ctx2d.closePath();
        ctx2d.fill();
      }
    }
  }
  ctx2d.restore();
}

/**
 * 泡泡轮廓（含形变）的公共路径 —— **绘制里所有椭圆都走这一条**。
 *
 * 为什么抽出来：以前这句 `ctx.ellipse(b.x + shakeX, b.y, r*scalePerp*scale, ...)`
 * 在绘制代码里重复了 6 次，每处都自带一次"位置 + 半径 + 形变"的乘法。
 * 那种重复正是"某一处漏了兜底就整帧炸"的温床；现在坐标全部来自 `drawNumbersOf`
 * （core 里逐字段兜过底），这里只做一次乘。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} v `drawNumbersOf` 的 values
 * @param {number} scale 额外的缩放（正常都是 1）
 */
function ellipsePath(ctx, v, scale) {
  ctx.beginPath();
  ctx.ellipse(
    v.drawX, v.y,
    v.r * v.scalePerp * scale, v.r * v.scaleAlong * scale,
    v.theta, 0, Math.PI * 2,
  );
}

function drawOverdueSpikes(ctx2d, b, v) {
  const n = OVERDUE_SPIKES;
  const r = v.r;
  const theta = v.theta;
  // ⚠️ 半径/内圈半径全部来自 drawNumbersOf（它在 core 里被 tools/bubble-finite.test.mjs
  //    逐字段钉住"必须是有限数"）。这里再就地算一次 `r * (1 - LEN)` 就等于又开了一个
  //    "一个字段坏了就整帧抛非有限"的口子 —— 这次事故的教训就是别再这么写。
  const inner = v.spikeInnerR;
  const spike = ctx2d.createRadialGradient(v.x, v.y, inner, v.x, v.y, v.spikeOuterR);
  spike.addColorStop(0, hexToRgba(OVERDUE_EDGE, 0.05));
  spike.addColorStop(0.55, hexToRgba(OVERDUE_COLOR, 0.55));
  spike.addColorStop(1, hexToRgba(OVERDUE_EDGE, 0.95));
  ctx2d.fillStyle = spike;

  for (let i = 0; i < n; i += 1) {
    // 让刺跟着气泡的形变一起拉长/压扁（角度与泡体一致）
    const a = theta + (i / n) * Math.PI * 2;
    const halfW = v.spikeHalfW;
    const tipX = v.x + Math.cos(a) * inner;
    const tipY = v.y + Math.sin(a) * inner;
    const baseX = v.x + Math.cos(a) * r;
    const baseY = v.y + Math.sin(a) * r;
    const px = -Math.sin(a) * halfW;
    const py = Math.cos(a) * halfW;

    ctx2d.beginPath();
    ctx2d.moveTo(baseX + px, baseY + py);
    ctx2d.lineTo(tipX, tipY);
    ctx2d.lineTo(baseX - px, baseY - py);
    ctx2d.closePath();
    ctx2d.fill();
  }
}

// ---------- 小工具 ----------
function addSquash(b, sign, nx, ny, amount) {
  if (amount <= 0) return;
  const dir = sign >= 0 ? 1 : -1;
  b.nx = nx * dir;
  b.ny = ny * dir;
  // 取最大值而不是累加，避免密集碰撞时形变叠加到夸张
  const capped = Math.min(SQUASH_MAX, amount);
  b.squash = Math.max(b.squash, capped);
  b.squashVel = Math.max(b.squashVel, capped * 3);
}

// 线性混合两色、以及 rgbOf —— 都搬到 core/palette.js 了（桌面泡泡要画同一个"泡体"，
// 两边混色的配方必须一样：往白里混 42% 当受光面、往深里混 45% 当背光面）。
//
// 让 tierByKey 的导出被使用（lint 友好 + 供未来扩展）
export { tierByKey };
