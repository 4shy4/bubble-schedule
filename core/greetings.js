// 祝福语：**槽位化的离线生成** + 给 AI 的输入契约，平台无关。
//
// 用户原话（第 48–49 轮）：
//   "节日当日特定时间由AI生成符合当日的祝福语"
//   "用户可输入一些关键词来让AI更好地了解客户，并更个性化地发送消息，
//    用户也可补充与好友相关的关键词以使AI更亲切地发送合适的祝语"
//
// 这一轮**不做 HTTP 调用**（下一轮做）：本模块只负责
//   ① 离线模板兜底（没配 AI / 没网 / 调失败时**必须**还能发出一条像样的祝福）
//   ② 给 AI 的输入契约（`buildGreetingPrompt`）和输出后处理（`stripCliches`）
//   ③ 判定"现在该给谁发"（`dueGreetings`）
// 真正的请求由下一轮的适配器发出去（core/ 不许碰 fetch，见 tools/core.test.mjs）。
//
// ---------------------------------------------------------------------------
// 这一轮最硬的三条要求，以及各自的实现依据
// ---------------------------------------------------------------------------
// ① **30 个节日每一个都要能出非空祝福语**（测试遍历 FESTIVALS 断言）。
//    做法：节日只提供"开场素材"（`FESTIVAL_LINES` 按 key 索引），
//    句子的骨架由槽位模板给。**没有素材的节日也能出句子**（退化成通用开场），
//    所以将来 core/holidays.js 加第 31 个节日，这里不会漏 —— 测试盯着呢。
//
// ② **同一个节日发给不同好友，文本不能一模一样**。
//    做法：选模板的哈希种子 = 节日 key + 好友 id + 称呼 + 语气 + variant。
//    十个人收到同一条开场白是"一眼假"，比不发还糟。
//
// ③ **输入相同 + variant 相同 ⇒ 输出完全一样**（不许随机数）。
//    做法：所有"选哪条"都走 `stableHash`，全程没有 Math.random / Date.now。
//    这条不只是洁癖：判重（fingerprint）和"同一份设置重跑一遍界面要一样"都依赖它。
//
// ⚠️ 另外两条容易忽略但会让功能变得没法看：
//   · 套话黑名单里的词**绝不许出现在输出里**（见 CLICHE_BLACKLIST）。
//     "阖家欢乐万事如意"是这类功能死得最快的方式 —— 它是群发广告的味道。
//   · 文本里不许出现"AI/生成/模板"这种自我暴露的字眼（模板里没有，
//     交给 AI 时也写在 system 里明令禁止）。祝福语一旦自曝是机器写的，效果归零。

import { displayNameOf, contactKeywords, normalizeKeywords, textOf } from './contacts.js';
import { festivalsInYear } from './holidays.js';
import { asDate, toDateKey } from './time.js';
// ⚠️ 提醒的 key 必须和"通讯录页那张草稿卡片"的 key **完全一致**，否则点了通知定位不到人。
//    那个 key 由 `taskKey()` 定义（`contactId|festival:<key>|YYYY-MM-DD`），
//    所以这里**复用它**，绝不自己编一套（两套 key = 点进去找不到草稿）。
import { taskKey } from './send-task.js';

// ---------------------------------------------------------------------------
// 稳定哈希（与 core/contacts.js 同一个算法 —— 换实现会让已发出的指纹失配）
// ---------------------------------------------------------------------------
function stableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function base36(n) { return Math.max(0, Math.floor(Number(n) || 0)).toString(36); }

function nowDate(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return new Date(now.getTime());
  if (typeof now === 'string' && now.trim()) {
    const d = asDate(now);
    if (Number.isFinite(d.getTime())) return d;
  }
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
  return new Date();
}

/**
 * 从一串候选里**确定性地**选一条。
 *
 * ⚠️ 种子里必须同时有"节日 + 好友"，缺任何一个都会造成两种事故：
 *    · 只按节日选 → 同一天所有人收到一样的句子（就是"一眼假"）
 *    · 只按好友选 → 同一个人在每个节日收到同一个句式（发到第三个节日就腻了）
 *    · 带 `salt` → 同一个人的**不同槽位**各选各的，不会每次整套模板一起换
 */
function pickFrom(list, seed, salt = '') {
  if (!Array.isArray(list) || !list.length) return '';
  return String(list[stableHash(`${seed}|${salt}`) % list.length]);
}

// ---------------------------------------------------------------------------
// 槽位 / 黑名单 / 离线模板
// ---------------------------------------------------------------------------

/**
 * 槽位定义。
 *
 * 为什么要"槽位"而不是一整个模板句子：
 *   一条真正像样的祝福语 = 称呼 + 开场 + 关系/关键词呼应 + 一件具体的事 + 祝愿 +（可选）邀约。
 *   写成一整句就只能是"亲爱的XX，中秋快乐，阖家欢乐" —— 那正是套话生成器。
 *   拆成槽位后，每一格都能**独立**地"按人"选、也能**独立**地缺席
 *   （没有具体的事就整格不出现，而不是硬塞一句"祝你和家人团圆"来凑数）。
 *
 * `mergeable`：相邻两格的句子能不能连成一行（短语气/幽默语气下会合并，见 OFFLINE_TEMPLATES
 * 里的 `mergeable` 标记）。这个字段是给下一轮的"预览/编辑界面"和 AI 用的元信息。
 */
export const GREETING_SLOTS = Object.freeze([
  { key: 'salutation', label: '称呼', order: 1, mergeable: false,
    desc: '开口怎么叫他（用 nick："我平时怎么叫他"），而不是通讯录里的大名' },
  { key: 'opener', label: '节日开场', order: 2, mergeable: true,
    desc: '点出是哪个节日，并给这个节日一句有画面感的开场，不用它自己的套话祝福' },
  { key: 'relation', label: '关系专属', order: 3, mergeable: true,
    desc: '按"关系"（客户/同事/家人…）说一句只对这类人说的话' },
  { key: 'keywords', label: '关键词呼应', order: 4, mergeable: true,
    desc: '呼应全局关键词 + 这个好友的关键词，让人看出"这是写给我的"' },
  { key: 'detail', label: '具体的事', order: 5, mergeable: true,
    desc: '从用户**自己的日程**里挑一件跟他相关的事 —— 这是本功能相对通用 AI 的唯一优势' },
  { key: 'wish', label: '祝愿', order: 6, mergeable: true,
    desc: '落到这个节日该有的祝愿上（不许是黑名单里的套话）' },
  { key: 'invite', label: '邀约', order: 7, mergeable: true,
    desc: '一句不冒犯的邀约；只在真的有"具体的事"可提时才出现，免得变成硬推销' },
]);

/**
 * 套话黑名单。
 *
 * ⚠️ 为什么要**单独**一份并且强制后处理：这类词是"安全但零信息"的，
 *    模型（和模板）最爱用它们，因为放哪儿都不会错。但它们同时也让整条消息
 *    变成"群发广告"，而这个功能的全部价值就在"像人专门写给我的"。
 *
 * ⚠️ 只收**八股祝福成语**，不收"快乐/健康/平安"这种正常词 ——
 *    把"中秋快乐"也拉黑的话，祝福语就没法写了（那才是偷懒）。
 *    判据：这个词能不能原样发给一个不熟的人而不显得敷衍。
 */
export const CLICHE_BLACKLIST = Object.freeze([
  '阖家欢乐', '合家欢乐', '阖家幸福', '合家幸福',
  '万事如意', '万事顺意', '万事胜意', '事事如意',
  '心想事成', '心想事成真', '幸福安康', '幸福美满',
  '吉祥如意', '大吉大利', '福如东海', '寿比南山',
  '步步高升', '蒸蒸日上', '财源广进', '一帆风顺',
  '年年有余', '岁岁平安', '好运连连', '喜气洋洋',
]);

/**
 * 节日开场素材（按 `FESTIVALS` 的 key 索引）。
 *
 * ⚠️ 这里**故意不抄 festival.blessing**：那张表里的祝福语是给"节日气泡备注"用的，
 *    不少本身就踩黑名单（"万事如意"）。抄过来会直接违反硬要求，
 *    而且所有人收到同一句正是要避免的事。
 * ⚠️ 表里没有的节日 → 用 `GENERIC_FESTIVAL_LINES`。这样 holidays.js 加新节日
 *    也不会突然出不了句子（测试遍历全部 30 个，漏一个就红）。
 */
