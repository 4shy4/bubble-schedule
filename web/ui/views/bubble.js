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
import { el, mount } from '../dom.js';
import { expandRange, applyPeriodLimit } from '../../../core/recurrence.js';
// 「到期/过期」只有一个定义在 core/state-ops.js（方案 C：到期 = 结束时间）
import * as stateOps from '../../../core/state-ops.js';
import { addDays, asDate, hhmm, startOfDay, toDateKey } from '../../../core/time.js';
import {
  URGENCY_TIERS, tierByKey, tierFill, tierTextColor,
  radiusRangeForCanvas, areaScaleForCanvas, RADIUS_MIN_FLOOR,
  hexToRgba, luminance,
} from '../../../core/palette.js';
import { bubbleStyle, levelOf } from '../../../core/urgency.js';
import {
  LEVELS, levelByKey, canNestInside, allowedChildLevels, isLeafLevel, rankOf,
} from '../../../core/level.js';
import { formatRemaining } from '../../../core/countdown.js';
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
const OVERDUE_COLOR = '#5b2a6e';      // 暗紫
const OVERDUE_EDGE = '#7c3aed';
const OVERDUE_SPIKES = 13;            // 一圈多少根刺
const OVERDUE_SPIKE_LEN = 0.16;       // 刺长（相对半径）

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
    const pickChip = el('span.bubble-hud-chip.muted', { text: hudHint(state) });
    const tally = el('span.bubble-hud-chip.muted');
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
    const stage = el('div.bubble-stage', {}, [canvas, insideHint, hud, panel, dropzoneEl]);
    const legend = el('div.bubble-legend');

    // 进入气泡后：容器变成这层画布的背景色（视觉上"我们在这个气泡里面"）
    applyStageBackground(stage, state);

    const local = { selected: null, panel, legend, config, pickChip, setDropMode, dropzoneEl };
    renderPanel(panel, legend, config, ctx, local);

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
  const ids = new Set((events || []).map((e) => e.id));
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
    horizonDays: Number(localStorage.getItem(HORIZON_KEY) || 14),
    showDone: localStorage.getItem(SHOW_DONE_KEY) === '1',
    // 没设过就是显示（保持老行为）
    showCourse: localStorage.getItem(SHOW_COURSE_KEY) !== '0',
  };
}

/**
 * 实例账本的键（'YYYY-MM-DD'，**本地**日期）。
 *
 * ⚠️ 必须和服务端 `store.occurrenceKey` 用同一套（本地日期，不是 UTC）。
 *    用 `toISOString().slice(0,10)` 会在东八区把"周一早上 7 点"算成前一天。
 */
function occurrenceKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 这个事件是不是"重复事件"。
 *
 * ⚠️ 不能只看 `freq !== 'none'` 就下结论：单次日程的 `recurrence.freq` 是 `'none'`，
 * 但课表课程用的是 `weeks`（没有 freq）。两者都要算"会展开出多个实例"。
 * 只有**会展开出多个实例**的事件才需要在气泡上标"周几"。
 */
