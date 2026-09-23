// demo 版数据层 —— 接口与真实应用的 `web/adapter/store.js` **同名同形**，
// 但数据只活在内存里（刷新即还原）。
//
// 为什么这样做（这是这个 demo 能成立的关键）：
//   真实 store.js 会 import api.js / outbox.js / local-mode.js，
//   而 api-local.js 又拉着「学校课表导入」那套适配器。
//   气泡视图只需要**五个函数**，所以这里用一份内存实现顶掉整个数据层 ——
//   `web/ui/views/bubble.js` **一行都不用改**，而且天然碰不到任何学校代码。
//
// 业务判定**不重复实现**：写操作全部转发给 `core/state-ops.js`
//   （那是三端共用的同一份逻辑，见仓库的 docs/LOCAL-FIRST.md）。

import * as stateOps from '../../core/state-ops.js';
import { defaultDb } from '../../core/defaults.js';
import { demoEvents, randomNewEvent } from './demo-data.js';

const db = defaultDb();
db.events = demoEvents(new Date());
db.courses = [];

let state = {
  ready: true,
  online: false,          // demo 没有服务端
  error: null,
  health: null,
  rev: 0,
  pending: 0,
  settings: db.settings,
  events: db.events,
  courses: db.courses,
  view: 'bubble',
  cursor: new Date().toISOString().slice(0, 10),
  courseWeek: null,
};

const listeners = new Set();
const emit = () => {
  state = { ...state, rev: state.rev + 1, events: db.events.slice() };
  for (const fn of listeners) fn(state);
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getState() { return state; }

/** 某个气泡的直接子气泡（和真实 store 的实现一致） */
export function childrenOf(id) { return db.events.filter((e) => e.parentId === id); }

/** 真实 store 会把 state-ops 的它再导出一次；bubble.js 的注释里引用了这个名字 */
export const occurrenceKey = stateOps.occurrenceKey;

export async function saveEvent(input) {
  const saved = stateOps.upsertEvent(db, input, new Date());
  emit();
  return saved;
}

export async function patchEvent(id, patch) {
  const saved = stateOps.patchEvent(db, id, patch, new Date());
  emit();
  return saved;
}

export async function popEvent(id, opts = {}) {
  const r = stateOps.popEvent(db, id, opts, new Date()) || {};
  emit();
  // bubble.js 会读 `released`（放出来的子气泡）和 `mode`（是"这一次"还是"整条"）
  return {
    ok: true,
    released: r.released || [],
    mode: r.mode || (opts && opts.occurrence ? 'instance' : 'event'),
    event: r.event || db.events.find((e) => e.id === id) || null,
  };
}

/** 供 demo.js 的"单击空白新建"用 */
export async function createRandom() {
  return saveEvent(randomNewEvent(new Date()));
}

/** 与真实 store 同名的空实现，免得外部偶发调用时报 undefined */
export async function init() { emit(); }
export async function refresh() { emit(); }
export function setView() {}
export function setCursor() {}
export function setCourseWeek() {}