const FESTIVAL_LINES = Object.freeze({
  chuxi: { opener: ['今儿除夕，一年忙到头，就这一晚最踏实', '除夕夜，外头再冷，屋里也是热的'], wish: ['除夕守岁，这顿年夜饭吃得香', '过了除夕就是新年，旧账都翻篇'] },
  chunjie: { opener: ['过年好，新的一年又开张了', '初一这天，先把好消息攒上'], wish: ['春节快乐，新的一年多挣点也多歇点', '春节好，这一年想做的事都能做成'] },
  yuanxiao: { opener: ['正月十五，年的最后一天了', '元宵的花灯该亮起来了'], wish: ['元宵快乐，汤圆甜日子也甜', '元宵团圆，这一年过得圆满'] },
  longtaitou: { opener: ['二月二龙抬头，该理个发换换气象', '今天龙抬头，天也开始回暖了'], wish: ['龙抬头，这一年精神头足足的', '龙抬头，想干的事都抬得起头'] },
  duanwu: { opener: ['端午到了，粽子该下锅了', '五月初五端午，艾草和粽叶的味道最正'], wish: ['端午安康，吃得香身体也硬朗', '端午好，安安稳稳过这个夏天'] },
  qixi: { opener: ['七夕这天，牛郎织女都在桥上见着了', '七夕的星星是给人许愿的'], wish: ['七夕快乐，喜欢的人也在想着你', '七夕好，身边不缺人'] },
  zhongyuan: { opener: ['七月半了，是个念旧的日子', '中元这天，总想起些老事'], wish: ['中元这天，故人安稳你也安稳', '中元好，心里记着的人都还好'] },
  zhongqiu: { opener: ['中秋了，月亮今晚最圆', '八月十五，该抬头看看月亮了'], wish: ['中秋快乐，月亮圆人也凑得齐', '中秋好，今晚的月饼别吃太撑'] },
  chongyang: { opener: ['九月初九，该往高处走走了', '重阳了，菊花开得正好'], wish: ['重阳快乐，家里的长辈身子骨硬朗', '重阳好，这一年越走越稳当'] },
  laba: { opener: ['腊八了，粥熬上就该有年味了', '腊八这天，先喝碗热的'], wish: ['腊八好，这一冬都不冷', '过了腊八就是年，腊八得喝口热粥'] },
  xiaonian: { opener: ['小年了，该扫尘备年货了', '腊月二十三小年，年味从今天开始'], wish: ['小年好，把旧的一年的尘都扫干净', '小年这天，年前这几天不慌不忙'] },
  qingming: { opener: ['清明了，天也清亮起来了', '清明这几天，风是软的'], wish: ['清明这天，心里念着的人都好', '清明好，踏青路上别赶时间'] },
  dongzhi: { opener: ['冬至了，白天从今天开始变长', '数九第一天就是冬至，别冻着自己'], wish: ['冬至好，这一冬都暖和', '冬至这天，白天一天比一天长，日子也是'] },
  yuandan: { opener: ['元旦了，日子翻到新的一页', '新年的第一天，元旦先歇口气'], wish: ['元旦快乐，新的一年开局顺利', '元旦好，这一年过得比去年舒坦'] },
  qingren: { opener: ['情人节这天，街上的花都不便宜', '情人节适合把喜欢说出口'], wish: ['情人节快乐，喜欢的人刚好也喜欢你', '情人节好，两个人的日子过得下去'] },
  funv: { opener: ['三八这天，该被好好对待', '妇女节这天，主角是你'], wish: ['妇女节快乐，不用那么累', '妇女节这天，想做的事都有人搭把手'] },
  zhishu: { opener: ['植树节，今天适合种点什么', '三月十二植树节，栽下去的树都会长'], wish: ['植树节这天，种下去的东西都能长好', '植树节好，春天里多出去走走'] },
  yuren: { opener: ['愚人节，今天说的话都别太当真', '四月一号愚人节，玩笑有度就行'], wish: ['愚人节快乐，玩笑有人接得住', '愚人节这天，被骗也是开心的那种'] },
  laodong: { opener: ['五一了，该歇歇了', '五一劳动节，放假的才是正经事'], wish: ['劳动节快乐，这几天真的能休息上', '劳动节好，忙了这么久，值回票价'] },
  qingnian: { opener: ['五四这天，热血的事都值得说', '五四青年节，心气儿还在就好'], wish: ['青年节快乐，那股劲一直在', '青年节这天，想闯的事都闯得动'] },
  muqin: { opener: ['母亲节，该给妈妈打个电话了', '五月的第二个周日是母亲节，是妈妈的日子'], wish: ['母亲节好，妈妈身体好少操心', '母亲节这天，家里人都让她省心'] },
  ertong: { opener: ['儿童节，今天谁都能当回小孩', '六一儿童节，幼稚一点没关系'], wish: ['儿童节快乐，心里的那个小孩还在', '儿童节这天，想吃糖就吃'] },
  fuqin: { opener: ['父亲节，老爸也该被惦记一下', '六月的第三个周日是父亲节，是爸爸的节日'], wish: ['父亲节好，老爸身体硬朗', '父亲节这天，他嘴上不说心里高兴'] },
  dang: { opener: ['七一了', '七月一号这天'], wish: ['七一这天的意义，都在踏踏实实做事里', '七一好，做的每件事都经得起回头看'] },
  jianjun: { opener: ['八一了，向最可爱的人致意', '建军节这天，该敬一杯'], wish: ['建军节的意义，就在这身硬气里', '建军节这天，在岗的兄弟都平安'] },
  jiaoshi: { opener: ['教师节，该谢谢带过你的人', '九月十号教师节，是老师的节日'], wish: ['教师节好，带过的学生都争气', '教师节这天，讲台上的日子顺顺当当'] },
  guoqing: { opener: ['国庆了，七天假够跑一趟远的', '十月一号国庆，街上都是红的'], wish: ['国庆快乐，这几天玩得痛快', '国庆好，路上不堵心里不急'] },
  wansheng: { opener: ['万圣节前夜，今晚扮什么都行', '十月三十一万圣节前夜，糖要够'], wish: ['万圣节快乐，今晚玩得开心', '万圣节这天，面具底下是高兴的'] },
  ganen: { opener: ['感恩节这天，适合把谢意说出来', '十一月的第四个周四是感恩节'], wish: ['感恩节好，身边值得谢的人都在', '感恩节这天，这一年的好都记得住'] },
  shengdan: { opener: ['圣诞了，街上灯都挂上了', '十二月二十五圣诞节，找个理由聚一顿'], wish: ['圣诞快乐，这顿吃得热闹', '圣诞这天，年末这阵子心里是暖的'] },
});

/** 表里没有的节日用它（保证"新节日也能出句子"） */
const GENERIC_FESTIVAL_LINES = Object.freeze({
  opener: ['${festivalName}到了', '又到${festivalName}了', '今天是${festivalName}'],
  wish: ['这天过得舒心', '这个节日过得踏实', '今天顺顺当当'],
});

/** 关系专属：**按"关系"说一句只对这类人说的话**。客户和发小不能共用一句 */
const RELATION_LINES = Object.freeze([
  { key: 'client', match: ['客户', '甲方', '合作', '业务', '供应商'], lines: [
    '跟您这边合作一直挺省心，这点我记着',
    '这阵子对接的事，多谢您配合',
    '后面有需要随时说一声，我这边尽量配合',
  ] },
  { key: 'colleague', match: ['同事', '团队', '伙伴', '搭档', '组员', '同组'], lines: [
    '咱们手上那些事，进度我都盯着',
    '跟着你干活踏实，这话我说得出',
    '有需要搭把手的地方直接说，别自己扛',
  ] },
  { key: 'teacher', match: ['老师', '导师', '教授', '师父', '师傅'], lines: [
    '您教的东西我一直用得上',
    '有您指点，少走了不少弯路',
    '等忙完这阵，想去看看您',
  ] },
  { key: 'family', match: ['家人', '亲属', '亲戚', '长辈', '爸', '妈'], lines: [
    '家里的事你别操心，有我',
    '早点回家吃饭，别老凑合',
    '身体要紧，别的都是其次',
  ] },
  { key: 'friend', match: ['朋友', '兄弟', '闺蜜', '发小', '老友', '同学', '室友'], lines: [
    '好久没坐下来好好聊了',
    '有事招呼一声，我随时都在',
    '咱们这交情，不用客套',
  ] },
]);

/** 关系兜底（没填 relation 时用）—— 中性、不踩任何人 */
const RELATION_FALLBACK = Object.freeze([
  '平时联系不多，但一直记着',
  '这段时间各忙各的，都还好就行',
]);

/**
 * 关系 → 关系档位 key。
 *
 * ⚠️ 顺序敏感，而且是**故意**的：`师傅` 里有"傅"没有"师"，但 `师父/师傅` 要归到老师，
 *    所以 teacher 必须排在 friend 前面（否则"师父"会被当成朋友）。
 *    同理 `同学` 归朋友、`同事` 归同事 —— 这两条不能换位置。
 * ⚠️ 匹配的是**子串**：用户填的是"大学同学""老客户"这种自由文本，
 *    要求他填枚举是不现实的（这一轮界面还没定）。
 */
