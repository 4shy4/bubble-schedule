// 「闹钟」板块的纯逻辑 —— 计时器（倒计时）与定时器（固定时刻）+ 铃声目录。
//
// ===========================================================================
// ⚠️ 为什么这个文件住在 core/，而不是写在那个视图里
//
//   和气泡、课表、提醒同一条规矩：**"什么时候该响"是业务，必须只有一份**。
//   三端（浏览器 / iOS 壳 / 电脑服务端）都要能算出同一个答案，
//   而壳只做"把这行字翻译成系统 API"（见 ios/Timetable/AlarmClockScheduler.swift）。
//   一旦视图里也写一份"下一次是几点"，换端就会分叉，而分叉的症状是
//   **闹钟在某个端上不响** —— 那是这个功能最不能接受的失败方式。
//
//   本文件**平台无关**：不碰 node: / window / document / fetch / localStorage，
//   只依赖 core/time.js（同样是纯的）。
//
// ===========================================================================
// ⚠️ 两个概念别混（用户口语里都叫"闹钟"）：
//
//   · `clock`（定时器/闹钟）：**固定时刻** —— "每天 7:00 叫我"。有重复规则。
//   · `timer`（计时器/倒计时）：**一段时长** —— "25 分钟后叫我"。不重复（每天重复的
//     倒计时在真机上没有意义：它得知道"从哪一刻开始算"，而那件事只有用户知道）。
//
//   两者共用一张列表、一个开关、一个铃声，但**排程方式完全不同**：
//   前者用系统日历/重复规则，后者用 `duration`。所以 `kind` 是必填字段。
//
// ===========================================================================
// ⚠️ 铃声：`AlertSound.named("名字")` 吃的是**打进 App 包里的文件**
//
//   依据（不是猜的）：`build/alarmkit-api/AlarmKit.symbols.json` 里
//     AlarmManager.AlarmConfiguration.alarm(schedule:attributes:…:sound:)
//       sound: AlertConfiguration.AlertSound = .default
//   而 `AlertSound` 本身属于 **ActivityKit**（符号 id s:11ActivityKit18AlertConfigurationV0C5SoundV），
//   Apple 文档原文：
//     struct AlertSound
//     static func named(String) -> AlertConfiguration.AlertSound
//     static var `default`: AlertConfiguration.AlertSound
//   → **只有"文件名"这一个入口，没有文件 URL、没有沙盒路径**。
//   所以 v1 只做**内置铃声**（打进 App 包的那几个文件），UI 里如实写明
//   "暂不支持自选文件"。**不要做一个点了没用的选择器** —— 那比没有更糟。
//
//   文件放在 `ios/Timetable/` 下（XcodeGen 按扩展名收成 bundle 资源），
//   由 `tools/gen-alarm-sounds.mjs` **代码生成**（正弦音 + 包络，零依赖、离线）。
//
//     文件不在包里时 iOS 的行为是**静默放默认音**（不报错）。
//   所以壳侧必须把"实际排出去的铃声名"回报上来（见 RING_STATUS），
//   网页据此如实显示"自定义铃声没生效"，而不是让用户以为设了就一定响。

import { asDate, DAY_MS, WEEK_CN, hhmm } from './time.js';

/** 闹钟的种类。见文件头"两个概念别混" */
export const ALARM_KINDS = ['clock', 'timer'];

/** 重复规则。`weekdays` = 周一到周五；`custom` 用 `weekdays` 数组（0=周日，照 JS 的 getDay） */
export const ALARM_REPEATS = ['once', 'daily', 'weekdays', 'custom'];

/**
 * 重复规则的中文名。
 * ⚠️ `custom` 的实际星期由 `describeAlarm` 拼出来（这里只给主名），
 *    否则会出现"自定义"三个字而看不出来到底选了哪几天。
 */
export const REPEAT_LABEL = {
  once: '只响一次',
  daily: '每天',
  weekdays: '工作日（周一至周五）',
  custom: '自定义',
};

/**
 * 最多几条闹钟。
 *
 * ⚠️ 这个上限**不是**系统限制（系统那边是 AlarmKit 的 `maximumLimitReached`，
 *    而且只跟"同时排出去的数量"有关，见 MAX_SCHEDULED）。这里是产品上限：
 *    闹钟列表要能一眼看完、要能同步进诊断区、要能整批交给壳 ——
 *    贪多只会让"到底哪条没排上"变得查不清。
 */
export const ALARM_LIMIT = 50;

/**
 * 一次最多往系统里排几条。
 *
 * ⚠️ 与 `AlarmKitScheduler.maxAlarms`（8）**必须同源**，否则会出现
 *    "网页以为排了 12 条、系统只收了 8 条"这种对不上账的现象 ——
 *    而它表现出来只是"有的闹钟不响"，极难查。壳侧排的时候也按这个数截断。
 */
export const MAX_SCHEDULED = 8;

/** 计时器时长边界：1 秒 ~ 24 小时。 */
export const TIMER_MIN_MS = 1_000;
export const TIMER_MAX_MS = 24 * 3600 * 1000;

/** 计时器常用快选（分钟）—— UI 与校验共用一份，别在视图里再抄一遍 */
export const TIMER_PRESETS = [1, 3, 5, 10, 30];

/**
 * 内置铃声目录。
 *
 * ⚠️ 字段各有各的用处，别合并：
 *   · `file`    —— 传给 iOS `AlertSound.named()` 的**文件名（不带扩展名）**。
 *                  探针实测/文档用法都是不带扩展名（`named("probe-ascend3")`）。
 *                  壳侧还会把实际传的值回报上来（见 RING_STATUS）。
 *                  ⚠️ **名字故意超过 15 字节**，别为了好看改短：
 *                  Swift 对 ≤15 字节的字符串字面量用**内联小字符串**编码，
 *                  编译产物里 `strings` 搜不到 —— 于是"代码到底有没有用这个文件"
 *                  就无法从产物上验证（这个坑在主 App 的提示音上踩过一次，
 *                  `tools/ios-bundle-check.mjs` 现在有一条断言守着名字长度）。
 *   · `preview` —— 网页侧"试听"按钮用哪种**合成音型**。
 *                  ⚠️ 为什么试听不播真文件：音文件在 **App 包里**，
 *                  网页（浏览器 / 其他端）根本取不到，硬去 `/xxx.caf` 只会 404。
 *                  所以试听放的是"音型"（几短音 / 升降 / 长短），
 *                  UI 上**如实标注**"试听是音型示意，真机上是这个铃声文件"。
 *                  ⚠️⚠️ **合法值只有这 5 个**：`morning` / `triple` / `low` / `drop` / `beep`
 *                  —— 它们必须与 `web/ui/views/alarms.js` 里导出的 `SOUND_PATTERNS` 的键**一一对应**。
 *                  写错一个字，试听会**静默落到 triple 音型**（听起来就是"轻快三连"）。
 *                  2026-09-30 真发生过：这一条写成了 `chime`（表里没有这个键），
 *                  于是用户选「晨钟」点试听、响的是「轻快三连」。
 *                  现在 `tools/alarms-view.test.mjs` 有断言钉住"每个 preview 值都有对应音型"。
 *   · `sharp`   —— 给 UI 一个"这个音比较刺耳"的提示，别让用户误选。
 */
