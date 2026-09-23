// demo 的装配层：把真实的气泡视图挂到一个假日程数据上。
//
// 这一层**只做接线**：视图要什么 ctx，这里就给什么。
// 所有"气泡长什么样、怎么动、怎么判定紧迫度"的逻辑都在
// web/ui/views/bubble.js + core/ 里 —— 那就是真实应用跑的那份代码。

import { bubbleView } from './ui/views/bubble.js';
import { toast } from './ui/toast.js';
import * as store from './adapter/store.js';

const host = document.getElementById('view-host');
const titleEl = document.getElementById('view-title');
const subEl = document.getElementById('view-subtitle');
const navEl = document.getElementById('view-nav');

const ctx = {
  refresh: () => render(),

  // 单击空白背景 = 新建一条（demo 里随机造，让你有得玩）
  newEventAt: async () => {
    const ev = await store.createRandom();
    toast({ title: '新建了一条', body: `「${ev.title}」已变成气泡`, timeout: 1800 });
  },

  // 单击气泡 = 编辑（demo 不实现编辑器，只提示）
  editEvent: (ev) => {
    toast({
      title: '单击 = 编辑',
      body: `真实应用这里会打开「${ev.title}」的编辑器`,
      timeout: 2200,
    });
  },

  // 容器里点背景 = 往容器里加子气泡
  addChild: async (containerId) => {
    const ev = await store.createRandom();
    await store.patchEvent(ev.id, { parentId: containerId });
    toast({ title: '放进容器了', body: `「${ev.title}」现在是它的子气泡`, timeout: 1800 });
  },

  toast,
};

/** 渲染工具栏（重排 / 暂停漂浮）—— 这两个是气泡区最好玩的地方，值得露出来 */
function renderNav(state) {
  const items = bubbleView.nav ? bubbleView.nav(state) : [];
  navEl.replaceChildren(...items.map((it) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.textContent = it.label;
    if (it.title) b.title = it.title;
    b.addEventListener('click', () => {
      bubbleView.onNav(it.action, ctx);
      render();
    });
    return b;
  }));
}

function render() {
  const state = store.getState();
  titleEl.textContent = bubbleView.title(state);
  subEl.textContent = bubbleView.subtitle(state);
  renderNav(state);
  // ⚠️ 「显示课程 / 显示已完成 / 时间范围」这些开关是画在气泡视图自己的 HUD 里的，
  //    不在这层 —— 所以这里不需要（也不该）重复实现。
  bubbleView.render(state, ctx, host);
}

store.subscribe(render);
render();

// 方便自动化检查"到底渲染出来了没有"
window.__demo = {
  state: () => store.getState(),
  bubbles: () => document.querySelectorAll('canvas.bubble-canvas').length,
  bodyLen: () => (document.body.innerText || '').length,
};
