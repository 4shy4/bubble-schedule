// 「哪些实例要浮出来」—— 这条规则从 `web/ui/views/bubble.js` 抽出来，现在**两处共用**：
//
//   · 网页气泡区（web/ui/views/bubble.js 的 selectItems 现在只是薄薄一层包装）
//   · Windows 桌面泡泡（core/desktop-bubbles.js → /api/desktop-bubbles）
//
// ⚠️ 为什么要抽：这是本项目第 N 次面对"**两条路径迟早不一致**"。
//    "最多浮当前+预备两颗"、"周期筛选"、"未来泡泡出现前不显示"、"按剩余时间排序"
//    这些规则如果桌面版再抄一份，那么将来改一处、另一处就会悄悄错开 ——
//    而且错开的表现是"桌面上的泡泡和 iPad 上的不一样"，根本没人会想到是抄了两份。
//
// ⚠️ 这个模块必须保持**平台无关**（core/ 的规矩，tools/core.test.mjs 守着）：
//    不碰 document / localStorage / sessionStorage。所有"界面上的选择"（当前在第几层容器、
//    时间范围选几天、显示不显示课程）都由调用方通过参数传进来。

import { addDays, startOfDay, toDateKey } from './time.js';
import { expandRange, applyPeriodLimit } from './recurrence.js';
import { bubbleStyle } from './urgency.js';
import { isNotYetVisible, inheritedOverdueOf, occurrenceKey } from './state-ops.js';
import { asDate } from './time.js';
// 节日气泡（算出来的虚拟事件；专用颜色也在那儿）
import { festivalEvents, FESTIVAL_COLORS } from './holidays.js';

/** 往前看多久（历史实例是"欠账"，要留着当紫泡泡堆着）。上限免得日级事件展开出上千个 */
export const LOOKBACK_DAYS = 180;

/**
 * 气泡区"显示设置"的默认值 —— **两端共用这一份**。
 *
 * 用户第 41 轮的原话："桌面气泡的显示与软件气泡区设置保持一致"。
 * 一致性最容易破的地方就是**默认值**：网页那边默认往前看 14 天、默认显示课程，
 * 桌面这边要是自己拍一个"7 天、不显示课程"，表现就是"桌面上少了几颗" ——
 * 而这种差异没人会想到去查默认值。所以把三个数放在这里，两边都从这里取。
 *
 * ⚠️ 网页那侧的真值在 localStorage（用户可以在"显示设置"里改），改完会通过
 *    `PATCH /api/settings {bubbleView}` 同步给服务端；桌面那侧直接读服务端这一份。
 */
export const BUBBLE_VIEW_DEFAULTS = Object.freeze({
  horizonDays: 14,
  showCourse: true,
  showDone: false,
  // 节日气泡：还剩几天时浮出来（用户定的默认 4 天，可调；0 = 不显示）
  festivalDays: 4,
});

/**
 * 这个事件的实例"会同时存在多颗"吗（用来决定要不要在泡泡上标周几）。
 *
 * ⚠️ 不能只看 `recurrence.freq`：课表课程是 `weeks` 驱动的，freq 是 'none'。
 */
export function isRepeating(ev) {
  if (!ev) return false;
  const rec = ev.recurrence || {};
  if (rec.freq && rec.freq !== 'none') return true;
  if (Array.isArray(ev.weeks) && ev.weeks.length) return true;
  return false;
}

/**
 * 选出"这一刻该浮出来的实例"，并附上各自的 `style`（core/urgency.js 的 bubbleStyle）。
 *
 * @param {Array} events 全部日程
 * @param {object} opts
 * @param {Date}   [opts.now]
 * @param {string} [opts.termStart] 学期第一周周一（课表展开要）
 * @param {string|null} [opts.parentId] 当前在第几层容器里（null = 最外层）
 * @param {boolean} [opts.anyParent] 忽略层级、把**所有层**的实例都算进来
 *        （桌面泡泡的"摊平"模式用；网页气泡区永远一次只看一层）
 * @param {number} [opts.horizonDays] 「时间范围」= **预览多远**（不是过滤器：超出的仍显示但虚化）
 * @param {boolean} [opts.showCourse] 气泡区要不要显示课程
 * @param {boolean} [opts.showDone] 要不要显示已完成的
 * @param {number} [opts.max] 最多返回几颗（0 = 不限；调用方按自己的版面裁剪）
 * @returns {Array<{event:object,start:Date,end:Date,deadline:Date|null,key:string,style:object}>}
 *          按"越接近截止越靠后"排序（画的时候后者盖前者）
 */