export const ALARM_SOUNDS = Object.freeze([
  { id: 'morning', label: '晨钟', file: 'alarm-morning-bell', preview: 'morning', sharp: false,
    // ⚠️ 2026-10-02：`desc` 补到 16 字以上（原来"一声悠长的钟，适合起床"太短）。
    //    起因是给第二批五个铃声加的护栏"每个 desc 都要说清谁该选它" ——
    //    **护栏不该为旧数据让路**，所以旧的四条也补上（声音没动，只改了文字）。
    desc: '一声悠长的钟，慢慢展开 —— 本来就睡得浅、想被温柔叫醒的选它' },
  { id: 'triple', label: '轻快三连', file: 'alarm-triple-rise', preview: 'triple', sharp: false,
    desc: '三声上扬，最像普通闹钟 —— 不知道选哪个就用它' },
  { id: 'low', label: '低沉两下', file: 'alarm-low-two-tone', preview: 'low', sharp: false,
    desc: '两下低音，不吵但有余量 —— 怕高频刺耳、又不想太温柔的选它' },
  { id: 'drop', label: '水滴', file: 'alarm-water-drop', preview: 'drop', sharp: false,
    desc: '一声水滴滑落，十个里最轻 —— 只想起个提醒、不想被叫醒的选它' },
  { id: 'beep', label: '连续滴', file: 'alarm-beep-pips-x', preview: 'beep', sharp: true,
    desc: '连续短促蜂鸣，十个里最刺耳 —— 睡得很死、必须被吵醒就选它' },
  // ---------------------------------------------------------------------------
  // 第二批五个（2026-10-02 追加）。
  //
  // ⚠️⚠️ **设计规则：每个必须"各有专攻"，不许是同一个音的变体。**
  //    上面五个占掉了：清脆长音 / 三连上行 / 低沉两下 / 短滑音 / 高频短促。
  //    下面这五个各自占一个**空位**，而且三个维度都真的分开了：
  //      频率带（低 / 中 / 高）· 包络形态（脉冲 / 硬交替 / 泛音 / 渐急 / 渐强）· 起伏方向
  //    **加第六个之前，请先说明它占了什么空位** —— 否则很容易做出听感重复的音。
  //    音频由 `tools/gen-alarm-sounds.mjs` **用代码合成**（零版权、体积小），
  //    这份目录与那个脚本必须一一对应（`tools/ios-bundle-check.mjs` 会比对，不一致就构建失败）。
  // ---------------------------------------------------------------------------
  { id: 'heartbeat', label: '心跳', file: 'alarm-heartbeat-pulse', preview: 'heartbeat', sharp: false,
    desc: '低频「咚·咚」成对敲，能持续十几秒 —— 不刺耳但叫得醒（睡得浅、需要持久）' },
  { id: 'siren', label: '欧式警笛', file: 'alarm-siren-alert', preview: 'siren', sharp: true,
    desc: '两音硬交替扫动，最难忽略 —— 只想被吵醒、不在乎难听就选它' },
  { id: 'chime', label: '风铃', file: 'alarm-windchime-rise', preview: 'chime', sharp: false,
    desc: '五声音阶上行带泛音，像一串风铃 —— 有旋律、起床气大的选它' },
  { id: 'accelerate', label: '渐急滴', file: 'alarm-accelerate-beeps', preview: 'accelerate', sharp: false,
    desc: '同一音高越敲越急（唯一一个节奏会变的）—— 靠"越来越急"叫你，适合赖床' },
  { id: 'dawn', label: '晨曦', file: 'alarm-dawn-chorus', preview: 'dawn', sharp: false,
    desc: '低音和弦铺底 + 高音缓慢上行 —— 像天亮，不想被吓醒的选它' },
  // ---------------------------------------------------------------------------
  // 「自定义」——**用户自己从「文件」里导入的音频**（2026-10-01 做成正门功能）
  //
  // ⚠️ `file: ''` 是**故意的**，不是漏写：
  //    内置铃声的文件名是**编译期就定好的**（`alarm-morning-bell` 等），
  //    而用户导入的那个文件名**带时间戳、只有壳知道**
  //    （`timetable-custom-t0-1696….caf`，存在 App 容器的 `Library/Sounds`）。
  //    真实名字由壳在 `soundStatus` 回报里带上来（字段 `alarmFile`），
  //    排闹钟/试听时由 `web/adapter/alarms.js` 填进去 —— 见 `resolveSoundFile()`。
  //
  // ⚠️ 用户**没导入**过音频时，界面**不要**显示这一条（否则选了会静默放默认音）。
  //    过滤逻辑在 `web/ui/views/alarms.js`（它能看到壳报回来的文件名单）。
  //
  // ⚠️ 这条路真机实测过：2026-10-01 用户的音频当闹钟铃声，到点**真的响出来了**。
  //
  // ⚠️⚠️ 2026-10-02 **多首共存**改动（用户："一个自定义有时候可能不够用"）：
  //    这一条**不再代表"那唯一一首"**，而是"自定义这一类"的**入口/兜底**。
  //    真正的每一首有自己的 id：`custom:<壳生成的 id>`（见 `customSoundId()`）。
  //
  //    为什么保留 `'custom'`（不带冒号）这个老 id：
  //      用户的闹钟数据里已经存着 `sound: 'custom'`（云同步、多设备）。删掉它就等于
  //      把人家设好的铃声**静默打回系统默认音**。所以 `'custom'` 仍然合法，
  //      **含义 = 当前可用的第一首**（老数据当年只能有一首，这个解释是唯一合理的）。
  //
  //    为什么"多首"不写成多条 `ALARM_SOUNDS` 项：这份目录是**编译期常量**
  //      （内置铃声必须与打进包里的 .caf 一一对应，`tools/ios-bundle-check.mjs` 钉着）。
  //      而用户导入的结果**运行时才知道**、每台设备还不一样 —— 两者混在一张表里，
  //      那张表就没法再当"编译期契约"用了。所以运行时那部分由调用方通过
  //      `opts.customFile` 传进来（见 `soundFileOf`）。
  { id: 'custom', label: '自定义（我导入的）', file: '', preview: 'custom', sharp: false,
    desc: '从「文件」里选一段音频（30 秒以内，自动截取开头）' },
]);

// ---------------------------------------------------------------------------
// 自定义铃声的 id 规则（2026-10-02 新增）
// ---------------------------------------------------------------------------

/**
 * 「自定义铃声」那一类的 id 前缀。完整形式是 `custom:<壳给的 id>`，例如 `custom:9f3a1c07`。
 *
 * ⚠️ 那个 id **由壳生成**（它才知道文件名），网页只当字符串搬运 —— 不要在这里
 *    解析出"第几首""时间戳"之类的含义：id 是**不透明**的，这样将来换生成方式
 *    也不会牵动这里。
 */
export const CUSTOM_SOUND_PREFIX = 'custom:';

/** 老 id（多首之前只有一首时用的）。**仍然合法**，含义 = 当前第一首 */
export const LEGACY_CUSTOM_SOUND_ID = 'custom';

/** 拼一个自定义铃声的 id（`id` 为空/非法时给 null，不要拼出 `'custom:'` 这种半成品） */
export function customSoundId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  // 只允许字母数字和 `-`：壳生成的 id、以及老文件的 `t0-1696…` 都是这个形状。
  // 挡掉冒号和空白是为了让 id **仍是单段字符串**（下游会拿它当数组/映射的键）。
  if (!/^[\w-]{1,64}$/.test(s)) return null;
  return CUSTOM_SOUND_PREFIX + s;
}

/**
 * 判断一个 id 是不是"某一首自定义铃声"（**不含**老的裸 `'custom'`）。
 *
 * ⚠️ 为什么单独给一个函数、而不是在三处各写一遍 `startsWith`：
 *    `'custom:'` 这个前缀是**跨三层**的约定（core ↔ adapter ↔ 壳的文件名）。
 *    散着写，某处写漏一字的后果是"用户选了 A 首、响的是默认音"，且**不报错**。
 */