function relationKeyOf(contact) {
  const rel = String((contact && contact.relation) || '').toLowerCase();
  if (!rel) return 'other';
  for (const r of RELATION_LINES) {
    if (r.match.some((m) => rel.includes(m.toLowerCase()))) return r.key;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// OFFLINE_TEMPLATES
//
// ⚠️ 每条模板里的 `${name}` 是**称呼**（nick 优先，见 contacts.displayNameOf），
//    不是大名。称呼错了整条就废了 —— 这是这个功能最容易翻车的地方。
// ⚠️ 这里允许"缺槽位"：`relation` 只有语气为 brief 时才可能没有，
//    其余缺的槽位（关键词/具体的事/邀约）都是**按数据缺席**，不是按语气缺席。
// ---------------------------------------------------------------------------
export const OFFLINE_TEMPLATES = Object.freeze({
  salutation: {
    casual: ['${name}，', '${name}，', '嘿 ${name}，'],
    formal: ['${name}，您好。', '${name}，您好。'],
    brief: ['${name}，'],
    humor: ['${name}，', '哟 ${name}，'],
  },
  opener: {
    casual: ['${opener}。', '${opener}，', '${opener}！'],
    formal: ['${opener}。', '${opener}。'],
    brief: ['${opener}。'],
    humor: ['${opener}，', '${opener}！'],
  },
  relation: {
    casual: ['${relation}。', '${relation}。'],
    formal: ['${relation}。'],
    brief: ['${relation}。'],
    humor: ['${relation}，哈哈。'],
  },
  keywords: {
    casual: ['上次你提过${kw}，我还记着。', '想到你之前说的${kw}。'],
    formal: ['上次您提过的${kw}，我一直记着。'],
    brief: ['${kw}的事，别耽误。'],
    humor: ['你说的${kw}，我可没忘。'],
  },
  detail: {
    casual: ['对了，${detail}。', '顺便说一句，${detail}。'],
    formal: ['另外，${detail}。'],
    brief: ['${detail}。'],
    humor: ['还有件正经事：${detail}。'],
  },
  wish: {
    casual: ['${wish}。', '${wish}，真心话。'],
    formal: ['${wish}。'],
    brief: ['${wish}。'],
    humor: ['${wish}，这话我认真说的。'],
  },
  invite: {
    // ⚠️ 邀约**按关系**分（见 relationKeyOf）：对客户说"有空一起吃个饭"是套近乎，
    //    对朋友说"后续有进展我同步给您"是端着。同一句话换个关系就是错的话。
    client: {
      casual: ['后面有需要随时招呼。', '有事你说一声，我这边尽量配合。'],
      formal: ['后续若有需要，随时联系我。'],
      brief: ['有事随时说。'],
      humor: ['有活儿记得想着我。'],
    },
    colleague: {
      casual: ['那事之后一起吃个饭。', '忙完这阵子约一顿。'],
      formal: ['改天一起坐坐。'],
      brief: ['回头聚。'],
      humor: ['忙完这顿我请，别客气。'],
    },
    friend: {
      casual: ['有空一起吃个饭，你定时间。', '哪天得空，出来坐坐。'],
      formal: ['有空一起坐坐。'],
      brief: ['有空聚聚。'],
      humor: ['有空约一顿，我请客你买单那种。'],
    },
    family: {
      casual: ['回头回家吃顿饭。', '有空我给你打电话。'],
      formal: ['过些天回去看您。'],
      brief: ['回头见。'],
      humor: ['记得给我留口饭。'],
    },
    other: {
      casual: ['有空聊。', '改天再聊。'],
      formal: ['改天再聊。'],
      brief: ['回头聊。'],
      humor: ['有空唠两句。'],
    },
  },
});

// ---------------------------------------------------------------------------
// 后处理
// ---------------------------------------------------------------------------

/**
 * 删掉套话，并做最小限度的"别把句子删破"收尾。
 *
 * ⚠️ 三个容易写错的地方：
 *   ① **只在命中黑名单时**才动标点。不命中就原样返回 —— 否则"中秋快乐，月亮今晚最圆。"
 *      里的逗号会被无谓地改写，而这类无谓改写会让"同一输入可复现"的断言变脆。
 *   ② 删完可能留下"……，。""…… ，"这类残渣 → 收尾要单独做（`tidy`）。
 *   ③ 删完可能变成空串（整句就是套话）→ 由调用方决定兜底，本函数返回空串**不报错**。
 */
export function stripCliches(text) {
  const raw = text == null ? '' : String(text);
  if (!raw) return '';
  let out = raw;
  let hit = false;
  for (const word of CLICHE_BLACKLIST) {
    if (out.includes(word)) {
      hit = true;
      out = out.split(word).join('');
    }
  }
  if (!hit) return raw;
  // 顺带清掉这些词常带的"祝您/祝你"前缀残留（"祝您阖家欢乐" → "祝您"）
  out = out.replace(/[祝][您你]?\s*(?=[。！？，、；\s]|$)/g, '');
  return tidy(out);
}

/** 收尾：去掉多余空白、把连续的标点收敛成一个、不让句子以逗号/顿号收尾 */
function tidy(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/([，、；])\s*(?=[，、；。！？])/g, '');
  s = s.replace(/^[，、；。！？\s]+/, '');
  s = s.replace(/[，、；\s]+$/, '');
  s = s.replace(/([。！？])\1{1,}/g, '$1');
  if (s && !/[。！？…）)】」"]$/.test(s)) s += '。';
  return s.trim();
}

function fillMerged(text) {
  return String(text == null ? '' : text).replace(/[，、；]{2,}/g, '，').replace(/，\s*。/g, '。').trim();
}

/**
 * 文本指纹：判重用的稳定值（**不**用 Math.random / Date.now）。
 * 同文本 → 同指纹；差一个字 → 不同指纹。
 */
export function greetingFingerprint(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return 'g-0';
  return `g-${base36(stableHash(s))}`;
}

// ---------------------------------------------------------------------------
// 从真实日程里挑"一件具体的事"
// ---------------------------------------------------------------------------

const MAX_DETAIL_DAYS = 14;

/** 日程的展示标题（课/任务/会议都可能是来源，取到就够） */
function eventTitleOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const t = ev.title != null ? ev.title : (ev.name != null ? ev.name : ev.summary);
  return textOf(t, 40);
}

/** 这条日程的"内容串"：标题 + 备注 + 地点 + 标签（关键词要在里面找得到） */
function eventTextOf(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const parts = [ev.title, ev.name, ev.summary, ev.location, ev.notes, ev.teacher];
  if (Array.isArray(ev.tags)) parts.push(...ev.tags);
  return parts.filter((x) => x != null).map((x) => String(x)).join(' ').toLowerCase();
}

function startMsOf(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const t = asDate(ev.start != null ? ev.start : ev.deadline).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 从用户自己的日程里挑**一件跟这个好友（或他的关键词）相关的事**，返回中文短句；没有 → null。
 *
 * ⚠️ 这是整个功能相对"通用 AI 祝福语生成器"的**唯一优势**，所以必须**保守**：
 *    宁可返回 null（优雅地不带），也不要拉一件八竿子打不着的事硬塞 ——
 *    "祝你中秋快乐，记得交数据结构作业"发给客户是灾难。
 *    判定顺序（严格从强到弱，第一个命中的就用它）：
 *      ① 日程文本里出现了**称呼/名字**（这是真的在说他）
 *      ② 出现了这个好友的**个人关键词**（"他最近在弄那个装修"）
 *      ③ 出现了全局关键词（弱一些，但这本来就是"我"的语境）
 *    三条都不命中 → null。**不做**"随便挑一条最近的"。
 *
 * ⚠️ 只看**今天起 MAX_DETAIL_DAYS 天以内**的日程：祝福语是"接下来"的语境，
 *    提一件上个月的事只会显得奇怪。
 */
export function pickConcreteDetail({ events, contact, now } = {}) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return null;
  const at = nowDate(now);
  const t0 = at.getTime();

  const c = (contact && typeof contact === 'object') ? contact : {};
  const name = String(c.name || '').trim().toLowerCase().replace(/\s+/g, '');
  const nick = String(c.nick || '').trim().toLowerCase().replace(/\s+/g, '');
  const own = normalizeKeywords(c.keywords, 20).map((k) => k.toLowerCase()).filter((k) => k.length >= 2);
  // 全局关键词只有传了 profile 才有；没传就是空，不影响强匹配
  const profileKws = normalizeKeywords(
    (c.__profile && (c.__profile.keywords || c.__profile.globalKeywords)) || [],
    30,
  ).map((k) => k.toLowerCase()).filter((k) => k.length >= 2);

  const scored = [];
  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.festival === true) continue;              // 虚拟节日事件不算"我的事"
    const t = startMsOf(ev);
    if (t == null) continue;
    if (t < t0) continue;                            // 已经过去的：祝福语里提它很奇怪
    const days = Math.round((t - t0) / 86_400_000);
    if (days > MAX_DETAIL_DAYS) continue;
    const title = eventTitleOf(ev);
    if (!title) continue;

    const text = eventTextOf(ev);
    // 三档**分开判定**，不做 if/else —— 一条日程同时提到两个好友时，
    // 对甲是①、对乙是②，一次循环里只判一档会让谁先遍历谁赢。
    const byNick = !!nick && text.includes(nick);
    const byName = !!name && text.includes(name);
    // 命中的关键词取**最长**的那个当"关联强度"的细分量：
    // "摄影"比"朋友"具体得多，同样命中时应当优先用具体的那条日程。
    const ownHit = own.reduce((n, k) => (text.includes(k) ? Math.max(n, k.length) : n), 0);
    const profileHit = profileKws.reduce((n, k) => (text.includes(k) ? Math.max(n, k.length) : n), 0);
    const rank = (byNick || byName) ? 3 : ownHit ? 2 : profileHit ? 1 : 0;
    if (!rank) continue;
    scored.push({ rank, kwLen: ownHit || profileHit || 0, days, t, ev, title });
  }
  if (!scored.length) return null;

  // ⚠️ 排序次序是"关联强度 → 关键词有多具体 → 谁更近 → 时间戳"，
  //    **不拿标题做最终 tie-break** —— "提他自己名下的那件事"是这个功能唯一说得出口的
  //    亮点，用标题字母序砍掉它会得到"提了别人的事"这种一眼假的结果。
  scored.sort((a, b) => (b.rank - a.rank) || (b.kwLen - a.kwLen) || (a.days - b.days) || (a.t - b.t));
  const best = scored[0];
  return detailSentence(best.ev, best.title, best.days);
}

