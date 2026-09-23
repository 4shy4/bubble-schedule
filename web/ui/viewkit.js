// 共享视图工具：时间轴布局、紧急度配色、块位置计算。
import { el } from './dom.js';
import { asDate, hhmm, minutesOfDay } from '../../core/time.js';
import { tierForHours, tierByKey, URGENCY_TIERS } from '../../core/palette.js';

export const HOUR_PX = 60;
export const GRID_START_HOUR = 6;
export const GRID_END_HOUR = 24;

/**
 * 全程序统一配色：颜色 = 紧急程度（天蓝还早 / 翠绿即将 / 黄催促 / 红紧急）。
 * 其它视图（月历、时间轴、清单、课程表）都走这里，避免出现
 * "气泡是红的、月历是蓝的"这种颜色语义不一致。
 */
export function tierVarForItem(item, now = new Date()) {
  const start = item && item.start ? asDate(item.start) : (item && item.event ? asDate(item.event.start) : item);
  const hours = (asDate(start).getTime() - now.getTime()) / 3_600_000;
  return tierByKey(tierForHours(hours).key).color;
}

/** 兼容旧调用：类型不再决定颜色，一律按紧急度 */
export function typeColor() {
  return tierByKey(tierForHours(24).key).color;
}

export function tierClass() {
  return 't-tier';
}

/** 一天的实际显示区间（若事件在 6 点前或 24 点后，自动扩展一点，避免被裁掉） */
export function visibleRange(items) {
  let start = GRID_START_HOUR;
  let end = GRID_END_HOUR;
  for (const it of items) {
    const s = asDate(it.start);
    const e = asDate(it.end);
    start = Math.min(start, s.getHours());
    end = Math.max(end, e.getHours() + (e.getMinutes() > 0 ? 1 : 0));
  }
  return { start: Math.max(0, start), end: Math.min(29, end) };
}

/**
 * 重叠分列：把同一天的事件按重叠关系分组，组内均分宽度。
 * 返回 [{ item, col, cols }]
 */
export function layoutColumns(items) {
  const sorted = [...items].sort((a, b) => asDate(a.start) - asDate(b.start) || asDate(a.end) - asDate(b.end));
  const placed = [];
  let cluster = [];
  let clusterEnd = null;

  const flush = () => {
    if (!cluster.length) return;
    const columns = [];
    for (const it of cluster) {
      let idx = columns.findIndex((col) => asDate(col[col.length - 1].end) <= asDate(it.start));
      if (idx < 0) { columns.push([it]); idx = columns.length - 1; }
      else columns[idx].push(it);
      it.__col = idx;
    }
    cluster.forEach((it) => { it.__cols = columns.length; });
    placed.push(...cluster);
    cluster = [];
    clusterEnd = null;
  };

  for (const it of sorted) {
    const s = asDate(it.start);
    const e = asDate(it.end);
    if (cluster.length && clusterEnd && s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = clusterEnd && clusterEnd > e ? clusterEnd : e;
  }
  flush();
  return placed;
}

export function blockGeometry(item, rangeStart) {
  const start = asDate(item.start);
  const end = asDate(item.end);
  const startMin = minutesOfDay(start);
  const endMin = Math.max(minutesOfDay(end), startMin + 20); // 太短也保证可点
  const top = ((startMin - rangeStart * 60) / 60) * HOUR_PX;
  const height = ((endMin - startMin) / 60) * HOUR_PX;
  return { top, height };
}

/** 生成时间轴骨架（小时刻度 + 虚线） */
export function hourRows(fromHour, toHour) {
  const rows = [];
  for (let h = fromHour; h < toHour; h += 1) rows.push(el('div.hour-line', { dataset: { hour: h } }));
  return rows;
}

export function hourLabels(fromHour, toHour) {
  const labels = [];
  for (let h = fromHour; h < toHour; h += 1) {
    labels.push(el('div.hour-label', { text: h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00` }));
  }
  return labels;
}

export function nowLine(rangeStart, todayColumn) {
  const now = new Date();
  const min = minutesOfDay(now);
  const top = ((min - rangeStart * 60) / 60) * HOUR_PX;
  return el('div.now-line', { style: { top: `${top}px` }, dataset: { col: todayColumn } });
}

export function legendNode() {
  const items = URGENCY_TIERS.map((t) => [t.label, t.color]);
  return el('div.legend', {}, items.map(([label, color]) => el('span', {}, [
    el('i', { style: { background: color } }), label,
  ])));
}

export function emptyState({ title, hint, actionLabel, onAction }) {
  return el('div.empty', {}, [
    el('div.empty-ico', { text: '🗓' }),
    el('h3', { text: title }),
    el('p.tiny', { text: hint }),
    actionLabel ? el('button.btn.btn-primary', { text: actionLabel, onclick: onAction }) : null,
  ]);
}

export { el, hhmm };
