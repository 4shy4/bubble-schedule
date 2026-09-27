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
import { aiFeatureDefaults } from './brief.js';
import { activitySettingsDefaults } from './activity-log.js';

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
      // 好友名单（第 49 轮）。⚠️ 必须在这里登记：老库的 `settings` 键**存在**、
      // 但没有 `contacts`，不登记的话 `mergeDefaults` 补不上，读出来是 undefined ——
      // 这正是 `courseDigest` 炸过一次的那条坑（安卓端读到 null、设置页显示不出来）。
      contacts: [],
      // 全局画像关键词（"让 AI 更了解我"那部分）。好友各自的 keywords 在这个之上叠加。
      greetingProfile: {},
      // 节日祝福的设置：提前几天、当天几点生成、是否启用 AI
      greetingSettings: { leadDays: 0, atHour: 8, aiEnabled: false },
      // AI 接口配置（OpenAI 兼容）。key 只存在本机，绝不上云（见 server/ai.js 的注释）。
      //   `isLocal:true` = 这是**电脑上的本地模型**（Ollama 这类，免费、不出网）。
      //   ⚠️ 它必须在这里登记：老库的 `settings` 键**存在**、但没有 `isLocal`，
      //      不登记的话 `mergeDefaults` 补不上，读出来是 undefined ——
      //      而"本地模型不需要 Key"这条判定读的正是它（这正是 `courseDigest` 炸过的那条坑）。
      ai: { baseUrl: '', apiKey: '', model: '', isLocal: false },
      // 「把电脑当成平板的 AI 服务器」（第 51 轮）。
      //
      // ⚠️ 必须在这里登记（同上那条坑）：老库里没有 `aiShare`，
      //    补不上的话界面读到 undefined，开关会显示不出来、令牌也没地方存。
      // ⚠️ `token` 是**明文**躺在库里的（和 apiKey 一样）：它必须能被服务端原样读出来
      //    去和请求比，所以"加密"在这里没有意义 —— 要守的是**它能从哪出去**
      //    （见 server/api.js 的出口掩码：非本机请求一律掩码）。
      // ⚠️ `port` 默认 7080 = 本机服务端口（共享没有第二个监听端口）。
      aiShare: { enabled: false, token: '', port: 7080 },
      // 「AI 来源」：请求发给谁（`'direct'` 本机直连 / `'computer'` 电脑 / `'off'` 关闭）。
      //
      // ⚠️ 缺省是 `'off'`（关闭）—— 用户明确要求的一档，理由是他一贯的
      //    "不要时就不要"：**没选过任何来源时，界面不许出现 AI 卡片、不许发任何请求**。
      //    所以"关"必须是**默认值**，而不是"出错后的一种状态"。
      // ⚠️ `aiComputer.token` 也是**凭证**（平板拿它去换电脑的共享），
      //    出口掩码那套对它同样成立（见 server/api.js 的 maskSecrets）。
      aiSource: 'off',
      aiComputer: { url: '', token: '' },
      // AI 助手那一组功能的**逐个开关**（今日简报 / 周复盘 / 把日程喂给 AI）。
      //
      // ⚠️ 用户原话："这些新加入的功能我要可关可开，不要时就不要" ——
      //    所以这里**默认全部关闭**，而且必须在这里登记：老库的 `settings` 键
      //    **存在**、但没有 `aiFeatures`，不登记的话 `mergeDefaults` 补不上，
      //    读出来是 undefined（这正是 `courseDigest` 炸过一次的那条坑）。
      // ⚠️ 缺省值从 core/brief.js 取（**唯一**一份定义），别在这儿手抄一份 ——
      //    抄了就会漂移，而漂移的症状是"我明明开了，重启又关了"。
      aiFeatures: aiFeatureDefaults(),
      // 「本地活动日记」（第 52 轮）：把"发生了什么"记在本地，只把**压缩摘要**喂给 AI。
      //
      // ⚠️ 必须在这里登记（同上那条坑）：老库的 `settings` 键**存在**、但没有这两个键，
      //    不登记的话 `mergeDefaults` 补不上，读出来是 undefined ——
      //    而界面上的「本地记录」那块要显示条数，读到 undefined 就整块显示不出来。
      //
      // ⚠️ 两个键的职责别混（见 core/activity-log.js 文件头）：
      //    · `activityLog`      = 记下来的条目（数组，**整份替换**；裁剪规则在 core 里）
      //    · `activitySettings` = 保留策略 + **记录总闸**（`enabled` 默认 false）
      //    而"要不要喂给 AI"是**另一个**开关：`aiFeatures.assistantMemory`（默认也是 false）。
      //    一个是"记不记在自己设备上"，一个是"喂不喂出去"，不该合成一个。
      // ⚠️ 它**不进同步**（core/sync.js 只同步 events + courses，settings 不过去），
      //    所以这台设备上的活动记录不会因为一次同步被别的设备覆盖。
      activityLog: [],
      activitySettings: activitySettingsDefaults(),
    },
    events: [],
    courses: [],
  };
}