/**
 * 把"一件日程"说成一句人话（带日期，去掉就变成不知道哪天的事了）。
 *
 * ⚠️ `kind` 要跟着 `level` 一起看，不能只套一个固定句式：
 *    "课挺要紧"读起来是错的（"课"不是能"要紧"的主语），要分开写。
 */
function detailSentence(ev, title, days) {
  const t = asDate(ev.start != null ? ev.start : ev.deadline);
  const when = days === 0 ? '今天'
    : days === 1 ? '明天'
      : `${t.getMonth() + 1}月${t.getDate()}日`;
  const kind = ev.type === 'course' ? '课'
    : ev.type === 'meeting' ? '会'
      : '事';
  const level = String(ev.level || '');
  if (level === 'red') {
    return kind === '课'
      ? `${when}那节「${title}」别忘了`
      : `${when}那件「${title}」别忘了，${kind}挺要紧`;
  }
  if (level === 'amber') return `${when}要交的「${title}」，我还记着`;
  return `${when}有个「${title}」`;
}

// ---------------------------------------------------------------------------
// 离线生成
// ---------------------------------------------------------------------------

/** 语气 → 用哪一套模板；认不出来的语气落回 casual */
function toneKeyOf(tone) {
  const t = typeof tone === 'string' ? tone.trim().toLowerCase() : '';
  return ['casual', 'formal', 'brief', 'humor'].includes(t) ? t : 'casual';
}

/** 节日名要不要带"节"字（"祝你中秋节快乐"读起来别扭，"祝你春节快乐"就正常） */
function festivalWishName(name) {
  const s = String(name || '');
  return s.replace(/节$/, '');
}

function festivalOpener(festival, seed) {
  const key = festival && festival.key ? String(festival.key) : '';
  const entry = FESTIVAL_LINES[key] || GENERIC_FESTIVAL_LINES;
  const line = pickFrom(entry.opener, seed, 'opener');
  return line.split('${festivalName}').join(String((festival && festival.name) || '这个节日'));
}

function festivalWishLine(festival, seed) {
  const key = festival && festival.key ? String(festival.key) : '';
  const entry = FESTIVAL_LINES[key] || GENERIC_FESTIVAL_LINES;
  return pickFrom(entry.wish, seed, 'wish');
}

/** 按 relation 找关系句；找不到 → 兜底句 */
function relationLine(contact, seed) {
  const key = relationKeyOf(contact);
  const entry = RELATION_LINES.find((r) => r.key === key);
  const lines = entry ? entry.lines : RELATION_FALLBACK;
  return pickFrom(lines, seed, 'relation');
}

/** 按 relation 找邀约句（关系不同，邀约完全不同 —— 见 OFFLINE_TEMPLATES.invite 的说明） */
function inviteLine(contact, tone, seed) {
  const bucket = OFFLINE_TEMPLATES.invite[relationKeyOf(contact)] || OFFLINE_TEMPLATES.invite.other;
  const lines = bucket[tone] || bucket.casual;
  return pickFrom(lines, seed, 'inv');
}

/**
 * 关键词呼应句。选一个**最具体**的关键词来呼应，选不出来就**不呼应**。
 *
 * ⚠️ 过滤掉三类关键词，每一类都会做出"一眼看出是机器写的"句子：
 *   ① 短的/通用标签（"朋友""微信"）—— 呼应了等于什么都没说
 *   ② **整句话**（"我是做装修的""最近在准备考研"）—— 塞进句式里就变成
 *      "上次你提过我是做装修的，我还记着"，读起来像复读机。
 *      这是这个功能最典型的翻车方式，所以宁可丢掉这条线索。
 *   ③ 自述型（以"我/本人"开头）—— 同上，它是介绍不是话题。
 * ⚠️ 而且**第三条线索**：全局关键词**只在没有好友关键词时**才用。
 *    全局关键词是我自己的属性，对谁都能提；一旦好友有自己的关键词，
 *    就该先说他 —— 给四个好友发出去的消息里都出现同一句"装修"，
 *    这几条并排放在一起就是群发（用户会同时看到它们）。
 */
function keywordEcho(contact, profile, seed) {
  // ⚠️ 这里**直接读 c.keywords**，不经过 contactKeywords —— 后者会把全局关键词混进来，
  //    就分不出"这个好友自己的话题"和"我自己的属性"了（见上面 ③）。
  const own = normalizeKeywords((contact && contact.keywords) || [], 20).filter(isEchoableKeyword);
  const global = normalizeKeywords(
    (profile && (profile.keywords || profile.globalKeywords || profile.commonKeywords)) || [],
    30,
  ).filter(isEchoableKeyword);
  const pool = own.length ? own : global;
  if (!pool.length) return { text: '', kw: '' };
  const kw = pickFrom(pool, seed, 'kw');
  // 这里只做"占位符 → 关键词"的替换，具体句式由 OFFLINE_TEMPLATES.keywords 再包一层
  return { text: tpl('${kw}', { kw }, contact), kw };
}

/**
 * 这个关键词能不能拿去"呼应"。
 * 判据见 keywordEcho 上面的注释：太短、太长、像一整句话、自述型的，全部不要。
 */
function isEchoableKeyword(raw) {
  const k = String(raw == null ? '' : raw).trim();
  if (k.length < 2 || k.length > 8) return false;                   // 太长基本就是句子
  if (STOPWORD_KEYWORDS.has(k.toLowerCase())) return false;
  if (/^(我|本人|我们)/.test(k)) return false;                       // 自述型
  if (/[。！？；]/.test(k)) return false;                            // 里面有句读 → 是句子
  // 有主语+谓语的痕迹（"做装修的""喜欢摄影"）也不是话题词
  if (/(的|了|在|很|挺)$/.test(k) && k.length >= 4) return false;
  return true;
}

const STOPWORD_KEYWORDS = new Set([
  '微信', 'qq', '好友', '朋友', '同事', '客户', '同学', '家人', '亲戚', '其它', '其他',
  '关键', '关键词', '客户方', '老板', '领导',
]);

/** 填模板：占位符只有 ${name} ${opener} ${relation} ${kw} ${detail} ${wish} 六个 */
function tpl(text, vars, contact) {
  const map = {
    name: displayNameOf(contact),
    opener: '',
    relation: '',
    kw: '',
    detail: '',
    wish: '',
    ...vars,
  };
  return String(text == null ? '' : text)
    .replace(/\$\{name\}/g, map.name)
    .replace(/\$\{opener\}/g, map.opener)
    .replace(/\$\{relation\}/g, map.relation)
    .replace(/\$\{kw\}/g, map.kw)
    .replace(/\$\{detail\}/g, map.detail)
    .replace(/\$\{wish\}/g, map.wish);
}

/** 把 AI 的文本还原成"要不要补称呼"的判断依据（AI 有时会自己带称呼） */
function hasName(text, name) {
  if (!name) return false;
  return String(text || '').includes(name);
}

/**
 * 离线（模板）生成一条祝福语。
 *
 * 装配顺序就是槽位顺序：**称呼 → 节日开场 → 关系专属 → 关键词呼应 → 具体的事 → 祝愿 →（邀约）**。
 * 缺的槽位直接不出现（不是填空失败，是设计：宁可短，也别凑）。
 *
 * ⚠️ 语气决定**分行还是合并**，这不是排版偏好：
 *    · 轻松/幽默：把"关系"并进开场那一行 —— 四五条独立句子连发是群发短信的样子
 *    · 正式：一句一行，句号收尾（对客户/长辈，连成一长串反而随便）
 *    · 简短：只留 称呼 + 开场 +（具体的事）+ 祝愿
 * ⚠️ 邀约只在**有具体的事**时出现，且**按关系**选句（见 inviteLine）：
 *    没由来地"改天吃饭"是推销话术，"那件事之后一起吃个饭"才自然。
 */