function isRepeating(ev) {
  if (!ev) return false;
  const rec = ev.recurrence || {};
  if (rec.freq && rec.freq !== 'none') return true;
  if (Array.isArray(ev.weeks) && ev.weeks.length) return true;
  return false;
}

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
  const now = new Date();
  const from = startOfDay(now);
  const to = addDays(from, config.horizonDays);
  const parentId = currentParentId();

  // 套娃：只显示"当前容器里的气泡"。最外层只显示没有父级的。
  // 注意容量：容器里也可能有很多条，仍受 horizonDays 限制（当前层用的是各自的时间窗口）。
  let visible = state.events.filter((ev) => (ev.parentId || null) === parentId);

  // 课程是周期性的：一学期几十节，全丢进气泡区会挤爆、还到处乱蹦。
  // 勾掉就用气泡区只管"临时事务"（用户的原话：气泡区更像临时性时间缓冲区）。
  if (!config.showCourse) {
    visible = visible.filter((ev) => ev.type !== 'course');
  }

  // ---- 展开窗口 ----
  //
  // ⚠️ 起点必须**往前推**，不能是"今天 0 点"。
  //    用户要的是"没戳破的旧实例一直留着当紫泡泡（癌细胞）" ——
  //    如果只从今天开始展开，历史实例根本不会生成，"堆积"就看不见了。
  //
  // 上限 180 天：免得一个很老的日级事件展开出上千个实例。
  // 早于**事件自身开始时间**的实例在下面被丢掉（那时它还不存在）。
  const LOOKBACK_DAYS = 180;
  const raw = expandRange(
    visible,
    new Date(from.getTime() - LOOKBACK_DAYS * 86_400_000),
    // 未来窗口也用**用户选的范围**（那是"预览多远"，不是过滤器）
    new Date(to.getTime() - 1),
    state.settings.termStart,
    (ev) => config.showDone || !ev.done,
  );

  // 丢掉"早于事件自身开始时间"的实例 —— 展开是往前推的，会生成那时还不存在的实例。
  const all = raw.filter((it) => {
    const evStartMs = asDate(it.event.start).getTime();
    return !Number.isFinite(evStartMs) || it.start.getTime() >= evStartMs - 60_000;
  });

  // ---- 「周期」筛选（用户要的自由度）：只留「第一颗 + 周期」以内的 ----
  //
  // 用户原话："对于重复泡泡，用户可选择一个周期（最新任务时间加周期 = 实际显示时间）：
  //  若泡泡为周级、每周一，周期 3 天，任务还剩四天，原本有俩泡泡（剩四天、剩十一天），
  //  加周期后第二个就没了；周期改成 8 天又会出来。"
  //
  // ⚠️ 位置很重要：必须放在下面那个"最多当前+预备两颗"**之前**。
  //    否则"周期"只是把本来就只有两颗的列表再筛一遍，
  //    而用户要的正是"把预备那颗也筛掉" —— 那正是这里的第二颗。
  // ⚠️ 必须把 `now` 传进去：锚点 = "第一个**未来**的实例"。
  //    不传的话它会用真实时间，而这个函数上面已经算好了一个 `now`
  //    （两者在真实运行时几乎一样，但测试/回放时会分叉）。
  const limited = applyPeriodLimit(all, now);

  // ---- 重复事件：最多浮"当前 + 预备"两颗（约束**未来**，不约束历史）----
  //
  // 用户原话："我觉得只浮当前与预备两颗（10.5 不浮），当然如果提前完成任务，
  //            那么 10.5 该浮，逻辑是最多浮两颗"
  //   · 未来的实例：只留最近的两颗（还没开始的）
  //   · 过去的实例：**全部留下**（没戳破就是欠账，攒着才警醒）
  //   · 提前完成当前那颗 → 它进回收站，预备那颗自动变成"当前"，
  //     再下一颗补上"预备"位 —— 因为"未来取前两个"是滑动窗口，自动满足
  const byEvent = new Map();
  for (const it of limited) {
    const list = byEvent.get(it.event.id) || [];
    list.push(it);
    byEvent.set(it.event.id, list);
  }
  const keepFutureIds = new Set();
  for (const list of byEvent.values()) {
    list.sort((a, b) => a.start - b.start);
    const upcoming = list.filter((it) => it.start.getTime() > now.getTime());
    for (const it of upcoming.slice(0, 2)) keepFutureIds.add(it.key);
  }

  const seen = new Set();
  const out = [];
  // 遍历 `limited`（已经过周期筛选）—— 下面所有"要不要浮"的判断都基于它
  for (const item of limited) {
    const key = item.event.id + '@' + toDateKey(item.start);
    if (seen.has(key)) continue;

    // 已经被戳破的这一颗 → 不再出现在气泡区（它进了回收气泡站）。
    // 这是**按实例记账**的落点：重复事件只结束被戳的那一颗，其他颗照常新生。
    // 非重复事件走老路（`done`），过滤器 `showDone || !ev.done` 已经挡掉了。
    const poppedMap = item.event.popped;
    if (poppedMap && typeof poppedMap === 'object' && poppedMap[occurrenceKeyOf(item.start)]) continue;

    // 未来实例：只保留"当前 + 预备"两颗
    const isUpcoming = item.start.getTime() > now.getTime();
    if (isUpcoming && !keepFutureIds.has(item.key)) continue;

    seen.add(key);
    // 母气泡过期时，子气泡也跟着变紫（用户要求），所以要把"祖先里有没有过期的"传下去
    const style = bubbleStyle(item, {
      now,
      forceOverdue: isOverdueEvent(item.event, state.events, now),
      // 重复事件才显示"周几"（单次日程显示是噪音）
      showWeekday: isRepeating(item.event),
    });

    // 「时间范围」不再是过滤器，而是**预览范围**：
    // 超出范围（用户选 14 天，那就是 14 天以后）的实例**仍显示，但虚化**。
    // 用户原话："将筛选改为预览模式，不应用，只用于筛选气泡时间（14 天后的任务虚化）"
    // 它只对**未来**有意义（历史实例是"欠账"，虚化掉就看不见堆积了）。
    const beyondPreview = isUpcoming && item.start.getTime() > to.getTime();
    if (beyondPreview) style.dimmed = true;
    out.push({ ...item, style, key });
  }
  // 越接近截止的越先画（画在下面），所以"马上到期"的会更靠视觉中心。
  // 没设期限的排最后（不参与紧迫度排序）。
  out.sort((a, b) => {
    const ra = a.style.remaining == null ? Number.MAX_SAFE_INTEGER : a.style.remaining;
    const rb = b.style.remaining == null ? Number.MAX_SAFE_INTEGER : b.style.remaining;
    return rb - ra;
  });
  return out;
}