export function isCustomSoundId(id) {
  const s = String(id == null ? '' : id);
  return s.length > CUSTOM_SOUND_PREFIX.length && s.startsWith(CUSTOM_SOUND_PREFIX);
}

/** `custom:9f3a1c07` → `'9f3a1c07'`；不是这一类的给空串 */
export function customSoundKey(id) {
  return isCustomSoundId(id) ? String(id).slice(CUSTOM_SOUND_PREFIX.length) : '';
}

/**
 * 把调用方传来的"本机有哪些自定义铃声"整理成统一的数组。
 *
 * 吃两种形状（都要认，因为调用方分两层、历史上都出现过）：
 *   · `[{ id, name, file }, …]` —— `web/adapter/native.js` 报上来的正牌形状
 *   · `'timetable-custom-9f3a1c07'` —— **单个文件名**（老壳只报一个 `alarmFile`）
 *
 * 输出：`[{ id, name, file }, …]`，`id` 一律是**完整 id**（`custom:…`）。
 * 坏条目**丢掉**（不抛错）：脏数据不该让整个铃声列表渲染不出来。
 *
 * ⚠️ 第二个参数 `names` 是**用户自己起的名字**（`settings.customSoundNames`，
 *    形状 `{ '9f3a1c07': '起床号' }`，键是**不带前缀**的 key）。
 *    为什么名字要由调用方从设置里取、而不是塞进这个数组里：
 *      · 数组是**壳报上来的**（"这台设备上有哪些文件"），名字是**用户数据**（跟着同步走）；
 *      · 两者来源不同、生命周期不同 —— 装到另一台 iPad 上，文件还没导，名字也该留着。
 *    优先级：**壳给的名字 > 用户名字 > 空**（壳给的名字是以后可能加的"从文件读出来的标题"，
 *    现在恒为空串，所以实际就是用户名字）。
 */
export function normalizeCustomSounds(raw, names) {
  const named = names && typeof names === 'object' && !Array.isArray(names) ? names : null;
  // 三种形状（见 `soundFileOf` 的注释）里的**映射**要先摊成数组：
  // `{ 'custom:9f3a1c07': 'timetable-custom-9f3a1c07.caf', … }`
  // ⚠️ 不摊开的话，整个映射会被当成"一个坏条目"丢掉 —— 调用方按需拼的那条路
  //    会静默失效（查不到文件 → 界面说"不在这台设备上"，而用户明明导入过）。
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') list = Object.entries(raw).map(([id, file]) => ({ id, file }));
  else list = raw ? [raw] : [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') {
      // 单个文件名：`timetable-custom-<key>` → key
      const key = fileStemOf(item);
      const id = key ? customSoundId(key) : null;
      if (id) out.push({ id, name: nameOf(named, key), file: String(item) });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const file = String(item.file || '');
    // ⚠️ **没有文件名的条目直接丢掉**：这一类的全部意义就是"那个 .caf 在哪"，
    //    留着它只会在界面上多出一条"看起来能选、选了没声音"的选项。
    //    （也不能靠它占住 id —— 同 id 去重只留第一条，占住了会把真有文件的那条挤掉。）
    if (!file) continue;
    // id 优先用调用方给的；没有就从文件名推（老壳不带 id）
    //
    // ⚠️ 调用方给的 id 可能是**已经归一化过的完整 id**（`custom:9f3a1c07`）：
    //    `native.js` 报上来的清单就是 `normalizeCustomSounds` 处理过的，界面又把它
    //    原样传回来（`{ customFile: customAlarmSounds() }`）。这里必须先**剥掉前缀**
    //    再校验，否则整条会被当成坏条目丢掉 —— 后果是"每一首自定义铃声都查不到
    //    自己的文件"，界面上全都显示"这个音频不在这台设备上"，而那**不报错**。
    const rawId = String(item.id || '').replace(/^custom:/, '');
    const key = rawId || fileStemOf(file);
    const id = key ? customSoundId(key) : null;
    if (!id) continue;
    const name = (typeof item.name === 'string' ? item.name.trim().slice(0, 40) : '')
      || nameOf(named, key);
    out.push({ id, name, file });
  }
  // 同 id 只留第一条（壳理论上不会重复，但重复了不该在界面上出现两个一样的选项）
  const seen = new Set();
  return out.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/**
 * 从"用户起的名字"那张表里取这一首的名字（取不到给空串）。
 *
 * ⚠️ 键**不带** `custom:` 前缀（`settings.customSoundNames` 的形状就是这么定的，
 *    见 `defaults.js`）—— 这里再兼容地剥一次前缀，是为了将来有人手改设置、写成
 *    带前缀的键时不至于静默失效（那种 bug 的表现是"名字改完一看没变"，最难查）。
 * ⚠️ 长度也钳到 40：名字会进 DOM、也会进备份，**不许**让它长到撑破界面。
 */
function nameOf(named, key) {
  if (!named || !key) return '';
  const raw = named[key] != null ? named[key] : named[CUSTOM_SOUND_PREFIX + key];
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 40);
}

/**
 * 从壳报的文件名里取"这一首"的 key。
 *
 * 壳的文件名规则：`timetable-custom-<key>.caf`（**不带扩展名**也要能认，因为
 * `AlertSound.named()` 要的是不带扩展名的）。
 *
 * ⚠️ 也**必须**认得老名字 `timetable-custom-t0-1696….caf`（多首之前，导入的文件名
 *    里编了"通知档位"）。理由不是洁癖，是**不能把用户已有的音频弄丢**：
 *    老用户的闹钟里存着 `sound: 'custom'`，而壳报上来的清单里那个文件就叫老名字 ——
 *    这里认不出来就等于"铃声列表里查不到这一首" → 到点静默响系统默认音。
 *
 *    老名字和新名字**不可能撞**：新 id 由壳生成，正好 8 位小写十六进制
 *    （`newToken()`），而老名字去掉前缀后是 `t0-1696…` 这种 14 位以上、
 *    带 `-` 的形状。所以两条规则合在一个正则里不会把两个文件映射到同一个 id。
 */
function fileStemOf(name) {
  const s = String(name || '').replace(/\.caf$/i, '');
  const m = /^timetable-custom-([A-Za-z0-9][A-Za-z0-9-]{0,63})$/.exec(s);
  return m ? m[1] : '';
}

/** 默认铃声 id（新闹钟用它；找不到目录时兜底成系统默认音 = 空串） */
export const DEFAULT_SOUND_ID = 'triple';

/** 铃声 id → 目录项。认不出来返回 null（**不抛错**：脏数据不该让列表整块渲染不出来） */
export function soundById(id) {
  const key = id == null ? '' : String(id);
  // 自定义那一类**不在 ALARM_SOUNDS 里**（每台设备不同，见上面 `id: 'custom'` 的注释）——
  // 用"这一类"的入口项兜底，这样 `soundById('custom:…')` 仍能拿到 label/preview 等公共字段。
  if (isCustomSoundId(key)) {
    const base = ALARM_SOUNDS.find((s) => s.id === LEGACY_CUSTOM_SOUND_ID) || null;
    return base ? { ...base, id: key } : null;
  }
  return ALARM_SOUNDS.find((s) => s.id === key) || null;
}