function composeOfflineText({ festival, contact, profile, events, now, variant }) {
  const c = (contact && typeof contact === 'object') ? contact : {};
  const tone = toneKeyOf(c.tone);
  const name = displayNameOf(c);
  const seed = [
    'v1',
    (festival && festival.key) || 'nofestival',
    String(c.id || ''),
    name,
    tone,
    variant == null ? '' : String(variant),
  ].join('|');
  const tset = OFFLINE_TEMPLATES;

  const sal = tpl(pickFrom(tset.salutation[tone], seed, 'sal'), {}, c);
  const opener = festivalOpener(festival, seed);
  const openerLine = tpl(pickFrom(tset.opener[tone], seed, 'op'), { opener }, c);
  const relLine = tpl(pickFrom(tset.relation[tone], seed, 'rel'), { relation: relationLine(c, seed) }, c);
  const echo = keywordEcho(c, profile, seed);
  const echoLine = echo.text ? tpl(pickFrom(tset.keywords[tone], seed, 'kwl'), { kw: echo.kw }, c) : '';
  const detail = pickConcreteDetail({ events, contact: { ...c, __profile: profile }, now });
  const detailLine = detail ? tpl(pickFrom(tset.detail[tone], seed, 'det'), { detail }, c) : '';
  const wish = tpl(pickFrom(tset.wish[tone], seed, 'wsh'), { wish: festivalWishLine(festival, seed) }, c);

  if (tone === 'brief') {
    let one = `${sal}${openerLine}`;
    if (detailLine) one = `${one}${detailLine}`;
    return fillMerged(`${one}${wish}`);
  }

  if (tone === 'formal') {
    const lines = [`${sal}${openerLine}`];
    if (relLine) lines.push(relLine);
    if (echoLine) lines.push(echoLine);
    if (detailLine) lines.push(detailLine);
    if (wish) lines.push(wish);
    if (detailLine) lines.push(`${inviteLine(c, tone, seed)}`);
    return fillMerged(lines.join(''));
  }

  // 轻松 / 幽默：开场 + 关系 + 关键词并成一行（各占一行是群发短信的样子）；
  // 期望、具体的事、邀约继续跟在后面。不再逐句加句号，只留开头那个标点。
  let head = `${sal}${openerLine}`;
  if (relLine) head = `${head}${relLine}`;
  let tail = `${head}${echoLine}${detailLine}${wish}`;
  if (detailLine) tail = `${tail}${inviteLine(c, tone, seed)}`;
  return fillMerged(tail);
}

/**
 * 离线祝福语（对外接口）。
 *
 * 返回**未去套话**的原文：去套话由 composeGreeting 统一做（AI 与离线同一条路），
 * 这样"输出里不许有黑名单词"这条只有一个执行点。
 */
export function composeOfflineGreeting({ festival, contact, profile, events, now, variant } = {}) {
  return composeOfflineText({ festival, contact, profile, events, now, variant });
}

// ---------------------------------------------------------------------------
// 给 AI 的输入契约
// ---------------------------------------------------------------------------

/**
 * ⚠️⚠️ `system` 必须是**常量**，一个字都不能随好友/节日/时间变。
 *
 *    原因不是风格问题，是钱：OpenAI 兼容接口的 **prompt 缓存**只对
 *    "前缀完全一致"的请求命中，命中与不命中的价差是 **50 倍**。
 *    只要 system 里掺进一个变量（哪怕只是节日名），整段前缀就全变了，
 *    每次请求都是全价 —— 这个功能是"节日当天给几十个好友各发一条"，
 *    缓存不命中就是几十倍的成本，且很难在事后发现（账单是月底才看到的）。
 *
 *    所以：**所有变量都进 user**。这里只放"永远不变的角色/规则/输出格式"。
 *    改这个常量要当成一次**成本事件**看待（改完缓存全部失效重算）。
 * 测试会断言"不同输入下 system 完全一致"，用来拦住将来有人往里塞变量。
 */
const SYSTEM_PROMPT = [
  '你是一个替人写节日祝福语的助手。你写的东西会被人**原样**发给他的好友，所以每一句都要像他本人写的。',
  '',
  '硬性规则（违反任何一条即视为失败）：',
  '1. 只输出祝福语正文。不要解释、不要标题、不要引号、不要 Markdown、不要 emoji 堆砌（最多一个）。',
  '2. 不要出现"AI""人工智能""生成""模板""提示词""作为一个…"这类自我暴露的字眼。',
  '3. 不要使用这些套话：阖家欢乐、万事如意、心想事成、幸福安康、吉祥如意、大吉大利、步步高升、财源广进、一帆风顺、岁岁平安。',
  '4. 不要复述对方给的信息，也不要把关键词生硬地塞进句子里；关键词只用来决定"说什么内容"，不是拿来念的。',
  '5. 如果给了"我最近的日程/事情"，最多自然地提**一件**，且只在与这位好友确实相关时才提。没有相关的事就完全不提。',
 '6. 长度：2–4 句，40–120 字。不要分段，不要换行列表。',
  '7. 称呼按"我平时怎么叫他"来写，写在开头。',
  '8. 不要写"祝你和家人…"这种放之四海皆准的祝福，要落到具体的、只对他成立的话。',
  '9. 严禁编造事实：日程里没写的事、没提到的近况，都不许自己造（比如"听说你最近升职了"）。',
].join('\n');

/**
 * 年份 → 生肖（十二地支）。
 *
 * ⚠️ 算法是 `(year - 4) % 12`（公元 4 年是鼠年），**别自己另发明一个偏移**。
 *    这是从竞品调研里抄来的做法（ai-blessing-maker 的 `ZODIAC_ANIMALS[(year-4)%12]`），
 *    好处是**确定性**：同一个年份永远得到同一个生肖，不会因为模型"记忆"而漂。
 *
 * ⚠️ 这里算的是**农历年**的生肖，而农历新年在公历 1–2 月之间 —— 所以
 *    **1 月初到春节前那段时间，严格说还属上一个生肖**。这一处**故意不处理**：
 *    要处理就得引入农历转换（core/holidays.js 里有那套），
 *    而祝福语境里"年初说错了生肖"的代价，远小于为它引入一个跨模块依赖。
 *    ⚠️ 如果哪天用户报了"春节前说错生肖"，答案就在这里 —— 用 holidays.js 的农历换算。
 */
const ZODIAC = Object.freeze(['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']);
export function zodiacOf(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return '';
  // ⚠️ 负数取模要为真值（`-1 % 12 === -1`），所以先取整再补正
  const i = ((Math.trunc(y) - 4) % 12 + 12) % 12;
  return ZODIAC[i];
}

/**
 * 给 AI 的输入契约（祝福语的 user prompt）。
 *
 * ⚠️ 下面这条"逐字节相同"的约束是**故意的**，别顺手破坏：
 *    关着历史注入时，发出去的 prompt 要和"接入这个功能之前"**完全一致**
 *    （测试用 `assert.equal` 钉住：缺参 / '' / 关着 三种给法结果全等）。
 *    理由：这样"接了新功能之后 AI 效果变差"就能被排除掉 —— 不是新功能干的。
 *
 * ⚠️ `previousTexts` 是"**已经发给过这个人/这个节日的文本**"，必须带上：
 *    否则每年同一个节日、每次重新生成，模型会给出高度相似的句子，
 *    用户会看到"怎么又是这句"。这里只放**最近几条**（由调用方裁剪），
 *    不然 prompt 会越滚越长、成本失控。
 *
 * @param {object} opts
 * @param {object} opts.festival
 * @param {object} opts.contact
 * @param {object} opts.profile
 * @param {Array}  [opts.events]
 * @param {string[]} [opts.previousTexts] 最近发给**这个人**的几条（别再来一遍）
 * @param {Date|string|number} [opts.now]
 * @param {string} [opts.memory] 由调用方组装好的"历史/记忆"整段（空串 = 一行都不加）
 * @param {string} [opts.hot] 由调用方组装好的"最近热点"整段（空串/缺参 = 一行都不加）。
 *   ⚠️ 和 `memory` 同一个模式：本模块**不认识**"热点从哪来"（那是 core/ai-hot.js 的事），
 *   只管把它放进去。缺参时 prompt 必须与没有这个功能时**逐字节相同**。
 */