// ---------- 说明面板（含少量设置）----------
// 面板默认隐藏（气泡区全屏展示），点 HUD 上的 ? 才出现。
// 内容是"解释这个界面"：颜色、大小、操作、套娃规则。
function renderPanel(host, legendHost, config, ctx, local) {
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
    if (local.pickChip) {
      local.pickChip.textContent = sel
        ? `${sel.item.event.title} · ${sel.item.style.countdownText}`
        : hudHint(state);
      local.pickChip.classList.toggle('muted', !sel);
    }
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
      el('div.spacer'),
      el('button.btn.btn-sm', {
        text: config.showDone ? '隐藏已完成' : '显示已完成',
        onclick: () => { localStorage.setItem(SHOW_DONE_KEY, config.showDone ? '0' : '1'); rerender(); },
      }),
      el('button.btn.btn-sm', { text: '重排', onclick: () => { resetRequested = true; rerender(); } }),
    ]),
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
function startSimulation({ canvas, items, config, ctx, local, events = [] }) {  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return () => {};

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let width = 0;
  let height = 0;
  let raf = 0;
  let last = performance.now();
  let time = 0;

  const bodies = items.map((item, i) => {
    const r = item.style.radius;
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
  function draw() {
    ctx2d.clearRect(0, 0, width, height);

    // 说明：这里**不画**母气泡边界虚线圈（用户明确说不好看）。
    // "离开容器"改由"拖到左侧栏"完成 —— 左侧栏在拖动时会变成投放区。

    for (const b of bodies) {
      const st = b.item.style;
      const tier = st.tier;
      const isSelected = local.selected && local.selected.bubble === b;
      // 已完成的（done）最淡；其次是"超出预览范围"的（用户选 14 天 → 14 天后的，虚化预告）
  const alpha = st.done ? 0.34 : (st.dimmed ? 0.42 : 0.88);
      const r = b.r;

      // 过期未戳破：定点不动、颜色变暗紫、向内长一圈刺（用户指定的表现）
      //
      // ⚠️ 这里必须区分两种"过期"，否则文字和颜色会互相矛盾（用户报的 bug）：
      //   · **自己过期**（ownOverdue）→ 整颗变暗紫 + 长刺（原样保留）
      //   · **只有祖先过期**（overdueInherited）→ **保持自己的等级颜色**，
      //     另画一圈暗紫虚线环表示"它所在的容器过期了"。
      //   原来两者都整颗变紫，于是"剩余 3 天"的泡泡看着像已经废了。
      const overdue = !!st.overdue;
      const ownOverdue = !!st.ownOverdue;
      const inheritedOverdue = overdue && !ownOverdue;

      // 形变：沿法线压扁、垂直方向拉长（面积近似守恒）。
      // 上限压得很紧（0.2），所以视觉上只是"微微挤一下"，不会变成橡皮球。
      const s = clamp(b.squash, -SQUASH_MAX, SQUASH_MAX);
      const scaleAlong = clamp(1 - s, 0.78, 1.22);
      const scalePerp = clamp(1 + s * 0.8, 0.8, 1.2);
      const theta = Math.atan2(b.ny, b.nx);

      // 被撞/被长按时抖一下（过期气泡"扎手"的反馈）
      const shakeAmt = b.shake > 0 ? b.shake * 2.2 : 0;
      const shakeX = shakeAmt ? Math.sin(performance.now() * 0.05) * shakeAmt : 0;

      const ellipse = (ctx, scale) => {
        ctx.beginPath();
        ctx.ellipse(
          b.x + shakeX, b.y,
          r * scalePerp * scale, r * scaleAlong * scale,
          theta, 0, Math.PI * 2,
        );
      };

      // ---------------------------------------------------------------------
      // 真气泡的画法（参考 glassmorphism / 玻璃折射的通行做法）：
      //   1) 软外晕          —— 把气泡"垫"在背景上
      //   2) 受光的球体      —— 左上亮、右下暗；外轮廓留一圈色，否则会糊
      //   3) 边缘光带        —— 很薄的一圈浅色渐变，不是实心粗亮环
      //   4) 镜面轮廓光      —— 偏一侧的弧形亮带 + 背光侧浅暗边 = 体积感
      //   5) 双高光          —— 一个大的柔光斑 + 一个很小的细点（真实反射）
      //   6) 底部内暗影      —— 圆的下缘积暗，立体感
      //   7) 文字            —— 淡暗色垫片 + 柔和描边，保证半透明底上的可读性
      // ---------------------------------------------------------------------
      const tierC = ownOverdue ? OVERDUE_COLOR : tier.color;
      // 光从左上打进来：所有高光/明暗都按这个方向排布，泡泡才有"球"的感觉
      const lx = b.x - r * 0.32;
      const ly = b.y - r * 0.38;
      const ldx = -Math.SQRT1_2;
      const ldy = -Math.SQRT1_2;
      const litC = mixColor(tierC, '#ffffff', 0.42);
      const bodyC = mixColor(tierC, '#ffffff', 0.06);
      const shadowC = mixColor(tierC, '#0b1220', 0.45);

      // 0) 过期的刺：从泡壁**向内**长一圈尖刺（用户要求"向内长出一圈刺"）。
      //    先画，后面泡体盖上去，只留刺尖露在泡内，看起来是扎进泡里的。
      //    只有「自己过期」才长刺 —— 容器过期的那颗自己还没到期，不该被刺。
      if (ownOverdue) drawOverdueSpikes(ctx2d, b, r, theta);

      // 1) 软外晕
      const glowScale = 1.16 + (st.level ? st.level.rank : 0) / 40;
      const glow = ctx2d.createRadialGradient(b.x, b.y, r * 0.7, b.x, b.y, r * glowScale);
      glow.addColorStop(0, hexToRgba(tierC, 0.16 * alpha));
      glow.addColorStop(1, hexToRgba(tierC, 0));
      ctx2d.fillStyle = glow;
      ctx2d.beginPath();
      ctx2d.arc(b.x, b.y, r * glowScale, 0, Math.PI * 2);
      ctx2d.fill();

      // 2) 泡体：左上偏亮、右下偏深。外轮廓要有一圈色，但只能**很薄的一圈**：
      //    圈一厚就变成"透镜/按钮"，而不是泡（真机放大后就是这个观感）。
      const body = ctx2d.createRadialGradient(lx, ly, r * 0.04, b.x, b.y, r * 1.03);
      body.addColorStop(0.00, hexToRgba(litC, 0.30 * alpha));
      body.addColorStop(0.42, hexToRgba(bodyC, 0.17 * alpha));
      body.addColorStop(0.80, hexToRgba(tierC, 0.24 * alpha));
      body.addColorStop(0.97, hexToRgba(shadowC, 0.34 * alpha));
      body.addColorStop(1.00, hexToRgba(shadowC, 0.10 * alpha));
      ellipse(ctx2d, 1);
      ctx2d.fillStyle = body;
      ctx2d.fill();

      // 3) 边缘光带：更薄、更淡的一圈浅色渐变（原来 0.93R/0.38 偏重，会形成双环）。
      const rim = ctx2d.createRadialGradient(b.x, b.y, r * 0.74, b.x, b.y, r * 1.0);
      rim.addColorStop(0.00, hexToRgba(litC, 0));
      rim.addColorStop(0.80, hexToRgba(litC, 0.03 * alpha));
      rim.addColorStop(0.95, hexToRgba(litC, 0.20 * alpha));
      rim.addColorStop(1.00, hexToRgba(litC, 0.03 * alpha));
      ellipse(ctx2d, 1);
      ctx2d.fillStyle = rim;
      ctx2d.fill();

      // 4) 被照亮那一侧的轮廓光：偏左上的一段弧，是玻璃感的主要来源。
      ctx2d.beginPath();
      ctx2d.ellipse(b.x, b.y, r * 0.955 * scalePerp, r * 0.955 * scaleAlong, theta, 0, Math.PI * 2);
      ctx2d.lineWidth = Math.max(1.1, r * 0.030);
      ctx2d.lineCap = 'round';
      const arcA = Math.atan2(ldy, ldx);
      const arc = Math.PI * 1.05;
      const rimLight = ctx2d.createLinearGradient(
        b.x + Math.cos(arcA) * r, b.y + Math.sin(arcA) * r,
        b.x - Math.cos(arcA) * r, b.y - Math.sin(arcA) * r,
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
        b.x + Math.cos(arcA + Math.PI) * r, b.y + Math.sin(arcA + Math.PI) * r,
        b.x - Math.cos(arcA + Math.PI) * r, b.y - Math.sin(arcA + Math.PI) * r,
      );
      shadowArc.addColorStop(0.00, 'rgba(11,18,32,0)');
      shadowArc.addColorStop(0.16, `rgba(11,18,32,${0.20 * alpha})`);
      shadowArc.addColorStop(0.46, 'rgba(11,18,32,0)');
      shadowArc.addColorStop(1.00, 'rgba(11,18,32,0)');
      ctx2d.strokeStyle = shadowArc;
      ctx2d.beginPath();
      ctx2d.ellipse(b.x, b.y, r * 0.90 * scalePerp, r * 0.90 * scaleAlong, theta,
        arcA + Math.PI - arcBack, arcA + Math.PI + arcBack);
      ctx2d.stroke();
      ctx2d.lineCap = 'butt';

      // 5) 高光：真气泡上的反射**没有边界**。
      //    v2 用"压扁的圆"画，被拉长的那个圆其边缘曲率跟着变形，看起来就是一片
      //    贴在泡上的椭圆色块（真机上一眼假）。这里改成**纯粹由渐变构成的亮度场**：
      //    只有圆心和径向衰减，没有"块的轮廓"。
      //    位置也必须挪到 **0.74R 的贴边处**：文字的排版块会占到 ±0.36R，
      //    高光放在泡中央会正好压在字上（真机实测就是这个问题）。
      const gx = b.x - r * 0.523;
      const gy = b.y - r * 0.523;

      const glint = ctx2d.createRadialGradient(gx, gy, 0, gx, gy, r * 0.34);
      glint.addColorStop(0.00, `rgba(255,255,255,${(st.done ? 0.05 : 0.16) * alpha})`);
      glint.addColorStop(0.45, `rgba(255,255,255,${(st.done ? 0.02 : 0.07) * alpha})`);
      glint.addColorStop(1.00, 'rgba(255,255,255,0)');
      ctx2d.beginPath();
      ctx2d.arc(gx, gy, r * 0.34, 0, Math.PI * 2);
      ctx2d.fillStyle = glint;
      ctx2d.fill();

      const spark = ctx2d.createRadialGradient(gx, gy, 0, gx, gy, r * 0.07);
      spark.addColorStop(0.00, `rgba(255,255,255,${(st.done ? 0.12 : 0.26) * alpha})`);
      spark.addColorStop(0.50, `rgba(255,255,255,${(st.done ? 0.04 : 0.09) * alpha})`);
      spark.addColorStop(1.00, 'rgba(255,255,255,0)');
      ctx2d.beginPath();
      ctx2d.arc(gx, gy, r * 0.07, 0, Math.PI * 2);
      ctx2d.fillStyle = spark;
      ctx2d.fill();

      // 5b) 非常淡的中央亮场：不是为了"高光"，是为了让泡体有个球心，
      //     否则去掉那团假高光之后泡面会显得平。半径大、峰值低，所以看不出形状。
      const centerGlow = ctx2d.createRadialGradient(
        b.x - r * 0.10, b.y - r * 0.12, 0,
        b.x - r * 0.10, b.y - r * 0.12, r * 0.9,
      );
      centerGlow.addColorStop(0.00, `rgba(255,255,255,${(st.done ? 0.03 : 0.10) * alpha})`);
      centerGlow.addColorStop(0.55, `rgba(255,255,255,${(st.done ? 0.01 : 0.04) * alpha})`);
      centerGlow.addColorStop(1.00, 'rgba(255,255,255,0)');
      ellipse(ctx2d, 1);
      ctx2d.fillStyle = centerGlow;
      ctx2d.fill();

      // 6) 底部内暗影：圆的下缘积一点暗，立体感立刻出来（暗得太重会变"按钮"）
      ctx2d.save();
      ellipse(ctx2d, 1);
      ctx2d.clip();
      const inner = ctx2d.createRadialGradient(
        b.x + r * 0.18, b.y + r * 0.30, r * 0.30,
        b.x, b.y, r * 1.08,
      );
      inner.addColorStop(0.58, 'rgba(11,18,32,0)');
      inner.addColorStop(0.86, `rgba(11,18,32,${0.08 * alpha})`);
      inner.addColorStop(1.00, `rgba(11,18,32,${0.17 * alpha})`);
      ctx2d.fillStyle = inner;
      ctx2d.fillRect(b.x - r * 1.2, b.y - r * 1.2, r * 2.4, r * 2.4);
      ctx2d.restore();

      // 7) 选中态：外面加一圈深色描边（比白色更清楚）
      if (isSelected) {
        ellipse(ctx2d, 1);
        ctx2d.lineWidth = 2.5 + Math.abs(s) * 8;
        ctx2d.strokeStyle = luminance(tierC) > 0.45 ? 'rgba(20,26,40,.75)' : 'rgba(255,255,255,.9)';
        ctx2d.stroke();
      } else {
        // 常规外描边：一条极细的深色边，把泡泡从背景里"切"出来
        ellipse(ctx2d, 1);
        ctx2d.lineWidth = Math.max(0.8, r * 0.018);
        ctx2d.strokeStyle = overdue
          ? hexToRgba(OVERDUE_EDGE, 0.55 * alpha)
          : `rgba(15,23,42,${0.14 * alpha})`;
        ctx2d.stroke();
      }

      // 7b) 长按进度环：按住 2.5 秒就戳破，环走满即触发
      if (b.hold > 0.001) {
        ctx2d.beginPath();
        ctx2d.arc(b.x, b.y, r * LONG_PRESS_RING, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * b.hold);
        ctx2d.lineWidth = Math.max(2.5, r * 0.09);
        ctx2d.lineCap = 'round';
        ctx2d.strokeStyle = `rgba(239,68,68,${0.55 + 0.35 * b.hold})`;
        ctx2d.stroke();
        ctx2d.lineCap = 'butt';
      }

      // 7a) 「容器过期」标记：一圈暗紫**虚线**环。
      //
      // 为什么要单独一种画法：这颗泡泡自己没到期（文字写的是"剩余 N 天"），
      // 只是它所在的容器过期了。整颗变紫会让文字和颜色互相矛盾（用户报的 bug）。
      // 虚线环表达"有约束加在你身上，但你自己还没到期"——和实心紫（自己过期）区分得开。
      if (inheritedOverdue) {
        ctx2d.save();
        ctx2d.beginPath();
        ctx2d.arc(b.x, b.y, r * 1.03, 0, Math.PI * 2);
        ctx2d.setLineDash([Math.max(3, r * 0.16), Math.max(3, r * 0.13)]);
        ctx2d.lineWidth = Math.max(2, r * 0.055);
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
        const titleSize = Math.max(10, Math.min(19, r * 0.30));
        // 长英文/编号宁可把字号缩一点，也别把词劈成两行（"CHILD-AM" / "BER"）
        const fitted = wrapTextToFit(ctx2d, b.item.event.title, r * 1.58, titleSize, r > 52 ? 3 : 2);
        const lines = fitted.lines;
        const fittedSize = fitted.fontSize;
        ctx2d.font = `650 ${fittedSize}px system-ui, "Segoe UI", sans-serif`;
        const lineH = fittedSize + 3;
        const blockH = lines.length * lineH;
        const showSub = r >= 34;
        const showLevel = r >= 56;
        // 倒数文字不能跟着半径缩到看不见：最小 10px，并且**和标题同色**
        // （原来固定写白色 0.94，浅色泡体上几乎看不出）
        const subSize = Math.max(10, Math.min(13, titleSize * 0.74));
        const gap = 3;
        const subBlock = showSub ? subSize : 0;
        const totalH = blockH + (showSub ? gap + subBlock : 0);
        // 有档位标签时整体下移一点，给上面那行让位
        const centerY = b.y + (showLevel ? r * 0.06 : 0);
        const textTop = centerY - totalH / 2;
        const textBottom = textTop + totalH;

        if (!darkText) {
          // 亮色字：一层圆形的径向暗晕垫在文字后面（没有边，不会露出方块）
          const plateR = Math.max(blockH * 0.95, (textBottom - textTop) * 0.8);
          const plateCY = (textTop + textBottom) / 2;
          const plate = ctx2d.createRadialGradient(b.x, plateCY, 0, b.x, plateCY, plateR);
          plate.addColorStop(0.00, `rgba(9,14,26,${0.30 * alpha})`);
          plate.addColorStop(0.62, `rgba(9,14,26,${0.16 * alpha})`);
          plate.addColorStop(1.00, 'rgba(9,14,26,0)');
          ctx2d.beginPath();
          ctx2d.arc(b.x, plateCY, plateR, 0, Math.PI * 2);
          ctx2d.fillStyle = plate;
          ctx2d.fill();
        }

        ctx2d.save();
        ctx2d.lineJoin = 'round';
        ctx2d.lineWidth = Math.max(2, titleSize * (darkText ? 0.26 : 0.24));
        ctx2d.strokeStyle = darkText
          ? `rgba(255,255,255,${0.42 * alpha})`
          : `rgba(9,14,26,${0.32 * alpha})`;
        ctx2d.fillStyle = textColor;
        let y = textTop;
        for (const line of lines) {
          ctx2d.strokeText(line, b.x, y + titleSize / 2);
          ctx2d.fillText(line, b.x, y + titleSize / 2);
          y += lineH;
        }

        if (showSub) {
          ctx2d.font = `650 ${subSize}px system-ui, "Segoe UI", sans-serif`;
          ctx2d.lineWidth = Math.max(2, subSize * 0.26);
          // 第一行是"还剩多久"（v0.4 的主角），时间点跟在后面。
          // ⚠️ 重复事件的实例还要带**周几** —— 一周勾了 7 天时，
          //    7 个泡泡标题一样、时间数字也可能一样，只有周几能区分是哪一个。
          //    （用户报："我选了 7 个泡泡你不能都显示剩一个时间吧，要有周几的区别"）
          const sub = st.weekdayLabel
            ? `${st.countdownText} · 周${st.weekdayLabel} ${hhmm(b.item.start)}`
            : `${st.countdownText} · ${hhmm(b.item.start)}`;
          const subY = textTop + blockH + gap + subSize / 2;
          ctx2d.strokeText(sub, b.x, subY);
          ctx2d.fillStyle = textColor;
          ctx2d.globalAlpha = 0.95;
          ctx2d.fillText(sub, b.x, subY);
          ctx2d.globalAlpha = 1;
        }
        if (showLevel) {
          ctx2d.font = `700 ${Math.max(9, titleSize * 0.62)}px system-ui, sans-serif`;
          ctx2d.lineWidth = Math.max(2, titleSize * 0.2);
          const tag = `● ${(st.level && st.level.label) || ''}`;
          const tagY = b.y - r * 0.62;
          ctx2d.strokeText(tag, b.x, tagY);
          ctx2d.fillStyle = hexToRgba('#ffffff', 0.92 * alpha);
          ctx2d.fillText(tag, b.x, tagY);
        }
        ctx2d.restore();
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
    }));
    window.__bubbleCanvasSize = () => ({ width, height });
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
    if (!dragBody && bgTapAt) {
      const moved = Math.hypot(lastPos.x - bgTapPos.x, lastPos.y - bgTapPos.y);
      const quick = moved < 8 && performance.now() - bgTapAt < 400;
      bgTapAt = 0;
      if (!quick) return;
      handleBackgroundTap();
      return;
    }

    if (!dragBody) return;
    const b = dragBody;
    b.dragging = false;
    dragBody = null;
    local.setDropMode?.(false);
    const quick = pointerMoved < 8 && performance.now() - pointerDownAt < 400;

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
        if (local.isOverdueContainer?.()) {
          ctx.toast?.({
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
function drawOverdueSpikes(ctx2d, b, r, theta) {
  const n = OVERDUE_SPIKES;
  const inner = r * (1 - OVERDUE_SPIKE_LEN);
  const spike = ctx2d.createRadialGradient(b.x, b.y, inner, b.x, b.y, r);
  spike.addColorStop(0, hexToRgba(OVERDUE_EDGE, 0.05));
  spike.addColorStop(0.55, hexToRgba(OVERDUE_COLOR, 0.55));
  spike.addColorStop(1, hexToRgba(OVERDUE_EDGE, 0.95));
  ctx2d.fillStyle = spike;

  for (let i = 0; i < n; i += 1) {
    // 让刺跟着气泡的形变一起拉长/压扁（角度与泡体一致）
    const a = theta + (i / n) * Math.PI * 2;
    const halfW = Math.max(1.2, r * 0.055);
    const tipX = b.x + Math.cos(a) * inner;
    const tipY = b.y + Math.sin(a) * inner;
    const baseX = b.x + Math.cos(a) * r;
    const baseY = b.y + Math.sin(a) * r;
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

// 线性混合两色（玻璃感需要"往白里混"而不是单纯调透明度）
function mixColor(a, b, t) {
  const pa = rgbOf(a); const pb = rgbOf(b);
  const k = Math.max(0, Math.min(1, t));
  const out = [0, 1, 2].map((i) => Math.round(pa[i] + (pb[i] - pa[i]) * k));
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function rgbOf(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 让 tierByKey 的导出被使用（lint 友好 + 供未来扩展）
export { tierByKey };