/**
 * 铃声 id → 交给系统（`AlertSound.named(…)`）的**文件名（不带扩展名）**。
 *
 * ⚠️ 认不出来时返回 **null**，而不是空串：
 *   `named("")` 在 iOS 上的行为是"这条没声音"，而且**不报错** ——
 *   那正是本项目最讨厌的静默失败。null 让调用方能明确区分
 *   "用户要系统默认音" 和 "铃声名坏了"。
 *   `null` 的含义：**用系统默认闹钟音**（壳侧不传 `sound:` 参数）。
 *
 * ⚠️ `opts.customFile` 是**给自定义那一类用的**，三种形状都吃：
 *   · `[{ id, name, file }, …]` —— 正牌形状（`normalizeCustomSounds` 的输出）
 *   · `{ 'custom:9f3a1c07': 'timetable-custom-9f3a1c07', … }` —— 映射（方便调用方按需拼）
 *   · `'timetable-custom-9f3a1c07'` —— **单个文件名**（老壳只报一个 `alarmFile`）
 *
 *   ⚠️ `'custom'`（老 id）解析成**第一首**：老数据当年只能有一首，
 *      这是唯一合理的解释，而且**不能**让老闹钟静默变成默认音。
 *      找不到任何一首时返回 **null**（= 用系统默认音），不是空串。
 */
export function soundFileOf(id, opts) {
  const key = id == null ? '' : String(id);
  const o = opts || {};
  const custom = normalizeCustomSounds(o.customFile, o.customNames);

  if (isCustomSoundId(key)) {
    const want = key;
    const hit = custom.find((c) => c.id === want);
    return hit && hit.file ? hit.file : null;
  }

  const s = ALARM_SOUNDS.find((x) => x.id === key);
  if (!s) return null;
  if (s.id === LEGACY_CUSTOM_SOUND_ID) {
    // 老 id = 第一首（`normalizeCustomSounds` 保序）
    const first = custom.find((c) => c.file);
    return first ? first.file : null;
  }
  return s.file;
}

/**
 * 「某个铃声 id 现在能不能真的放出声」—— 给界面决定**要不要列出来/要不要报警**。
 *
 * ⚠️ 为什么要单独一个函数：内置铃声**永远可用**；自定义铃声要**文件真在本机**
 *    （设置是云同步的，音频文件只在那台设备上）。以前这个判断散在界面里
 *    （`sounds.filter((s) => s.id !== 'custom' || customFile)`），
 *    多首之后那种写法会漏 —— 于是"列出来一首、选了却没声音"。
 */
export function soundAvailable(id, opts) {
  return soundFileOf(id, opts) != null;
}

/**
 * 铃声 id → **界面上显示的名字**。
 *
 * ⚠️ 为什么要单独一个：自定义铃声的显示名**只有壳报的清单里有**（`name`），
 *    而 `soundById(id).label` 对所有自定义 id 都是同一个"自定义（我导入的）"——
 *    用户导了两首就会在列表里看到两条一模一样的选项，根本分不清。
 *    这里拼成 `自定义 · 竹取飛翔`；壳没报名字就退回文件名（**总比全都一样强**）。
 */
export function soundLabelOf(id, opts) {
  const key = id == null ? '' : String(id);
  // ⚠️ 2026-10-02：老 id `'custom'`（多首之前存的）**故意**不在这里"顺便"说出是哪一首。
  //    这里一旦替它报出第一首的名字，调用方就再也分不清"那一首还在"和"那一首没了" ——
  //    `soundFileOf('custom')` 在没有文件时给 null，界面正是靠这个 null 才敢说
  //    "会响默认音"。报了个名字就等于替它假装文件还在（静默响默认音，本项目最忌讳）。
  //    "老 id 显示成哪一首"由界面负责（见 `web/ui/views/alarms.js` 的 `soundTextOf`：
  //    有文件时显示 `自定义 · <第一首的名字>`，没有文件时明说"不在这台设备上"）。
  if (key === LEGACY_CUSTOM_SOUND_ID) return '自定义';
  if (!isCustomSoundId(key)) {
    const s = soundById(key);
    return s ? s.label : '';
  }
  const hit = normalizeCustomSounds((opts || {}).customFile, (opts || {}).customNames)
    .find((c) => c.id === key);
  if (!hit) return '自定义';
  return `自定义 · ${hit.name || shortFileName(hit.file) || '（未命名）'}`;
}

/** 文件名 → 给人看的短名（去掉前缀和扩展名），认不出就给空串 */
function shortFileName(file) {
  const stem = fileStemOf(file);
  return stem || '';
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 整数解析（认不出来给 null，不要静默当成 0） */
function intOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && Math.trunc(n) === n ? n : null;
}