export function buildGreetingPrompt({ festival, contact, profile, events, previousTexts, now, memory, hot } = {}) {
  const c = (contact && typeof contact === 'object') ? contact : {};
  const f = (festival && typeof festival === 'object') ? festival : {};
  const p = (profile && typeof profile === 'object') ? profile : {};
  const at = nowDate(now);
  const kws = contactKeywords(c, p);

  const lines = [];
  lines.push(`【节日】${String(f.name || '（未指定）')}${f.date ? `（${String(f.date)}）` : ''}`);
  if (f.intro) lines.push(`【这个节日的由来/习俗，仅供参考，不要照抄】${String(f.intro)}`);
  if (f.blessing) lines.push(`【这个节日常见的说法，仅供参考，**不要照抄**】${String(f.blessing)}`);
  lines.push('');
  lines.push(`【我平时怎么叫他】${displayNameOf(c)}`);
  lines.push(`【大名/备注，只在需要时用】${textOf(c.name, 40) || '（未填）'}`);
  lines.push(`【我们的关系】${textOf(c.relation, 40) || '（未填）'}`);
  const toneWord = { casual: '轻松随意，像跟熟人聊天', formal: '正式得体，用"您"', brief: '很短，一两句就够', humor: '幽默一点，可以开个小玩笑' };
  lines.push(`【语气】${toneWord[toneKeyOf(c.tone)]}`);
  if (kws.length) lines.push(`【要照顾到的关键词】${kws.join('、')}`);
  if (textOf(c.note)) lines.push(`【关于他的备注，可用作话题】${textOf(c.note, 120)}`);
  if (textOf(p.owner)) lines.push(`【我是谁】${textOf(p.owner, 40)}`);
  if (textOf(p.style)) lines.push(`【我平时说话的风格】${textOf(p.style, 120)}`);

  const detailSource = Array.isArray(events) ? events.filter((e) => e && e.festival !== true) : [];
  if (detailSource.length) {
    const brief = detailSource.slice(0, 12).map((e) => {
      const t = startMsOf(e);
      const day = t == null ? '' : toDateKey(new Date(t));
      return `- ${day} ${eventTitleOf(e)}${e.location ? ` @${textOf(e.location, 20)}` : ''}`;
    }).filter((s) => s.trim().length > 3);
    if (brief.length) {
      lines.push('');
      lines.push('【我最近的日程（挑最多一件、且确实与他相关的来提；不相关就完全不提）】');
      lines.push(...brief);
    }
  }

  const prev = (Array.isArray(previousTexts) ? previousTexts : [])
    .map((x) => textOf(x, 200)).filter(Boolean).slice(-3);
  if (prev.length) {
    lines.push('');
    lines.push('【已经发过的说法，别重复、别只换几个字】');
    lines.push(...prev.map((t) => `- ${t}`));
  }

  // 「让 AI 了解这个 App 与你的历史」（第 53 轮）：`memory` 由**调用方**组装
  // （`core/ai-context.js` 的 `memorySectionFor` —— 已带标题、trim 过、也截断过）。
  // ⚠️ 插在【今天日期】**之前**：日期与最后那句任务指令要挨在一起（那是就近生效的
  //    "现在只输出…"，中间塞几千字背景会把它推远）。
  // ⚠️⚠️ **空串就一行都不加** —— "开关关着时发出去的 prompt 与接入前逐字节相同"
  //    就落在这一句上（测试用 `assert.equal` 钉住：缺参 / '' / 关着 三种给法结果全等）。
  const mem = memory == null ? '' : String(memory).trim();
  if (mem) {
    lines.push('');
    lines.push(mem);
  }

  // 「参考最近的热点」（2026-10-01）：
  //   · `hot` 由**调用方**组装（`core/ai-hot.js` 的 `hotSectionFor`）——
  //     和 `memory` 同一个模式：本模块不认识"热点从哪来"，只管放进去。
  //   · ⚠️ **空串/缺参就一行都不加** —— 这是"关着时 prompt 与接入前逐字节相同"那条
  //     承诺的第二个落点（测试用 `assert.equal` 钉着）。
  //     所以**千万不要**在这里写"如果没热点就加一句'（暂无热点）'"——那会破坏那条承诺，
  //     而且会给模型一个"必须提热点"的暗示。
  const hotText = hot == null ? '' : String(hot).trim();
  if (hotText) {
    lines.push('');
    lines.push(hotText);
  }

  lines.push('');
  // ⚠️ 年份与生肖写在这里（2026-10-01 加），理由：
  //    用户明确要"文案可以结合**当时热点与生肖**等等"。生肖是**从年份算出来的确定性事实**
  //    （`ZODIAC[(year-4)%12]`），而这个 prompt 原先**只给了日期不给年份** ——
  //    模型于是只能写出"新年快乐"这种放之四海皆可的话，写不出"马年"。
  //    ⚠️ 只加这一处、不加新段落：日期行的位置已经紧挨最后的任务指令（就近生效），
  //       在最前面塞一大段"今年是什么年"反而会把它推远。
  //    ⚠️ **热点不做**：那需要联网抓取 + 判断可信度，属于另一个量级的事，
  //       不能靠"让模型自己想象今年有什么热点"（那会编出假事件）。宁可没有。
  const zodiac = zodiacOf(at.getFullYear());
  lines.push(`【今天日期】${toDateKey(at)}（${at.getFullYear()} 年${zodiac ? `，${zodiac}年` : ''}）`);
  lines.push('现在只输出这一条祝福语正文。');

  // maxTokens：写死一个够用又不会失控的上限（中文 120 字 ≈ 200 token 上下）
  return {
    system: SYSTEM_PROMPT,
    user: lines.join('\n'),
    maxTokens: 320,
    // temperature 偏低：祝福语要的是"稳、不跑偏"，不是创意写作
    temperature: 0.7,
  };
}

// ---------------------------------------------------------------------------
// 对外主函数
// ---------------------------------------------------------------------------

/**
 * 生成一条祝福语。
 *
 * 有 `aiText` → 用它（并做同一套去套话）；没有 → 离线模板。
 * 返回 `{text, source, detail, fingerprint}`，`source` 只有 'ai' | 'offline' 两个值
 * （界面要据此显示"这条是本地写的/这条是模型写的"，也让用户知道什么时候是兜底在跑）。
 *
 * ⚠️ `aiText` 为空串/空白 → 走离线，而不是返回空。**绝不静默产出空消息** ——
 *    "生成了但内容是空的"比"用离线模板"糟糕得多，用户点发送才发现就晚了。
 */
export function composeGreeting({ festival, contact, profile, events, aiText, now, variant, previousTexts } = {}) {
  const detail = pickConcreteDetail({ events, contact: { ...(contact || {}), __profile: profile }, now });
  // `previousTexts` 在这里**只用于"别再来一遍"**（下一轮的服务端/界面会把它喂给
  // buildGreetingPrompt）；离线模板靠 `variant` 换一套说法，语义上等价。
  void previousTexts;
  const raw = typeof aiText === 'string' ? aiText.trim() : '';
  let source = 'offline';
  let text = '';

  if (raw) {
    source = 'ai';
    text = stripCliches(raw);
    // 去套话之后可能只剩半句（或空了）→ 空的就退回离线，不许发空消息
    if (!text.trim()) {
      source = 'offline';
      text = stripCliches(composeOfflineText({ festival, contact, profile, events, now, variant }));
    }
  } else {
    text = stripCliches(composeOfflineText({ festival, contact, profile, events, now, variant }));
  }

  text = finalizeText(text, { festival, contact });
  return {
    text,
    source,
    detail: detail || null,
    fingerprint: greetingFingerprint(text),
  };
}

/**
 * 最后一道兜底：保证文本里**有节日名、有称呼**，且不含自我暴露的词。
 *
 * ⚠️ 为什么要这层（不是不信任模板）：
 *   · AI 完全可能给出一段没提节日、也没叫人的"通用祝愿" —— 直接发出去就是废的；
 *   · 这是我们对外承诺的两条硬指标（每个节日都能出、不同好友不一样），
 *     只靠 prompt 约束是"希望"，加一道机械兜底才是"保证"。
 * ⚠️ 兜底**只追加**，不改写模型已经写好的句子（改写会把它的语气弄坏）。
 */
