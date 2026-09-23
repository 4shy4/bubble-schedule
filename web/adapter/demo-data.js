// demo 用的假日程。**不含任何真实数据**。
//
// 目的是把气泡区的**每一种视觉状态**都摆出来，让人一眼看懂这套 UI 在表达什么：
//   · 大小 = 还剩多久（越近越大）
//   · 颜色 = 事情多大（小/中/大/重大 = 天蓝/翠绿/黄/红）
//   · 过期 = 定点不动 + 暗紫 + 长刺
//   · 套娃 = 一个容器气泡里装着子气泡
//
// 时间都相对"现在"算，所以这个 demo 任何时候打开都是"活的"。

const iso = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const plus = (now, ms) => iso(new Date(now.getTime() + ms));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * @param {Date} now 基准时间
 * @returns {Array} 事件数组（形状与真实应用一致）
 */
export function demoEvents(now = new Date()) {
  return [
    // ---- 最紧迫：几十分钟内，红（重大），气泡会很大 ----
    {
      id: 'demo-exam', title: '交课程设计报告', type: 'personal', level: 'red',
      start: plus(now, 25 * MIN), end: plus(now, 85 * MIN),
      reminders: [30, 10, 0],
    },
    {
      id: 'demo-meeting', title: '小组会议', type: 'personal', level: 'amber',
      start: plus(now, 2 * HOUR), end: plus(now, 3 * HOUR),
      reminders: [10, 0],
    },

    // ---- 今天之内 ----
    {
      id: 'demo-gym', title: '去健身房', type: 'personal', level: 'emerald',
      start: plus(now, 7 * HOUR), end: plus(now, 8 * HOUR),
      reminders: [10, 0],
    },

    // ---- 几天后 ----
    {
      id: 'demo-scholar', title: '奖学金材料截止', type: 'personal', level: 'red',
      start: plus(now, 3 * DAY), end: plus(now, 3 * DAY + 2 * HOUR),
      reminders: [60 * 24, 0],
    },
    {
      id: 'demo-reading', title: '读完那本书', type: 'personal', level: 'sky',
      start: plus(now, 6 * DAY), end: plus(now, 6 * DAY + HOUR),
      reminders: [0],
    },
    {
      id: 'demo-trip', title: '订回家的票', type: 'personal', level: 'emerald',
      start: plus(now, 12 * DAY), end: plus(now, 12 * DAY + HOUR),
      reminders: [0],
    },

    // ---- 课程（可以用工具栏的开关把这类整体藏起来）----
    {
      id: 'demo-course', title: '高等数学（3-4 节）', type: 'course', level: 'emerald',
      start: plus(now, 20 * HOUR), end: plus(now, 21.5 * HOUR),
      reminders: [15, 0],
    },

    // ---- 套娃：一个容器 + 两个子气泡（双击进去能看见）----
    {
      id: 'demo-container', title: '期末周', type: 'personal', level: 'red',
      start: plus(now, 5 * DAY), end: plus(now, 9 * DAY),
      reminders: [0],
    },
    {
      id: 'demo-child-1', title: '复习线代', type: 'personal', level: 'amber',
      start: plus(now, 5 * DAY + 2 * HOUR), end: plus(now, 5 * DAY + 4 * HOUR),
      parentId: 'demo-container', reminders: [10, 0],
    },
    {
      id: 'demo-child-2', title: '整理错题', type: 'personal', level: 'emerald',
      start: plus(now, 6 * DAY + 2 * HOUR), end: plus(now, 6 * DAY + 4 * HOUR),
      parentId: 'demo-container', reminders: [10, 0],
    },

    // ---- 已过期：定点不动、暗紫、一圈长刺 ----
    {
      id: 'demo-overdue', title: '还图书馆的书', type: 'personal', level: 'amber',
      start: plus(now, -2 * DAY), end: plus(now, -2 * DAY + HOUR),
      reminders: [0],
    },

    // ---- 已完成：默认不显示（工具栏可打开）----
    {
      id: 'demo-done', title: '交作业', type: 'personal', level: 'sky',
      start: plus(now, -3 * DAY), end: plus(now, -3 * DAY + HOUR),
      done: true, reminders: [0],
    },
  ];
}

/** 单击空白背景"新建"时随机造一条，让 demo 有得玩 */
export function randomNewEvent(now = new Date()) {
  const titles = ['买咖啡', '回邮件', '写周报', '准备答辩', '打电话给家里', '交材料', '看牙医'];
  const levels = ['sky', 'emerald', 'amber', 'red'];
  const idx = Math.floor(Math.random() * titles.length);
  const ahead = (5 + Math.floor(Math.random() * 72)) * HOUR;
  return {
    id: 'demo-new-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    title: titles[idx],
    type: 'personal',
    level: levels[Math.floor(Math.random() * levels.length)],
    start: plus(now, ahead),
    end: plus(now, ahead + HOUR),
    reminders: [10, 0],
  };
}