function strOf(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/** 这一天的星期（0=周日 … 6=周六，和 JS `Date.getDay()` 一致） */
export function weekdayOf(d) {
  return asDate(d).getDay();
}

/**
 * 一条闹钟生效的星期集合（0=周日…6=周六）。
 * `once` 返回空集合 —— "只响一次"跟星期无关。
 */
export function weekdaysOf(alarm) {
  const a = alarm || {};
  if (a.repeat === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (a.repeat === 'weekdays') return [1, 2, 3, 4, 5];
  if (a.repeat === 'custom') {
    const list = Array.isArray(a.weekdays) ? a.weekdays : [];
    // 去重 + 排序 + 只留 0..6（脏数据不许把排程带歪）
    return [...new Set(list.map(intOf).filter((n) => n !== null && n >= 0 && n <= 6))].sort();
  }
  return [];
}

/** 一条闹钟的 id。前缀区分种类，和 core 其它 id 一个风格 */
export function alarmId(seed) {
  const s = String(seed == null ? '' : seed).replace(/[^\w-]/g, '');
  return `alarm_${s || Math.random().toString(36).slice(2, 10)}`;
}

export function newAlarm(patch = {}, now) {
  // ⚠️ 三目而不是 `now || new Date()` —— 理由见 normalizeAlarm 里那段长注释
  const at = asDate(now === undefined ? new Date() : now).toISOString();
  const src = (patch && typeof patch === 'object') ? patch : {};
  // ⚠️ 顺序有三个讲究，别顺手改：
  //   ① 缺省值在前、`...src` 在后 —— 调用方给了什么就以什么为准。
  //      （第一版把 `...src` 写在了 `atHour/atMinute` 之前，于是
  //        `newAlarm({atHour:9})` 会被默认的 7 点吃掉，而那是**静默改用户输入**。
  //        测试里正是这条抓出来的。）
  //   ② `createdAt` 在 `...src` **之后** —— 调用方带进来的 createdAt 要留着，
  //      否则"基于旧记录造一份新的"会把创建时间改成现在。
  //   ③ 缺省值里**不放** `atHour/atMinute` 之外的业务字段：它们是"新闹钟的默认外观"，
  //      不是"每次都要覆盖一遍的事实"。
  return normalizeAlarm({
    kind: 'clock',
    atHour: 7,
    atMinute: 0,
    repeat: 'once',
    label: '',
    sound: DEFAULT_SOUND_ID,
    enabled: true,
    ...src,
    createdAt: src.createdAt || at,
  }, now);
}

/**
 * 归一化：把任意输入收敛成"列表能安全渲染、壳能安全排"的形状。
 *
 * ⚠️ 这一层**不做校验**（不抛错）：它要能吃下脏数据（手改的 db.json、
 *    旧版本写进去的字段），把能救的救回来。该不该拒绝由 `validateAlarm` 说，
 *    而那是**用户按下保存时**才跑的。两者分开的理由：
 *    列表渲染路径上抛错 = 整页白掉，而那条路上不该有用户的输入。
 *
 * ⚠️ 为什么"归一化"里也要纠 `weekdays`：如果原样留着 `[9, "x"]`，
 *    iOS 侧拿它去建 `Locale.Weekday` 会崩（或者排出个诡异的东西）。
 *    脏数据必须在**跨进程之前**就被收拾干净。
 */
export function normalizeAlarm(raw, now, opts = {}) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  // ⚠️ `strict:true` = **保留越界值**，交给 validateAlarm 去报错。
  //
  //   为什么需要这个开关（这是本文件第二次自测才暴露的坑，值得写下来）：
  //     "归一化"要能夹回越界值（列表渲染路径上不许抛错），但**保存**路径
  //     必须先校验。如果归一化先把 `atHour:99` 夹成 `23`，那校验看到的就永远是
  //     合法值 —— 于是**用户填 99 点会被静默存成 23 点**，而这类静默改数据的
  //     行为正是本项目最反对的（"用户填什么就是什么，不行就明确报错"）。
  //   所以：读路径（列表/排程）用宽松归一化，写路径先 strict 校验、通过了再归一化。
  const strict = opts.strict === true;
  // ⚠️⚠️ 这里**必须**写成三目，不能写成 `asDate(now || new Date())`。
  //
  //   踩过的坑（本文件的第一次自测就抓到了）：`asDate()` 的默认参数是
  //   `new Date()`（**真实时钟**）。而 `asDate(x)` 在 x 是普通对象时会
  //   `new Date(x)` → NaN → 又掉回默认值 → **真实时钟**。
  //   于是一个"传了 now"的调用会被悄悄换成真实时间，症状是
  //   "同一个 fixture 今天跑得过、明天就红"，或者"倒计时还剩 7 小时"
  //   （因为它把 startedAt 当成了今天）。
  //   三目以后，`now === undefined` 才用真实时钟，其余一律用传进来的那个。
  const at = asDate(now === undefined ? new Date() : now).toISOString();

  const kind = ALARM_KINDS.includes(src.kind) ? src.kind : 'clock';
  const repeat = ALARM_REPEATS.includes(src.repeat) ? src.repeat : 'once';

  const hour = intOf(src.atHour);
  const minute = intOf(src.atMinute);
  const durRaw = Number(src.durationMs);
  // ⚠️ strict 模式下不夹 durationMs（25 小时要能被 validateAlarm 看见并报错）；
  //    但 `Number.isFinite` 那道**要留着**：`durationMs:'abc'` 在 strict 下给 NaN，
  //    校验靠 `Number.isFinite` 拦住它 —— 那不是"静默改数据"，是"报错"。
  const durationMs = Number.isFinite(durRaw)
    ? (strict ? Math.round(durRaw) : Math.min(TIMER_MAX_MS, Math.max(TIMER_MIN_MS, Math.round(durRaw))))
    : (strict && src.durationMs !== undefined ? NaN : 25 * 60_000);

  const startedRaw = src.startedAt ? asDate(src.startedAt).getTime() : null;

  // ⚠️ strict 模式下：**给了就原样留着**，哪怕越界/不是数字。
  //    为什么要留着"不是数字"的那种（`atHour: 'abc'` → NaN）而不是兜底成默认值：
  //      · 兜底成 7 点 = **静默把用户填的东西改掉**，而校验看到 7 就放行；
  //      · 留 NaN，validateAlarm 的 `Number.isFinite` 会当场拦住并报错。
  //    宽松模式（读列表/排程）才做兜底与夹回 —— 那条路上不许抛错、也不许出 NaN。
  const atHour = strict ? (src.atHour === undefined ? 7 : src.atHour)
    : (hour === null ? 7 : Math.min(23, Math.max(0, hour)));
  const atMinute = strict ? (src.atMinute === undefined ? 0 : src.atMinute)
    : (minute === null ? 0 : Math.min(59, Math.max(0, minute)));

  return {
    id: strOf(src.id, 64) || alarmId(),
    kind,
    // 定时器：只留合法的时分。
    // ⚠️ 宽松模式下越界**夹回**（0..23 / 0..59），strict 模式下**原样保留**
    //    （让 validateAlarm 能看见 99 并报错）—— 见函数头那段说明。
    atHour,
    atMinute,
    // 计时器时长（毫秒）
    durationMs,
    repeat,
    // ⚠️ 这里存的是**用户勾的那几天本身**（过滤掉越界值、去重、排序），
    //    **不**按 repeat 模式改写。两个理由：
    //      · 排程要的"实际生效的星期"由 `weekdaysOf()` 现算 —— 那是**派生值**，
    //        存成字段就会出现两份真源（改了 repeat 忘了改它 = 排程错）。
    //      · 用户把「自定义」改成「每天」再改回来时，勾过的星期还在。
    //        存派生值的话这一改就白勾了（用户会以为"我的选择丢了"）。
    weekdays: [...new Set((Array.isArray(src.weekdays) ? src.weekdays : [])
      .map(intOf).filter((n) => n !== null && n >= 0 && n <= 6))].sort(),
    label: strOf(src.label, 24),
    sound: soundById(src.sound) ? String(src.sound) : DEFAULT_SOUND_ID,
    enabled: src.enabled !== false,
    // 计时器用：这一轮倒计时从哪一刻开始（没开始过就是 null）
    startedAt: Number.isFinite(startedRaw) ? new Date(startedRaw).toISOString() : null,
    // 计时器用：是**用户主动暂停**了吗（和"没开始/已结束"是三种不同状态）。
    // ⚠️ 为什么必须有这个字段，而不是"看还剩多少猜"：
    //    暂停后的剩余时间与正在跑的那一刻**长得一模一样**（都是"还剩 12:34"）。
    //    而界面/定时器刷新要区分它们 —— 把已暂停的当成在跑，就会出现
    //    "暂停了但界面还在自己倒数"这种一眼假的 bug；反过来则"暂停后数字不动了"（也对，
    //    但用户按继续时会以为是重新开始）。宁可显式记一个布尔值。
    paused: src.paused === true,
    createdAt: src.createdAt ? asDate(src.createdAt).toISOString() : at,
    updatedAt: src.updatedAt ? asDate(src.updatedAt).toISOString() : at,
  };
}

/**
 * 校验用户填的东西。**纯函数**，返回 `{ ok, errors: [{ code, message }] }`。
 *
 * ⚠️ 为什么是"错误码 + 中文"两个都给，而不是只给一句话：
 *   项目里既有的失败文案范式是"**失败码 → 人话 + 👉 下一步**"
 *   （见 web/ui/ai-setup.js）。码是给测试和将来做多语言用的，
 *   人话是给用户看的。只给一句话，测试就只能断言字符串（一改文案就红）；
 *   只给码，用户看不懂。
 */
export function validateAlarm(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const errors = [];
  const push = (code, message) => errors.push({ code, message });

  // ⚠️ 在 **strict** 归一化上校验，理由见 normalizeAlarm 的 `opts.strict`：
  //    宽松归一化会把 `atHour:24` 夹成 23、把 25 小时的时长夹成 24 小时 ——
  //    校验看到"已经合法了"的值就永远放行，于是**用户填的东西被静默改掉**。
  const a = normalizeAlarm(src, undefined, { strict: true });
  const kind = a.kind;

  if (kind === 'clock') {
    const h = a.atHour;
    const m = a.atMinute;
    if (!(Number.isFinite(h) && h >= 0 && h <= 23)) push('ALARM_HOUR', '小时要在 0–23 之间');
    if (!(Number.isFinite(m) && m >= 0 && m <= 59)) push('ALARM_MINUTE', '分钟要在 0–59 之间');
    if (!ALARM_REPEATS.includes(src.repeat)) {
      push('ALARM_REPEAT', '请选一个重复方式（只响一次 / 每天 / 工作日 / 自定义）');
    }
    if (src.repeat === 'custom' && !weekdaysOf(a).length) {
      push('ALARM_WEEKDAYS', '自定义重复要至少选一天');
    }
  } else {
    const ms = Number(src.durationMs);
    if (!Number.isFinite(ms)) push('ALARM_DURATION', '请填一个时长');
    else if (ms < TIMER_MIN_MS) push('ALARM_DURATION_MIN', '时长至少 1 秒');
    else if (ms > TIMER_MAX_MS) push('ALARM_DURATION_MAX', '时长最长 24 小时（更长的请用「定时器」）');
  }

  if (src.sound != null && String(src.sound) !== '' && !soundById(src.sound)) {
    push('ALARM_SOUND', '铃声认不出来，请重新选一个');
  }
  if (strOf(src.label, 40).length > 24) push('ALARM_LABEL', '标签最多 24 个字');

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 下一次该响的时刻 —— 本文件的核心
// ---------------------------------------------------------------------------

/**
 * 下一次该响的时刻。**返回 `Date` 或 `null`，永远不抛错**（脏数据/不可能的组合都给 null）。
 *
 * ⚠️ 五条规则，每一条都是踩过/想过才会有的，改之前先读完：
 *
 *   ① **`enabled === false` 只影响"排不排"，不影响"算出几点"** ——
 *      `nextFireAt` **故意不看 `enabled`**。
 *      理由：列表里关掉的那条仍然要显示"下次 7:00"，关掉不等于删掉。
 *      调用方（`planAlarmSchedule`）自己过滤 `enabled`。
 *      （这是一个真实的分叉点：如果把 enabled 判断塞进来，
 *        就会出现"关掉再打开，下次时间是空的"这种怪现象。）
 *
 *   ② **`once` 的时钟闹钟 = 最近的那个时刻点**：今天还没到就是今天，已经过了就顺延到明天。
 *      它响完**不删**、只是被自动关掉（`enabled:false`，见 `markFired`）——
 *      这样列表里还留着"昨天 7:00 响过"，用户可以再打开。删掉的话用户会以为丢了。
 *
 *   ③ **秒与毫秒一律抹成 0**：闹钟定在 7:00:00.000。
 *      不抹的话，"现在 6:59:59.500 + 同一个分钟"会算出 7:00:00.500，
 *      而用户看到的是"7:00" —— 显示与实际差半秒，排查时会让人怀疑人生。
 *
 *   ④ **计时器**：`startedAt + durationMs`。没开始过（`startedAt` 为空）就是 null。
 *      已经过完了（`now` 在后）也返回那个**过去的时刻**（不是 null）：
 *      调用方要靠它判断"这个计时器已经结束"，返回 null 就分不清"没开始"和"已结束"。
 *
 *   ⑤ **自定义星期**：从今天开始往后找最多 7 天，找到第一个"选中的星期且时刻未过"的那天。
 *      用「往后逐天试」而不是"算天数差"，是因为跨月/跨年/闰年/夏令时全部自动正确 ——
 *      算天数差的写法在夏令时切换那天会差一小时，而那种 bug 一年只出现两次，没人查得出来。
 *
 * @param {object} alarm
 * @param {Date|string|number} [now]
 * @returns {Date|null}
 */
export function nextFireAt(alarm, now) {
  const a = normalizeAlarm(alarm, now);
  const t0 = asDate(now || new Date()).getTime();
  if (!Number.isFinite(t0)) return null;

  if (a.kind === 'timer') {
    if (!a.startedAt) return null;                       // 没开始过 → 没有"下次"
    const start = asDate(a.startedAt).getTime();
    if (!Number.isFinite(start)) return null;
    return new Date(start + a.durationMs);               // 规则④：过了也给过去那一刻
  }

  const days = weekdaysOf(a);
  const maxAhead = a.repeat === 'once' || a.repeat === 'daily' ? 1 : 7;

  for (let i = 0; i <= maxAhead; i += 1) {
    const cand = new Date(t0);
    cand.setDate(cand.getDate() + i);
    cand.setHours(a.atHour, a.atMinute, 0, 0);           // 规则③
    const ms = cand.getTime();
    if (ms <= t0) continue;                              // 已过点 → 顺延（规则②/⑤）
    if (a.repeat === 'daily' || a.repeat === 'once') return cand;
    if (days.includes(cand.getDay())) return cand;
  }
  // 走到这里说明 weekdays 是空的（`custom` 没选任何一天）——
  // ⚠️ 返回 null 而**不是**"随便挑一天"：宁可这条不排，也不能在用户没选的日子把他吵醒。
  return null;
}

/**
 * 这条闹钟响过之后该变成什么样。
 *
 * ⚠️ 为什么要一个专门的函数（而不是让调用方自己写 if）：
 *   "响完要不要关掉"是这个功能的语义核心，写错的表现是**每天重复响**或者
 *   **再也不响**，而两者都只在真机上、隔一天才看得出来。放这里就能被测试钉住。
 *
 *   · `once`  → 关掉（`enabled:false`）但**保留**记录（规则②）
 *   · 其它重复 → 原样（下一次由 `nextFireAt` 自然算出来）
 *   · `timer` → 关掉 + 清掉 `startedAt`（否则它会被算成"已结束"，列表里一直挂着一颗死的）
 */
export function markFired(alarm, now) {
  const a = normalizeAlarm(alarm, now);
  // 三目而不是 `now || new Date()` —— 理由见 normalizeAlarm 里那段长注释
  const at = asDate(now === undefined ? new Date() : now).toISOString();
  if (a.kind === 'timer') {
    return { ...a, enabled: false, startedAt: null, updatedAt: at };
  }
  if (a.repeat === 'once') return { ...a, enabled: false, updatedAt: at };
  return a;
}

// ---------------------------------------------------------------------------
// 计时器的两个纯计算（视图每一帧都要用，所以必须便宜且无副作用）
// ---------------------------------------------------------------------------

/** 计时器还剩多少毫秒（没开始过 → null；已结束 → 0，**不是负数**） */
export function timerRemainingMs(alarm, now) {
  const a = normalizeAlarm(alarm, now);
  if (a.kind !== 'timer' || !a.startedAt) return null;
  const end = nextFireAt(a, now);
  if (!end) return null;
  const left = end.getTime() - asDate(now || new Date()).getTime();
  return left > 0 ? left : 0;
}

/** 计时器的结束时刻（没开始过 → null） */
export function timerEndsAt(alarm, now) {
  const a = normalizeAlarm(alarm, now);
  if (a.kind !== 'timer' || !a.startedAt) return null;
  return nextFireAt(a, now);
}

/** 毫秒 → 倒计时文本 `mm:ss` / `h:mm:ss`。给计时器的大字用 */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const p2 = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

/** 毫秒 → 人话时长（"25 分钟" / "1 小时 30 分钟" / "45 秒"） */
export function formatDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (total < 60) return `${total} 秒`;
  const mins = Math.floor(total / 60);
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours && rest) return `${hours} 小时 ${rest} 分钟`;
  if (hours) return `${hours} 小时`;
  return `${mins} 分钟`;
}