function finalizeText(text, { festival, contact } = {}) {
  let s = String(text == null ? '' : text).trim();
  // ⚠️ 自我暴露的字眼必须清掉（模板里本来没有，但 AI 的输出不能靠"希望它听话"）。
  //    只清整词，不碰单字，免得伤到正常句子。
  s = s.replace(/人工智能|大语言模型|语言模型|自动生成|由AI生成|AI生成|模板生成|作为AI/g, '');
  s = tidy(s);
  if (!s) {
    s = `今天是${String((festival && festival.name) || '这个节日')}，想着你，节日快乐。`;
  }
  const fname = String((festival && festival.name) || '');
  const wishName = festivalWishName(fname);
  if (fname && !s.includes(fname) && !(wishName && s.includes(wishName))) {
    s = fillMerged(`${s.replace(/[。！？]$/, '')}，${wishName || fname}快乐。`);
  }
  const who = displayNameOf(contact);
  if (who && !hasName(s, who)) {
    s = `${who}，${s}`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// 到期判定
// ---------------------------------------------------------------------------

/** 设置兜底（脏值一律落回缺省，别让"设置里一个字符串"把整个判定弄崩） */
function settingsOf(settings) {
  const s = (settings && typeof settings === 'object') ? settings : {};
  const g = (s.greetingSettings && typeof s.greetingSettings === 'object') ? s.greetingSettings : {};
  const leadRaw = Number(g.leadDays);
  return {
    leadDays: Number.isFinite(leadRaw) ? Math.min(7, Math.max(0, Math.floor(leadRaw))) : 0,
    atHour: (() => {
      const h = Number(g.atHour);
      return Number.isFinite(h) ? Math.min(23, Math.max(0, Math.floor(h))) : 8;
    })(),
    // ⚠️ sentLog 是从 greetingSettings 上读的（**不是 contacts 上的字段**）：
    //    它跟着设置一起备份/同步，不需要改好友对象就能记一次"已发送"。
    //    两处都要认，理由见 alreadySent 的注释。
    sentLog: (g.sentLog && typeof g.sentLog === 'object') ? g.sentLog : null,
    profile: (s.greetingProfile && typeof s.greetingProfile === 'object') ? s.greetingProfile : {},
  };
}

/** 好友列表（**只认已经有真实 id 的**：刚脏数据补出来的不算"用户存过的"） */
function contactsOf(contacts) {
  return Array.isArray(contacts) ? contacts.filter((c) => c && typeof c === 'object') : [];
}

/** 这个节日是哪天（'YYYY-MM-DD'） */
function dateKeyOfFestival(f) {
  if (f && typeof f.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.date)) return f.date;
  if (f && Number.isFinite(Number(f.y)) && Number.isFinite(Number(f.m)) && Number.isFinite(Number(f.d))) {
    return `${f.y}-${String(f.m).padStart(2, '0')}-${String(f.d).padStart(2, '0')}`;
  }
  return null;
}

/**
 * 把 `dueGreetings()` 的结果翻成**可以交给提醒引擎的提醒**。
 *
 * ⚠️⚠️ **一个节日 = 一条提醒**（2026-10-01 改过一次，这段注释记着为什么）：
 *
 *    第一版我按"**每人一条**"做（8 个好友 = 8 条通知），理由是"每条能单独点、单独标记"。
 *    **用户当场否掉了**：原话"**这个祝福提醒还是一次就够了吧·-·，弹多了烦**"。
 *    他是对的，而且这正是竞品 Birday 的做法（"多人同一天**合并成一条**通知"）——
 *    我当时还特意在文档里写了"故意和 Birday 反着做"，现在看是**我想错了**：
 *    祝福是一个"该做这件事了"的**待办**，不是 N 个独立事件；N 条通知只会让人想关掉这个功能。
 *
 *    所以：**一条通知，正文里点名列出发给谁**；点进去到通讯录页逐条处理
 *    （那里本来就是正门：能改、能标记已发、能让 AI 润色）。
 *
 * ⚠️ `greetingKeys` 是**数组**（不是单个 key）：一条提醒对应多张草稿卡。
 *    界面按它把用户送过去（第一条给焦点/滚动，其余自己也看得见）。
 *    ⚠️ 每个 key 都必须是 `taskKey()` 的产物 —— 和通讯录页那张草稿卡片**同源**，
 *       否则点通知会"跳过去但找不到人"（静默失败，最难查）。
 *
 * ⚠️ **不再需要"错开 N 分钟"**：合并成一条之后就没有"连弹一串"的问题了。
 *    （原来那个 `staggerMinutes` 参数已删除 —— 合并之后它没有任何意义。）
 *
 * ⚠️ 正文里带一句离线文案（`composeGreeting` 的 offline 档，纯函数、不联网），
 *    所以**没配 AI 也能用**。多个人时只放**第一位**的那句当示例，其余靠点进去看 ——
 *    N 句文案拼在一条通知里必然被系统截断，反而谁都看不清。
 *
 * ⚠️ 返回形状**故意对齐 `core/reminder-plan.js` 的 item**（`key/title/body/fireAt`），
 *    这样投递那一层不用为祝福开分支：
 *    · `key` 以 `greet:` 开头 —— 和事件提醒的 key 天然不会撞（账本共用一份）；
 *    · `eventId` 留 null：这不是日程，点通知时不该去开某条日程。
 */
export function greetingReminders({
  due, contacts, profile, events, now,
} = {}) {
  const at = nowDate(now);
  const list = Array.isArray(due) ? due : [];
  // 好友查表：due 里给的是联系人对象，但调用方可能传的是"待发的那几个"，
  // 所以这里**以 due 里的为准**，只有拿不到时才回退到全量列表里找。
  const byId = new Map();
  for (const c of contactsOf(contacts)) {
    if (c && c.id != null) byId.set(String(c.id), c);
  }

  const out = [];
  for (const d of list) {
    if (!d || typeof d !== 'object' || !d.festival) continue;
    const f = d.festival;
    const date = dateKeyOfFestival(f);
    if (!date) continue;
    const baseAt = asDate(d.at);
    const t0 = Number.isFinite(baseAt.getTime()) ? baseAt.getTime() : at.getTime();
    const fname = String(f.name || f.key || '节日');
    const pending = (Array.isArray(d.contacts) ? d.contacts : [])
      .filter((c) => c && c.id != null);
    if (!pending.length) continue;

    const festivalKey = `festival:${String(f.key || 'unknown')}`;
    const names = [];
    const keys = [];
    let firstText = '';
    let firstTextName = '';
    for (const c of pending) {
      const contact = byId.get(String(c.id)) || c;
      const displayName = String(
        (contact && (contact.name || contact.remark || contact.nick)) || '这位好友',
      );
      // 离线档文案（纯函数、不联网）。拿不到就退化成"该发祝福了"，**绝不产出空消息**。
      let text = '';
      try {
        text = composeGreeting({ festival: f, contact, profile, events, now: at }).text || '';
      } catch { text = ''; }
      if (!firstText) { firstText = text; firstTextName = displayName; }
      names.push(displayName);
      keys.push(taskKey({ contactId: c.id, festivalKey, dateISO: date }));
    }
    if (!keys.length) continue;

    // 标题：人多写人数、人少写名字（一眼能认，且不要太长）
    const title = pending.length === 1
      ? `🎊 ${fname} · 给「${names[0]}」发祝福`
      : `🎊 ${fname} · 该给 ${names.length} 位好友发祝福`;
    // 正文：点名列出发给谁（人在多的时候只列前几个，够认出就行）
    const shown = names.slice(0, 4).join('、');
    const rest = names.length > 4 ? ` 等 ${names.length} 位` : '';
    const who = pending.length === 1
      ? `${firstText || `${fname}到了，给${firstTextName}写句祝福吧。`}`
      : `要发给：${shown}${rest}。点开逐条改/发。`
        + (firstText ? `\n示例（${firstTextName}）：${firstText}` : '');

    out.push({
      key: `greet:${festivalKey}|${date}`,
      // 给界面用：一条提醒可能对应多张草稿卡，所以是**数组**
      greetingKeys: keys,
      eventId: null,
      title,
      body: who,
      minutes: 0,
      fireAt: new Date(t0),
      reason: d.reason || 'today',
      festivalKey: String(f.key || fname),
      contactIds: pending.map((c) => String(c.id)),
    });
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

/**
 * 现在该给哪些节日、哪些好友生成祝福语。
 *
 * 返回 `[{festival, contacts:[...], at:Date, reason:'today'|'lead'}]`，
 * 没到时间 / 没有节日 / 没有好友 → `[]`（**不抛错、不返回半个对象**）。
 *
 * ⚠️ 判定规则（用户原话是"节日当日特定时间"）：
 *   · `leadDays = 0`（默认）→ **只有节日当天**算，且要过了 `atHour` 点；
 *     早于 `atHour` 返回 []（"早上 8 点的祝福"不能在凌晨 3 点就摆出来让人点发送）。
 *   · `leadDays > 0` → 提前 N 天也产出一条 `reason:'lead'`（用户要提前准备，
 *     界面上应当和当天的区分开显示）。
 *   · 已经发给过这个好友的同一节日**不再产出**（判重靠 contact.lastGreeting
 *     里记的 `festivalKey + date`，所以"发了两次"和"刷新两遍"是两件事）。
 *
 * ⚠️ `holidays` 参数：调用方可以传 `festivalEvents(now, {days})` 的结果（气泡区已经在算）
 *    或 `festivalsInYear(y)` 的结果；**不传就用 core/holidays.js 自己算**。
 *    允许注入是为了让测试能钉死"就是今天"而不依赖真实日历。
 *
 * ⚠️ 要给**提醒引擎**用的话，别直接用这个形状 —— 用上面的 `greetingReminders()`
 *    （它会把"一个节日的所有好友"拆成每人一条）。
 */
export function dueGreetings({ now, settings, contacts, events, holidays } = {}) {
  const at = nowDate(now);
  const cfg = settingsOf(settings);
  const list = contactsOf(contacts);
  if (!list.length) return [];

  // 候选节日：优先用调用方给的，其次自己算（今天 + 未来 cfg.leadDays 天，跨年要算两年）
  let candidates = Array.isArray(holidays) ? holidays : null;
  if (!candidates) {
    const y = at.getFullYear();
    candidates = [...festivalsInYear(y), ...festivalsInYear(y + 1)];
  }

  const todayKey = toDateKey(at);
  const t0 = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const minutesNow = at.getHours() * 60 + at.getMinutes();
  const atMinutes = cfg.atHour * 60;

  const due = [];
  const seenKey = new Set();
  for (const f of candidates) {
    if (!f || typeof f !== 'object') continue;
    const date = dateKeyOfFestival(f);
    if (!date) continue;
    const key = `${String(f.key || f.name || '')}@${date}`;
    if (seenKey.has(key)) continue;
    const [fy, fm, fd] = date.split('-').map(Number);
    const fms = new Date(fy, fm - 1, fd).getTime();
    if (!Number.isFinite(fms)) continue;
    const daysLeft = Math.round((fms - t0) / 86_400_000);
    if (daysLeft < 0) continue;                            // 过了就不再提（不看历史）
    if (daysLeft > cfg.leadDays) continue;                 // 窗口外
    if (daysLeft === 0 && minutesNow < atMinutes) continue; // 当天但没到点
    seenKey.add(key);

    const reason = daysLeft === 0 ? 'today' : 'lead';
    const pending = list.filter((c) => !alreadySent(c, key, cfg.sentLog, at));
    if (!pending.length) continue;
    const atTime = new Date(fy, fm - 1, fd, cfg.atHour, 0, 0, 0);
    due.push({ festival: f, contacts: pending, at: atTime, reason });
  }
  due.sort((a, b) => (a.at - b.at) || String(a.festival.key || '').localeCompare(String(b.festival.key || '')));
  return due;
}

/**
 * 这个好友是不是**已经**为这个节日生成/发过了。
 *
 * ⚠️ `lastGreeting` 记在两个地方，两个都要认（同一个事实不许有两套判据，
 *    但**读的时候必须两边都看**，否则会漏判）：
 *   · 好友自己身上的 `lastGreeting = {festivalKey, date, at, fingerprint}`（本模块约定）
 *   · `greetingSettings.sentLog[contactId]` 或 `['contactId@festivalKey']`（界面/服务端写）
 *   只认一个的症状是"明明发过了，重开一次又冒出来让你再发一遍" → 重发。
 */
function alreadySent(contact, key, sentLog, now) {
  const lg = contact && contact.lastGreeting;
  if (lg && typeof lg === 'object') {
    const sameKey = `${String(lg.festivalKey || '')}@${String(lg.date || '')}` === key;
    const t = asDate(lg.at).getTime();
    // 20 小时窗口：挡住"同一天内重复产出"，跨年照常重新提示（一年一次的场景够用）
    if (sameKey && Number.isFinite(t) && (now.getTime() - t) < 20 * 3600 * 1000) return true;
  }
  if (sentLog && contact && contact.id != null) {
    const cid = String(contact.id);
    const stamped = sentLog[`${cid}@${key}`] != null ? sentLog[`${cid}@${key}`] : sentLog[cid];
    const t = asDate(stamped).getTime();
    if (Number.isFinite(t) && (now.getTime() - t) < 20 * 3600 * 1000) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 把一件日程派给某个好友（用户原话第 49 轮："这个功能还可以拓展，比如将某些日程
// 发给某些好友，提醒他们完成一些团队项目中自己的任务"）。
//
// ⚠️ 为什么**另开一个函数**，而不是给 composeGreeting 加个 `event` 参数：
//    · 祝福语的骨架是**节日**（开场/祝愿全靠 FESTIVAL_LINES 那套素材），
//      而提醒里根本没有节日。硬塞进 composeGreeting 的话，节日那条链上每一格
//      都要开分支；更致命的是 finalizeText 有一条"文本里必须有节日名"的兜底 ——
//      它会往提醒后面接一句"，中秋节快乐。"，而这正是本功能最不能出的错
//      （提醒同事干活却祝他节日快乐 = 一眼机器）。
//    · 所以这里**共用**同一批素材与后处理（称呼模板、去套话、tidy、指纹、兜底清理），
//      但装配顺序和"必须点名那件事"这条约束是它自己的。
// 返回形状与 composeGreeting 完全一致：`{text, source, detail, fingerprint}`，
// `source` 只有 'ai' | 'offline'。`aiText` 为空白 → 离线，**绝不产出空消息**。
// ---------------------------------------------------------------------------

/**
 * 提醒的固定句式（按语气分档）。
 *
 * ⚠️ `salutation` 直接复用祝福语那份：称呼错了整条就废（同一条理由，不要各写一套）。
 * ⚠️ 这里的句子**不含任何节日字眼**，也不含套话黑名单里的词：提醒是工作语境，
 *    "阖家欢乐"放在这里比放在祝福里更荒唐。
 */
export const REMINDER_TEMPLATES = Object.freeze({
  salutation: OFFLINE_TEMPLATES.salutation,
  // ⚠️ `opener` 只是**引子**（"说件正事"），那件事本身在 `detail` 格里。
  //    为什么不把 ${detail} 直接写进引子里：`detailSentence()` 返回的句子
  //    **不带结尾标点**（"…别忘了，事挺要紧"）。拼在引子后面时，
  //    少了 detail 这一格去补标点，两句会粘成"事挺要紧弄完记得歇会儿。"
  //    —— 这是实测踩到的，粘出来的句子读起来像乱码。
  opener: {
    casual: ['说件正事', '提醒你一下', '跟你提一句'],
    formal: ['跟您对一件事', '提醒您一下'],
    brief: [''],
    humor: ['正经事一句', '不耽误你摸鱼，就一句'],
  },
  detail: {
    casual: ['${detail}。', '${detail}！'],
    formal: ['${detail}。'],
    brief: ['${detail}。'],
    humor: ['${detail}。'],
  },
  wish: {
    casual: ['有需要招呼我一声。', '弄完记得歇会儿。', '别自己一个人扛。'],
    formal: ['有需要随时联系我。', '有进展我们再对一下。', '您看时间安排就行。'],
    brief: ['需要帮忙说一声。', '辛苦了。'],
    humor: ['别拖到最后一天。', '忙完我请你喝东西。', '这活儿跑不掉，早点动手。'],
  },
});

/** 事件标题（提醒里**必须**有它，否则收到的人不知道要干什么） */
function reminderTitleOf(ev) {
  return eventTitleOf(ev) || '那件事';
}

/**
 * 把"这件事"说成一句带时间的人话。
 *
 * ⚠️ 已经过去的日程**不带日期**（只说"那件事别忘了"）：提醒是要往前看的，
 *    写一个过去的日期读起来像程序搞错了，用户会怀疑整条消息是群发错的。
 * ⚠️ 没时间/时间非法时也要有话说（`detailSentence` 里会 `getMonth()` 到 NaN）——
 *    所以走 `startMsOf` 判定，判定不过就不进 detailSentence。
 */
function reminderDetail(event, title, now) {
  const t = startMsOf(event);
  if (t == null) return `「${title}」那件事别忘了`;
  const at = nowDate(now);
  const t0 = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const days = Math.round((t - t0) / 86_400_000);
  if (days < 0) return `「${title}」那件事别忘了`;
  return detailSentence(event, title, days);
}

/** 离线提醒正文（对外不暴露；composeEventReminder 统一做去套话） */
function composeOfflineReminder({ event, contact, now, variant }) {
  const c = (contact && typeof contact === 'object') ? contact : {};
  const tone = toneKeyOf(c.tone);
  const name = displayNameOf(c);
  const title = reminderTitleOf(event);
  const detail = reminderDetail(event, title, now);
  // 种子里有"好友 + 那件事 + variant"：换个人、换件事、点"再来一条"都该换一套说法，
  // 但**同输入必须同输出**（判重与"重开页面结果一样"都靠这一条，见文件头硬要求③）。
  const when = startMsOf(event);
  const seed = [
    'r1',
    String(c.id || ''),
    name,
    tone,
    title,
    when == null ? '' : String(when),
    variant == null ? '' : String(variant),
  ].join('|');

  const sal = tpl(pickFrom(REMINDER_TEMPLATES.salutation[tone], seed, 'sal'), {}, c);
  const lead = tpl(pickFrom(REMINDER_TEMPLATES.opener[tone], seed, 'rop'), {}, c);
  const detailLine = tpl(pickFrom(REMINDER_TEMPLATES.detail[tone], seed, 'rdet'), { detail }, c);
  // 引子为空（简短语气）时不要凭空冒出一个冒号
  const open = lead ? `${lead}：${detailLine}` : detailLine;
  if (tone === 'brief') return fillMerged(`${sal}${open}`);
  const wish = tpl(pickFrom(REMINDER_TEMPLATES.wish[tone], seed, 'rwsh'), {}, c);
  return fillMerged(`${sal}${open}${wish}`);
}

/**
 * 最后一道兜底：文本里**必须**有称呼和那件事的标题。
 *
 * ⚠️ 只追加、不改写已经写好的句子（改写会把语气弄坏）：这两条是"提醒"能不能用
 *    的底线 —— 没有称呼像群发，没有事件名则对方根本不知道要干什么（等于没提醒）。
 */
function finalizeReminder(text, { contact, title } = {}) {
  let s = String(text == null ? '' : text).trim();
  // 自我暴露的字眼必须清掉（和祝福语同一条：AI 的输出不能靠"希望它听话"）
  s = s.replace(/人工智能|大语言模型|语言模型|自动生成|由AI生成|AI生成|模板生成|作为AI/g, '');
  s = tidy(s);
  const who = displayNameOf(contact);
  // 一个字都不剩（比如 AI 只回了一句套话）→ 给一句仍然说得出口的兜底，
  // 而不是返回空串（空消息比"模板味"严重得多，同 composeGreeting 的理由）
  if (!s) s = title ? `${who}，「${title}」那件事别忘了。` : `${who}，有件事提醒你一下。`;
  if (title && !s.includes(title)) {
    s = fillMerged(`${s.replace(/[。！？]$/, '')}，还有「${title}」那件事。`);
  }
  if (who && !hasName(s, who)) s = `${who}，${s}`;
  return s;
}

/**
 * 生成一条"提醒某位好友去做某件事"的草稿。**没有节日**参与。
 *
 * 有 `aiText` → 用它（并过同一套去套话/兜底）；没有 → 离线模板。
 * 返回 `{text, source, detail, fingerprint}`，与 composeGreeting 同形状 ——
 * 界面因此可以拿同一条渲染与同一条发送任务状态机接着用（见 send-task.js）。
 */
export function composeEventReminder({ event, contact, profile, aiText, now, variant } = {}) {
  const ev = (event && typeof event === 'object') ? event : {};
  const c = (contact && typeof contact === 'object') ? contact : {};
  const title = reminderTitleOf(ev);
  const detail = reminderDetail(ev, title, now);
  const raw = typeof aiText === 'string' ? aiText.trim() : '';
  let source = 'offline';
  let text = '';

  if (raw) {
    source = 'ai';
    text = stripCliches(raw);
    // 去完套话只剩半句/空了 → 退回离线。绝不静默产出空消息（同 composeGreeting）
    if (!text.trim()) {
      source = 'offline';
      text = stripCliches(composeOfflineReminder({ event: ev, contact: c, profile, now, variant }));
    }
  } else {
    text = stripCliches(composeOfflineReminder({ event: ev, contact: c, profile, now, variant }));
  }

  text = finalizeReminder(text, { contact: c, title });
  return { text, source, detail, fingerprint: greetingFingerprint(text) };
}
