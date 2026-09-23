// 缺省值深合并：给老数据补上**新增的嵌套字段**。
//
// 为什么需要：
//   `{ ...DEFAULT, ...loaded }` 是**浅**合并 —— 只能补上 DB 顶层的键。
//   而新增的设置项往往是嵌套的（比如 `settings.courseDigest`），
//   老库里 `settings` 这个键**存在**、但里面没有 `courseDigest`，
//   浅合并就补不上，读出来是 `undefined`。
//
// 实测症状（真机端到端测出来的）：
//   · 安卓端 `/api/state` 返回的 `settings.courseDigest` 是 `null`
//     → 设置页整块显示不出来（它读的是原始值，不像界面别处有兜底）
//   · 桌面端同理，只是前端有 `normalizeDigest` 兜着才没暴露
//
// 规则：
//   · 目标是普通对象、缺省也是普通对象 → 递归补
//   · 目标缺失（undefined / null）→ 用缺省值
//   · 目标存在（哪怕值是 `false` / `0` / `''` / `[]`）→ **保留用户的值**
//   · 数组整体替换，不逐项合并（合并数组语义不清，容易出怪事）
//
// 平台无关（不碰 node: / window / Buffer），所以安卓 Kotlin 侧是同一套语义的复刻。
import { defaultDigestSettings } from './course-digest.js';

export function mergeDefaults(target, defaults) {
  if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
    return target === undefined || target === null ? defaults : target;
  }
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    // 目标不是对象（缺了、或是错的类型）→ 整个用缺省
    return target === undefined || target === null ? clone(defaults) : target;
  }
  const out = { ...target };
  for (const [k, dv] of Object.entries(defaults)) {
    out[k] = mergeDefaults(target[k], dv);
  }
  return out;
}

/** 浅拷贝一份缺省值（只到能安全复用的深度就够，缺省值都是我们自己写的字面量）*/
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return { ...v };
  return v;
}

/**
 * 一份全新的空数据库。
 *
 * ⚠️ 这是**唯一**的缺省库定义 —— 服务端（写 data/db.json）和
 *    iPad 的本地模式（写 IndexedDB）必须用同一份，否则两边形状会分叉：
 *    典型症状是本地存进去的设置项，回到服务端读出来是 `undefined`，
 *    而界面某处没有兜底就整块显示不出来（`courseDigest` 就这么炸过一次）。
 *
 * 这里列出的每个键都是**有意的**：
 *   · 必须在这里出现，`mergeDefaults` 才知道要往老库里补什么
 *   · 所以新增设置项时**这里也必须加**，只加界面是不够的
 */
export function defaultDb() {
  return {
    version: 1,
    rev: 0,
    updatedAt: new Date().toISOString(),
    settings: {
      owner: '我',
      termStart: '',
      termWeeks: 20,
      todayTodo: '',
      notify: { desktop: true, browser: true, sound: true, intensity: 'auto' },
      autoLaunch: false,
      lan: false,
      defaultReminders: [10, 0],
      // 「周期」的生效范围：只影响气泡显示 / 也影响提醒 / 也影响日历
      periodAffectsReminders: false,
      periodAffectsCalendar: false,
      // 同步范围（4c）：all=全同步；whitelist=只同步列出的；blacklist=除列出的都同步。
      // 类别只有 'courses'（课表）和 'bubbles'（气泡区）。
      // 用户的例子：whitelist+[courses] = "只同步课表"；blacklist+[bubbles] = "只不同步气泡区"
      syncFilter: { mode: 'all', categories: [] },
      // ⚠️ `sectionTimes` 给空数组，实际节次由导入时写入
      sectionTimes: [],
      importedSources: [],
      // 课程摘要的槽位（与界面、摘要判定共用同一份定义）
      courseDigest: defaultDigestSettings(),
    },
    events: [],
    courses: [],
  };
}