/**
 * 一句中文描述（列表每行、诊断区、通知文案都可能用它）。
 *
 * ⚠️ 三种情况都要说清楚，别只说一半：
 *   · 时钟闹钟 → "每天 07:00"（**重复在前、时刻在后**，因为用户扫列表时先看"哪天"）
 *   · 计时器   → "25 分钟倒计时"
 *   · 关掉的   → 前面加"（已关）"，否则列表里开着关着的看起来一模一样
 */
export function describeAlarm(alarm, now) {
  const a = normalizeAlarm(alarm, now);
  const head = a.enabled ? '' : '（已关）';
  const label = a.label ? `「${a.label}」` : '';
  const snd = soundById(a.sound);

  if (a.kind === 'timer') {
    const left = timerRemainingMs(a, now);
    const running = left !== null && left > 0 ? `，还剩 ${formatCountdown(left)}` : '';
    return `${head}${label}${formatDuration(a.durationMs)}倒计时${running}（铃声：${snd ? snd.label : '系统默认'}）`;
  }

  const hm = `${String(a.atHour).padStart(2, '0')}:${String(a.atMinute).padStart(2, '0')}`;
  let when = REPEAT_LABEL[a.repeat] || '只响一次';
  if (a.repeat === 'custom') {
    const list = weekdaysOf(a);
    when = list.length ? list.map((d) => WEEK_CN[d]).join('、') : '自定义（还没选星期）';
  }
  return `${head}${label}${when} ${hm} 响（铃声：${snd ? snd.label : '系统默认'}）`;
}