export function selectBubbleItems(events = [], {
  now = new Date(),
  termStart = '',
  parentId = null,
  anyParent = false,
  horizonDays = 7,
  showCourse = true,
  showDone = false,
  // 「节日气泡」提前几天浮出来（0 = 不显示；网页/桌面的默认都在 settings.bubbleView 里）
  festivalDays = 0,
  max = 0,
} = {}) {
  const from = startOfDay(now);
  const to = addDays(from, horizonDays);

  // 套娃：只显示"当前容器里的气泡"。最外层只显示没有父级的。
  // `anyParent`（桌面泡泡的摊平模式）则把每一层都算进来 —— 这样"装在一个过期母泡泡
  // 里的子泡泡"也会浮出来，并且带着"容器过期"那圈环（见下面 inheritedOverdueOf）。
  let visible = anyParent
    ? events.slice()
    : events.filter((ev) => (ev.parentId || null) === parentId);

  // 课程是周期性的：一学期几十节全丢进气泡区会挤爆、还到处乱蹦。
  if (!showCourse) visible = visible.filter((ev) => ev.type !== 'course');

  const raw = expandRange(
    visible,
    new Date(from.getTime() - LOOKBACK_DAYS * 86_400_000),
    new Date(to.getTime() - 1),
    termStart,
    (ev) => showDone || !ev.done,
  );

  // 丢掉"早于事件自身开始时间"的实例（展开是往前推的，会生成那时还不存在的实例）
  const all = raw.filter((it) => {
    const evStartMs = asDate(it.event.start).getTime();
    return !Number.isFinite(evStartMs) || it.start.getTime() >= evStartMs - 60_000;
  });

  // 「未来泡泡」：还没到出现日期 → 不参与气泡区（列表/月历照常显示）
  // ⚠️ 必须在 applyPeriodLimit **之前**：周期筛的锚点是"第一个未来的实例"，
  //    一颗还没出现的泡泡混在里面会把锚点占掉，把真正该显示的那颗挤没。
  const visibleNow = all.filter((it) => !isNotYetVisible(it.event, now));

  // 「周期」筛选：只留「第一颗 + 周期」以内的
  const limited = applyPeriodLimit(visibleNow, now);

  // 重复事件：最多浮"当前 + 预备"两颗（约束**未来**，不约束历史）
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
  for (const item of limited) {
    const key = item.event.id + '@' + toDateKey(item.start);
    if (seen.has(key)) continue;

    // 已经被戳破的这一颗 → 不再浮（它进了回收站）。这是**按实例记账**。
    const poppedMap = item.event.popped;
    if (poppedMap && typeof poppedMap === 'object' && poppedMap[occurrenceKey(item.start)]) continue;

    const isUpcoming = item.start.getTime() > now.getTime();
    if (isUpcoming && !keepFutureIds.has(item.key)) continue;

    seen.add(key);
    // ⚠️ 必须用 inheritedOverdueOf（只看祖先链），不能用 isOverdueEvent：
    //    后者读的是 base 的期限（第一次发生那次），会给"上周建的每周日程"
    //    在本周/下周那两颗上画出一圈紫虚线（用户报的"紫齿轮"）。
    const style = bubbleStyle(item, {
      now,
      forceOverdue: inheritedOverdueOf(item.event, events, now),
      showWeekday: isRepeating(item.event),
    });

    // 「时间范围」是**预览范围**：超出范围的未来实例仍显示，但虚化
    const beyondPreview = isUpcoming && item.start.getTime() > to.getTime();
    if (beyondPreview) style.dimmed = true;
    out.push({ ...item, style, key });
  }

  // 越接近截止的越先画（画在下面），所以"马上到期"的更靠视觉中心；没设期限的排最后
  out.sort((a, b) => {
    const ra = a.style.remaining == null ? Number.MAX_SAFE_INTEGER : a.style.remaining;
    const rb = b.style.remaining == null ? Number.MAX_SAFE_INTEGER : b.style.remaining;
    return rb - ra;
  });

  // 「节日气泡」（用户要求）：节日**还剩 N 天**时浮出来，用**专用颜色**。
  //   · 只在最外层显示（进了母泡泡就是在看"这一层的事"，节日不掺和）
  //   · 只报"重要的 + 快到了的"（一年到头都在过节 = 没信号）
  //   · 是**算出来的虚拟事件**，不进库、只读（id 前缀 `festival:`）
  if (festivalDays > 0 && !anyParent && parentId == null) {
    for (const f of festivalEvents(now, { days: festivalDays })) {
      out.unshift({
        event: f,
        start: new Date(f.start),
        end: new Date(f.end),
        deadline: null,
        key: f.id,
        festival: true,
        style: {
          // ⚠️ 颜色走 `tier.color`（渲染层真正用来画泡体的就是它），但**档位 key 仍写 'red'**：
          //    这样文字排版/白字/统计都还按已有的"重大"那档走，不必让 palette、列表、
          //    统计到处都去认一个第五档。（"专用颜色"要的是**看得出来的区别**，不是新档位。）
          tier: {
            key: 'festival', rank: 3, label: '节日',
            color: FESTIVAL_COLORS.fill, colorDeep: FESTIVAL_COLORS.fillDark, colorName: '节日红',
          },
          tierKey: 'red',
          levelKey: 'red',
          radiusRatio: 0.72,                 // 这几天它就该显眼
          countdownText: f.countdown || '',
          timeText: f.countdown || '',
          remaining: f.daysLeft * 86_400_000,
          band: 'day',
          bandLabel: '节日',
          overdue: false,
          ownOverdue: false,
          overdueInherited: false,
          dimmed: false,
          done: false,
          weekdayLabel: null,
          festival: true,
        },
      });
    }
  }

  return max > 0 ? out.slice(0, max) : out;
}
