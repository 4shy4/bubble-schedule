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
import { BUBBLE_VIEW_DEFAULTS } from './bubble-select.js';

// ---- 版本号：网页端能读到的**唯一一份** ----
//
// 为什么要有这个常量：设置页「关于」那一栏原来**写死**了 `'v0.3.0（手机可用版）'`，
// 一路发到 0.12.0 都没人发现 —— 公开版上那等于当面报错版本号。
// 现在的规则：
//   · 有服务端（电脑 / 局域网 / 安卓壳）→ 用 `/api/health` 的 `version`
//     （server/api.js 从 package.json 读，权威）；
//   · 本机独立模式（IndexedDB，没有服务端）→ 回落到这个常量。
//
// ⚠️ 发版时一起改：package.json 的 `version`、这里、`android/app/build.gradle`
//    的 `versionName`、`ios/project.yml` 的 `MARKETING_VERSION`。
//    `tools/defaults.test.mjs` 会断言这里与 package.json 一致（漂移就红）。
export const APP_VERSION = '0.12.0';

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
      // ---- 「简约版」三档预设（v0.11.0）----
      //   · `preset`    = 用户**上次选过**的那一档（'simple' | 'standard' | 'full'）
      //   · `setupDone` = 首次引导走完了没（跳过也算走完）
      //
      // ⚠️ `preset` 的缺省是**空串**，不是 `DEFAULT_PRESET`（'standard'）。这不是笔误：
      //    出厂设置里每个开关都在"最省事"的那一侧，那套组合**正好等于极简档**
      //    （tools/presets.test.mjs 有一条断言钉着这件事）。要是这里缺省写 'standard'，
      //    界面就会显示"当前：标准"而开关其实是极简 —— 标签和事实不符，
      //    正是本项目最讨厌的那种静默不一致。所以"没选过"就如实说没选过
      //    （core/presets.js 的 presetStatusOf()）。
      // ⚠️ 两个键都必须在**这里**登记（老库的 `settings` 键存在、但没有它们，
      //    不登记 `mergeDefaults` 就补不上，读出来是 undefined —— 那正是
      //    `courseDigest` 在真机上炸过一次的坑）。
      preset: '',
      setupDone: false,
      notify: { desktop: true, browser: true, sound: true, intensity: 'auto' },
      // 用户给**自己导入的铃声**起的名字（第 56 轮）：`{ '9f3a1c07': '起床号' }`。
      //
      // ⚠️ 键是壳生成的 **8 位十六进制 token**（不带 `custom:` 前缀），不是文件名：
      //    文件名在那台设备上才存在，token 才是"这一首"的身份。
      // ⚠️ 为什么名字要单独存、而不是让壳一起报上来：**名字是用户数据、要跟着同步走**，
      //    而文件是**设备本地**的（换台 iPad 就得重新导入）。名字存进设置，
      //    重新导入后（token 会变）……对不上是**已知的取舍**：
      //    以 token 为键意味着"同一台设备上重新导入同一首歌 = 新的一首"，
      //    名字要重起一遍。反过来以文件内容做键就得上哈希，那是另一个量级的事。
      //    ⚠️ 这里**必须登记**（老库的 `settings` 键存在、但没有它，`mergeDefaults`
      //    补不上就读到 undefined，表现是"改完名字一看没变"—— 又是 courseDigest 那条坑）。
      customSoundNames: {},
      autoLaunch: false,
      lan: false,
      defaultReminders: [10, 0],
      // 「周期」的生效范围：只影响气泡显示 / 也影响提醒 / 也影响日历
      periodAffectsReminders: false,
      periodAffectsCalendar: false,
      // 气泡区的显示偏好。**网页那侧的真值在 localStorage**（每台设备自己记），
      // 每次渲染时由 web/ui/views/bubble.js 的 syncBubbleView() **单向**推到这里，
      // 给 **Windows 桌面气泡层**读（它读不到浏览器的 localStorage）。
      //
      // ⚠️ 必须在**这里**登记（还是 courseDigest 那条坑）：老库里没有 `bubbleView`，
      //    不登记 `mergeDefaults` 就补不上，桌面那侧读到 undefined → 退回默认值，
      //    表现是"桌面上莫名少了几颗（节日/课程）"，而没人会想到去查默认值。
      // ⚠️ 缺省值从 core/bubble-select.js 的 BUBBLE_VIEW_DEFAULTS 取（**唯一**一份定义）——
      //    手抄一份就会漂移，而漂移的症状正是"桌面和网页显示的颗数不一样"
      //    （用户第 41 轮明确要求两端一致）。
      // ⚠️ 三档预设**绝不写**这里的任何键（见 core/presets.js 文件头第 ⑤ 条）：
      //    "极简档必须保留节日"的最强保证，就是预设根本没有能力把它关掉。
      bubbleView: { ...BUBBLE_VIEW_DEFAULTS },
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
      // ⚠️ `allowCgnat` 默认 **false** = **不认** CGNAT（`100.64.0.0/10`，校园网/热点常见）。
      //    为什么必须登记在这里（同上那条 courseDigest 坑）：老库里没有这个键，
      //    不登记的话 mergeDefaults 补不上，读出来是 undefined —— 而判定那边
      //    用的是 `=== true`，于是"用户打开过这个开关"会在某次升级后**静默变回关**，
      //    表现是"我明明开了校园网共享，平板又连不上了"（而且查不出来）。
      //    为什么默认是 false（而不是"像 192.168 一样放行"）：同一片校园网里可能有
      //    几百台别人的设备，默认放行等于把共享面偷偷扩大一个数量级 ——
      //    这种"默认替用户做主"的事在本项目里一律不许（见 server/ai-share.js 的口径）。
      aiShare: { enabled: false, token: '', port: 7080, allowCgnat: false },
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
    // 闹钟板块（计时器 / 定时器）。
    //
    // ⚠️ 放在**顶层**、和 events/courses 平级，而不是塞进 settings：
    //    · 它是一份**列表**（可能几十条），不是设置项 —— 塞进 settings 会让
    //      "改设置"和"加一条闹钟"走同一条 PATCH，出口掩码与逐字段合并那堆规矩
    //      全都要跟着考虑一遍，而闹钟一条都不需要；
    //    · 列表整份替换的语义也比"嵌套对象逐字段合并"清楚得多。
    //
    // ⚠️ 必须在**这里**登记（这就是 courseDigest 炸过一次的那条坑）：
    //    老库里没有 `alarms` 这个键，不登记 `mergeDefaults` 就补不上 ——
    //    而闹钟视图读的是 `state.alarms.length`，读到 undefined 会整块渲染不出来。
    //
    // ⚠️ 它**不进同步**（core/sync.js 只同步 events + courses）：
    //    闹钟是"这台设备上几点叫我"，跨设备同步是错的（和 settings 同一个理由）。
    //    这一条写在这儿，免得以后有人"顺手"把它加进同步载荷。
    alarms: [],
  };
}