/** 下一次响的**人话**（"今天 07:00" / "明天 07:00" / "已结束"）。列表副标题用 */
export function describeNextFire(alarm, now) {
  const at = asDate(now || new Date());
  const next = nextFireAt(alarm, at);
  if (!next) return '还没开始';
  if (next.getTime() <= at.getTime()) return '已结束';
  const d0 = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const d1 = new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime();
  const diff = Math.round((d1 - d0) / DAY_MS);
  const day = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天'
    : `${WEEK_CN[next.getDay()]}（${next.getMonth() + 1}月${next.getDate()}日）`;
  return `${day} ${hhmm(next)}`;
}

// ---------------------------------------------------------------------------
// 总览：一个地方看到**全部**已创建的闹钟（2026-10-02 用户："我需要一个显示
// 已创建闹钟的地方，同时我要可删改"）
// ---------------------------------------------------------------------------
//
// ⚠️ 为什么需要这一组纯函数（而不是在视图里现算）：
//   症状的起因就是"**数字与列表用的是两份算法**" —— 标题写着"共 12 条"，
//   列表里却只有 1 行。因为 `subtitle` 数的是 `alarms.length`（含计时器），
//   而计时器那一块**只画正在跑的那一条** —— 于是"跑完的计时器"全都成了
//   **看不见、删不掉**的幽灵记录（点一次「5 分钟开始」就多一条，只增不减）。
//   所以：**计数、排序、该显示什么都从这一份来**，视图不许自己另算一套。

/** 一条闹钟此刻处于什么状态。列表每行、计数、开关按钮都靠它 */
export const ALARM_PHASES = Object.freeze(['running', 'paused', 'waiting', 'ended', 'off']);

/** 状态 → 一句话（列表上的小徽标） */
export const PHASE_LABEL = Object.freeze({
  running: '正在倒计时',
  paused: '已暂停',
  waiting: '会响',
  ended: '已结束',
  off: '已关掉',
});

/**
 * 这条闹钟现在是什么状态。
 *
 * ⚠️ 三处容易搞错、每一处都对应一个真实症状：
 *   · **关掉的计时器 ≠ 已结束的计时器**：前者用户主动关的，后者是跑完了。
 *     混成一种，"清掉已结束的"就会把用户想留着的东西也扫走。
 *   · `startedAt === null` 的计时器 = **响过之后被 `markFired` 清过**（见那个
 *     函数）或从没开始过 —— 都是"什么都不剩"的死记录，归 `off`。
 *   · 定时器（clock）没有"已结束"：`once` 响过就被关掉（`enabled:false` → `off`），
 *     重复的永远有下一次。所以 clock 只可能是 `waiting` 或 `off`。
 *
 * @returns {'running'|'paused'|'waiting'|'ended'|'off'}
 */
export function alarmPhase(alarm, now) {
  const at = now === undefined ? new Date() : now;
  const a = normalizeAlarm(alarm, at);

  if (a.kind === 'timer') {
    if (!a.enabled || !a.startedAt) return 'off';
    const left = timerRemainingMs(a, at);
    if (left === null) return 'off';
    if (left > 0) return a.paused === true ? 'paused' : 'running';
    return 'ended';
  }

  if (!a.enabled) return 'off';
  const next = nextFireAt(a, at);
  if (!next) return 'off';                     // 自定义星期一天都没勾 → 它其实不会响
  return next.getTime() > asDate(at).getTime() ? 'waiting' : 'off';
}

/**
 * 建议清掉的记录：**计时器**里"已经响完"或"从没开始过"的那些。
 *
 * ⚠️ 只碰计时器，**绝不碰定时器** —— 定时器是用户排的班，一条都不能替他删。
 *   这也是这个函数存在的理由：给"清理"画一条**可被测试钉死的**边界，
 *   而不是让视图里写个 `alarms.filter(a => !a.enabled)` 那样误伤一片。
 */
export function staleTimers(alarms, now) {
  return (Array.isArray(alarms) ? alarms : [])
    .map((raw) => normalizeAlarm(raw, now))
    .filter((a) => a.kind === 'timer' && alarmPhase(a, now) !== 'running' && alarmPhase(a, now) !== 'paused')
    .filter((a) => !a.enabled || !a.startedAt || timerRemainingMs(a, now) === 0);
}

/**
 * 列表顺序：**现在最该关心的排最上面**。
 *   ① 正在倒计时 ② 已暂停 ③ 会响的定时器（按"下一次响"从近到远）
 *   ④ 已结束 ⑤ 关掉的
 *
 * ⚠️ 为什么不用 `updatedAt` 倒序（那是最省事的写法）：用户打开这一页是为了
 *   "看看还有什么会响" —— 按更新时间排会把明天早上的闹钟排到一条刚改过的
 *   死计时器下面。同一档里才用"新的在前"，保证刚加的那条看得见。
 *
 * ⚠️ 排序必须**稳定**（同一档、同一时刻时保持原顺序）：否则每次重画列表都在
 *   跳，用户点"删"会点到隔壁那条。所以最后拿原下标兜底，用不着 `Array#sort`
 *   的稳定性（那个在旧宿主上不保证）。
 */
export function sortAlarmsForDisplay(alarms, now) {
  const at = now === undefined ? new Date() : now;
  const rank = { running: 0, paused: 1, waiting: 2, ended: 3, off: 4 };
  return (Array.isArray(alarms) ? alarms : [])
    .map((raw, i) => ({ a: normalizeAlarm(raw, at), i }))
    .sort((x, y) => {
      const rx = rank[alarmPhase(x.a, at)] ?? 9;
      const ry = rank[alarmPhase(y.a, at)] ?? 9;
      if (rx !== ry) return rx - ry;
      const nx = nextFireAt(x.a, at);
      const ny = nextFireAt(y.a, at);
      const tx = nx ? nx.getTime() : Infinity;
      const ty = ny ? ny.getTime() : Infinity;
      if (tx !== ty) return tx - ty;
      const cx = asDate(x.a.createdAt).getTime();
      const cy = asDate(y.a.createdAt).getTime();
      if (cx !== cy) return cy - cx;
      return x.i - y.i;
    })
    .map((e) => e.a);
}

/**
 * 列表顶上那句计数。
 *
 * ⚠️ 这就是 bug 的正面修法：**"开着"不等于"会响"**。跑完的计时器 `enabled`
 *   还是 true，按 `enabled` 数就会报出"共 12 条，开着 12 条"而实际上
 *   只有 1 条会响。这里分开数：会响的（clock 且有下一次）/ 跑着的计时器 /
 *   已经没用的计时器。
 */
export function summarizeAlarms(alarms, now) {
  const at = now === undefined ? new Date() : now;
  const list = (Array.isArray(alarms) ? alarms : []).map((raw) => normalizeAlarm(raw, at));
  const phase = (a) => alarmPhase(a, at);
  const clocks = list.filter((a) => a.kind === 'clock');
  const timers = list.filter((a) => a.kind === 'timer');
  return {
    total: list.length,
    clocks: clocks.length,
    clocksLive: clocks.filter((a) => phase(a) === 'waiting').length,
    clocksOff: clocks.filter((a) => phase(a) === 'off').length,
    timers: timers.length,
    timersRunning: timers.filter((a) => phase(a) === 'running').length,
    timersPaused: timers.filter((a) => phase(a) === 'paused').length,
    timersEnded: timers.filter((a) => phase(a) === 'ended').length,
    timersStale: staleTimers(timers, at).length,
    /** 真正会响的条数（定时器到点会响的 + 计时器正在跑的） */
    live: clocks.filter((a) => phase(a) === 'waiting').length + timers.filter((a) => phase(a) === 'running').length,
  };
}

/** 计数 → 标题下面那一行中文（视图和测试都用这一份，别再各拼一份） */
export function describeAlarmCount(alarms, now) {
  const s = summarizeAlarms(alarms, now);
  if (!s.total) return '还没有闹钟';
  const bits = [`共 ${s.total} 条`];
  bits.push(`会响的 ${s.live} 条`);
  if (s.timers) {
    const t = [`计时器 ${s.timers} 条`];
    t.push(`跑着 ${s.timersRunning}`);
    if (s.timersPaused) t.push(`暂停 ${s.timersPaused}`);
    if (s.timersStale) t.push(`已结束/没用 ${s.timersStale}`);
    bits.push(`（${t.join(' · ')}）`);
  }
  return bits.join('，').replace('，（', '（');
}

// ---------------------------------------------------------------------------
// 交给原生壳的排程计划
// ---------------------------------------------------------------------------

/**
 * 排出"现在该交给系统守着的那些闹钟"。
 *
 * ⚠️ 这是**网页 ↔ 壳的契约**，字段刻意小（和 core/notify-plan.js 同一个思路）：
 *   { id, kind, fireAt, repeat, weekdays, sound, label, title }
 *   · `fireAt` 是**绝对 UTC ISO 字符串** —— 壳直接转成系统时间，不做任何时区推算
 *   · `id` 稳定（同一条闹钟每次算出同一个 id）→ 重排时是**替换**不是堆积
 *   · `sound` 是**文件名（不带扩展名）**或 **null**（null = 用系统默认闹钟音）
 *   · `weekdays` 只有 `custom` 时非空（0=周日…6=周六，**和 JS 一致，别在壳里再换一套**）
 *
 * ⚠️ 三条过滤，缺一条都会出怪事：
 *   ① 关掉的（`enabled:false`）不排 —— 否则"我明明关了它还是响了"
 *   ② 已经过去的（`fireAt <= now`）不排 —— 否则一次重排会立刻拉响一串旧闹钟
 *   ③ 只留**最早** `MAX_SCHEDULED` 条 —— 系统有数量上限，远处的等下次打开重排
 *
 * ⚠️ 计时器**不在这个计划里**：倒计时是"按了才开始"的一次性动作，
 *    由 UI 直接发一条 `alarmTimer` 消息给壳（见 web/adapter/alarms.js），
 *    不参与"每次重排整批"这条链路。混在一起的话，每次数据变动都会把正在跑的
 *    倒计时重排一遍 —— 那等于把用户的计时器重置了。
 */
export function planAlarmSchedule(alarms, { now = new Date(), max = MAX_SCHEDULED, customFile = null } = {}) {
  const t0 = asDate(now).getTime();
  const opts = { customFile };
  const out = [];
  for (const raw of (Array.isArray(alarms) ? alarms : [])) {
    const a = normalizeAlarm(raw, now);
    if (!a.enabled) continue;                            // ①
    if (a.kind !== 'clock') continue;                    // 计时器不走这条路
    const next = nextFireAt(a, now);
    if (!next) continue;
    if (next.getTime() <= t0) continue;                  // ②
    out.push({
      id: a.id,
      kind: a.kind,
      fireAt: next.toISOString(),
      repeat: a.repeat,
      weekdays: a.repeat === 'custom' ? weekdaysOf(a) : [],
      // ⚠️ `sound` 只发给壳（真正给系统的文件名）；`soundId` **只给界面看**。
      //    为什么要多带一个：`sound` 是个不带扩展名的裸文件名，用户在自己手机上
      //    看到"铃声=timetable-custom-9f3a1c07"是完全没法核对的 —— 而诊断区的
      //    全部意义就是"让用户能核对"。见 `describeSchedule`。
      sound: soundFileOf(a.sound, opts),
      soundId: String(a.sound),
      label: a.label,
      title: alarmTitle(a),
    });
  }
  out.sort((x, y) => new Date(x.fireAt) - new Date(y.fireAt));
  return max > 0 ? out.slice(0, max) : out;               // ③
}

/**
 * 锁屏上那行标题。
 *
 * ⚠️ 官方建议 **4–5 个词**，而锁屏横幅截断得很厉害 —— 所以这里就截断，
 *    而不是把一整句描述塞进去（那正是 `AlarmKitScheduler` 里踩过的坑）。
 */
export function alarmTitle(alarm) {
  const a = normalizeAlarm(alarm);
  const base = a.label ? a.label : (a.kind === 'timer' ? '计时器' : '闹钟');
  return base.slice(0, 12);
}

/**
 * 诊断区要显示的一行。
 *
 * ⚠️ 为什么把这个拼字符串的活放在 core：诊断信息是**用户唯一能看到的证据**
 *    （他没有 Mac、看不了日志）。它必须和"实际排了什么"用同一份数据源，
 *    在视图里另拼一份就会出现"显示 3 条、实际排了 2 条"这种最误导人的情况。
 */
export function describeSchedule(plan, now, opts) {
  const list = Array.isArray(plan) ? plan : [];
  if (!list.length) return '现在没有要排的闹钟（都关掉了，或者时刻都已经过去）';
  const at = asDate(now || new Date());
  const d0 = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return list.map((p, i) => {
    const when = new Date(p.fireAt);
    const d1 = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
    const diff = Math.round((d1 - d0) / DAY_MS);
    const day = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天'
      : `${WEEK_CN[when.getDay()]}（${when.getMonth() + 1}月${when.getDate()}日）`;
    // ⚠️ 显示**用户选的那首**（`soundId` → 界面上的名字），不是裸文件名。
    //    自定义铃声如果本机已经没那个文件了（换过设备/删过），这里必须说清
    //    "会响系统默认音" —— 否则用户排了闹钟、到点听到系统音，只能自己猜为什么。
    const custom = isCustomSoundId(p.soundId);
    // 有文件在响：自定义的显示"自定义 · <名字>"，内置的显示目录里的中文名。
    // 没文件可用：分两种说清 —— "这台设备上没有那首自定义音" / "系统默认闹钟音"。
    const snd = p.sound
      ? (custom ? `${soundLabelOf(p.soundId, opts) || p.sound}（自定义）`
        : ((soundById(p.soundId) || {}).label || p.sound))
      : (custom || p.soundId === LEGACY_CUSTOM_SOUND_ID
        ? '系统默认音（那首自定义铃声不在这台设备上）'
        : '系统默认闹钟音');
    const rep = p.repeat && p.repeat !== 'once' ? `，重复=${p.repeat}${p.weekdays && p.weekdays.length ? '[' + p.weekdays.join(',') + ']' : ''}` : '';
    return `${i + 1}. ${day} ${hhmm(when)}${rep}　id=${p.id}　铃声=${snd}`;
  }).join('\n');
}
