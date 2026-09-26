// 节日（中国传统节日 + 热门节日）—— **数据 + 查询**，平台无关。
//
// 用户原话（第 46 轮）：
//   "我要一个节日日程板块，我要月历里载入包括但不限于中国传统节日和热门节日的节日，
//    其次，气泡区在节日还剩 **天时（默认4天，用户可调）出现节日气泡
//    （我需要一个专用的颜色气泡，区分于其它气泡，备注里注明祝福语和节日介绍·-·）"
//
// 所以这个模块要提供三件事：
//   1. **节日表**：名字 + 哪天（农历/公历/节气）+ 祝福语 + 介绍 + 专用颜色
//   2. `festivalsInYear(y)` / `festivalsOn(y,m,d)`：月历要按天挂标签
//   3. `upcomingFestivals(now, {days})`：气泡区要"还剩 N 天时浮出来"
//
// ⚠️ 节日表**不是事件**：它不进 `data/db.json`，是"算出来的"（公历节日每年都有、
//    农历节日按农历表换算）。这样不需要每年导入、也不会和用户的日程混在一起被误删。
//    用户在编辑器里能看到的"节日气泡"是展示层的东西，不进库。
//
// ⚠️ 只收**有出处、日期确定**的节日。像"双十一/618"这种商业促销日、或者需要每年
//    国务院通知才定的"调休安排"，都不在这里（那是"放假安排"，不是节日日期本身）。

import { solarToLunar, lunarToSolar, lunarDateName, LUNAR_MAX_YEAR } from './lunar.js';
// 真实的二十四节气表（机器转录；清明的日期就靠它，不用简化公式）
import { termDay } from './lunar-terms.js';

/** 节日专用的那个颜色（要**明显区别于**四档"事情多大"：天蓝/翠绿/黄/红） */
export const FESTIVAL_COLORS = Object.freeze({
  // 中国红 + 金：一眼看出来"这是节日，不是我的事"
  fill: '#e03a3a',
  fillLight: '#ff8a7a',
  fillDark: '#7a1414',
  edge: '#ffd479',
  text: '#ffffff',
  ring: '#ffd479',
});

/** 气泡上那行小字（气泡区里节日气泡的"倒计时"位置） */
export function festivalCountdownText(daysLeft) {
  const n = Number(daysLeft);
  if (!Number.isFinite(n)) return '';
  if (n < 0) return '已过';
  if (n === 0) return '就是今天';
  if (n === 1) return '明天';
  return `还剩 ${n} 天`;
}

/**
 * 节日表。
 *
 * `kind`：`lunar` 农历 / `solar` 公历 / `term` 节气（清明这类，日期按节气表）
 * `month`/`day`：农历或公历的月日；`term` 用 `termKey`
 * `major`：重要的（春节、中秋、国庆…）—— 气泡区只给 major 的浮出来，
 *          否则一年到头都在过节（用户要的是"还剩几天时提醒我"）
 */
export const FESTIVALS = Object.freeze([
  // ---------------- 中国传统节日（农历） ----------------
  { key: 'chuxi', name: '除夕', kind: 'lunar', month: 12, day: 30, eve: true, major: true,
    blessing: '除夕守岁，辞旧迎新',
    intro: '农历一年的最后一天晚上。全家团圆吃年夜饭、贴春联、守岁到新年。' },
  { key: 'chunjie', name: '春节', kind: 'lunar', month: 1, day: 1, major: true,
    blessing: '新春大吉，万事如意',
    intro: '农历正月初一，中国最重要的传统节日。拜年、贴福字、发红包，从头一天热闹到十五。' },
  { key: 'yuanxiao', name: '元宵节', kind: 'lunar', month: 1, day: 15, major: true,
    blessing: '元宵团圆，灯火可亲',
    intro: '正月十五，春节的最后一天。吃元宵/汤圆、赏花灯、猜灯谜。' },
  { key: 'longtaitou', name: '龙抬头', kind: 'lunar', month: 2, day: 2, major: false,
    blessing: '二月二，龙抬头，一年都有精神头',
    intro: '农历二月初二，民间认为这天龙王苏醒，宜理发（"剃龙头"）、吃春饼。' },
  { key: 'duanwu', name: '端午节', kind: 'lunar', month: 5, day: 5, major: true,
    blessing: '端午安康，粽香满堂',
    intro: '农历五月初五，纪念屈原。吃粽子、赛龙舟、挂艾草菖蒲、系五彩绳。' },
  { key: 'qixi', name: '七夕节', kind: 'lunar', month: 7, day: 7, major: true,
    blessing: '七夕有情人终成眷属',
    intro: '农历七月初七，牛郎织女鹊桥相会。中国传统的"情人节"，也叫乞巧节。' },
  { key: 'zhongyuan', name: '中元节', kind: 'lunar', month: 7, day: 15, major: false,
    blessing: '慎终追远，平安顺遂',
    intro: '农历七月十五，民间祭祖的日子，也叫七月半。' },
  { key: 'zhongqiu', name: '中秋节', kind: 'lunar', month: 8, day: 15, major: true,
    blessing: '中秋快乐，月圆人团圆',
    intro: '农历八月十五，秋天的中间。赏月、吃月饼、一家人团圆。' },
  { key: 'chongyang', name: '重阳节', kind: 'lunar', month: 9, day: 9, major: true,
    blessing: '重阳登高，长辈安康',
    intro: '农历九月初九，二九相重。登高、赏菊、敬老（也是老人节）。' },
  { key: 'laba', name: '腊八节', kind: 'lunar', month: 12, day: 8, major: false,
    blessing: '腊八喝粥，暖胃暖心',
    intro: '农历腊月初八，喝腊八粥、泡腊八蒜，"过了腊八就是年"。' },
  { key: 'xiaonian', name: '小年', kind: 'lunar', month: 12, day: 23, major: false,
    blessing: '小年除尘，迎新纳福',
    intro: '农历腊月二十三（南方有些地方是二十四），祭灶、扫尘、开始备年货。' },

  // ---------------- 中国传统节日（公历 / 节气） ----------------
  { key: 'qingming', name: '清明节', kind: 'term', termKey: 'qingming', major: true,
    blessing: '清明追思，平安顺遂',
    intro: '二十四节气之一（公历 4 月 4–6 日之间）。扫墓祭祖、踏青，也是法定假日。' },
  { key: 'dongzhi', name: '冬至', kind: 'term', termKey: 'dongzhi', major: false,
    blessing: '冬至进补，来年打虎',
    intro: '二十四节气之一（公历 12 月 21–23 日）。北方吃饺子、南方吃汤圆，从这天起"数九"。' },

  // ---------------- 热门节日（公历） ----------------
  { key: 'yuandan', name: '元旦', kind: 'solar', month: 1, day: 1, major: true,
    blessing: '新年快乐，一切顺意',
    intro: '公历新年的第一天。放假一天，很多地方有跨年活动。' },
  { key: 'qingren', name: '情人节', kind: 'solar', month: 2, day: 14, major: true,
    blessing: '情人节快乐，愿你喜欢的人也喜欢你',
    intro: '2 月 14 日，西方的圣瓦伦丁节，现在全世界都在过。' },
  { key: 'funv', name: '妇女节', kind: 'solar', month: 3, day: 8, major: false,
    blessing: '节日快乐，愿你被世界温柔以待',
    intro: '3 月 8 日国际劳动妇女节，很多单位女性放假半天。' },
  { key: 'zhishu', name: '植树节', kind: 'solar', month: 3, day: 12, major: false,
    blessing: '种一棵树，等一片荫',
    intro: '3 月 12 日，中国的植树节（也是孙中山逝世纪念日）。' },
  { key: 'yuren', name: '愚人节', kind: 'solar', month: 4, day: 1, major: false,
    blessing: '愚人节快乐，今天别太当真',
    intro: '4 月 1 日，开玩笑、恶作剧的日子 —— 注意别玩过火。' },
  { key: 'laodong', name: '劳动节', kind: 'solar', month: 5, day: 1, major: true,
    blessing: '劳动节快乐，好好休息',
    intro: '5 月 1 日国际劳动节，中国通常连休（具体调休看当年通知）。' },
  { key: 'qingnian', name: '青年节', kind: 'solar', month: 5, day: 4, major: false,
    blessing: '青年节快乐，永远热泪盈眶',
    intro: '5 月 4 日，纪念 1919 年五四运动。' },
  { key: 'muqin', name: '母亲节', kind: 'solar', month: 5, day: 0, week: 2, weekday: 0, major: true,
    blessing: '母亲节快乐，妈妈辛苦了',
    intro: '5 月的第二个星期日。记得给妈妈打个电话。' },
  { key: 'ertong', name: '儿童节', kind: 'solar', month: 6, day: 1, major: false,
    blessing: '儿童节快乐，愿你一直有童心',
    intro: '6 月 1 日国际儿童节。' },
  { key: 'fuqin', name: '父亲节', kind: 'solar', month: 6, day: 0, week: 3, weekday: 0, major: true,
    blessing: '父亲节快乐，老爸也要好好的',
    intro: '6 月的第三个星期日。' },
  { key: 'dang', name: '建党节', kind: 'solar', month: 7, day: 1, major: false,
    blessing: '不忘初心',
    intro: '7 月 1 日。' },
  { key: 'jianjun', name: '建军节', kind: 'solar', month: 8, day: 1, major: false,
    blessing: '致敬最可爱的人',
    intro: '8 月 1 日。' },
  { key: 'jiaoshi', name: '教师节', kind: 'solar', month: 9, day: 10, major: true,
    blessing: '教师节快乐，谢谢老师',
    intro: '9 月 10 日，中国的教师节。给老师发条消息吧。' },
  { key: 'guoqing', name: '国庆节', kind: 'solar', month: 10, day: 1, major: true,
    blessing: '国庆快乐，山河无恙',
    intro: '10 月 1 日中华人民共和国国庆，通常连休七天（"十一黄金周"）。' },
  { key: 'wansheng', name: '万圣节', kind: 'solar', month: 10, day: 31, major: false,
    blessing: '万圣节快乐，糖果管够',
    intro: '10 月 31 日万圣节前夜，现在主要是"装扮 + 要糖"。' },
  { key: 'ganen', name: '感恩节', kind: 'solar', month: 11, day: 0, week: 4, weekday: 4, major: false,
    blessing: '感恩节快乐，谢谢你',
    intro: '11 月的第四个星期四（美国节日，国内也常借来聚一聚）。' },
  { key: 'shengdan', name: '圣诞节', kind: 'solar', month: 12, day: 25, major: true,
    blessing: '圣诞快乐，平安喜乐',
    intro: '12 月 25 日。交换礼物、吃一顿好的，气氛到位就行。' },
]);

/** 二十四节气（只要表里的这几个 —— 清明/冬至是节日，其余先不算节日） */
const TERM_KEYS = {
  qingming: '清明',
  dongzhi: '冬至',
};

/**
 * 节气落在公历哪一天。
 *
 * ⚠️ 用**真实的节气表**（`core/lunar-terms.js`，1900–2100，机器从通行实现转录的），
 *    不用简化公式 —— 清明差一天在日历上是看得见的错，而这类公式在某些年份就会差。
 *    表外（>2100）返回 null：宁可这一天不显示节日，也不要给个错日期。
 */
export function termDate(year, termKey) {
  const y = Number(year);
  if (!Number.isFinite(y)) return null;
  const n = TERM_INDEX[termKey];
  if (!n) return null;
  const d = termDay(y, n);
  if (!(d > 0)) return null;
  return { y, m: Math.ceil(n / 2), d };   // 每两个月一个节气对：n=1,2 → 1 月；…；23,24 → 12 月
}

/** 节气在表里的序号（1 起，和 `termDay` 一致）：1=小寒 … 7=清明 … 24=冬至 */
const TERM_INDEX = { qingming: 7, dongzhi: 24 };

/** 某年第 n 个星期 weekday 的日期（父亲节/母亲节/感恩节这种） */
function nthWeekdayOfMonth(year, month, week, weekday) {
  const first = new Date(year, month - 1, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  const day = 1 + shift + (week - 1) * 7;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1) return null;
  return { y: year, m: month, d: day };
}

/** 某年某个节日落在公历哪一天（算不出来 → null） */
export function festivalDate(festival, year) {
  if (!festival) return null;
  const y = Number(year);
  if (!Number.isFinite(y)) return null;

  if (festival.kind === 'solar') {
    if (festival.day) return { y, m: festival.month, d: festival.day };
    return nthWeekdayOfMonth(y, festival.month, festival.week, festival.weekday);
  }
  if (festival.kind === 'term') return termDate(y, festival.termKey);
  if (festival.kind === 'lunar') {
    if (y > LUNAR_MAX_YEAR) return null;
    // 除夕 = 腊月的最后一天（有三十就是三十，没有就是廿九）—— 直接问农历表更稳
    if (festival.eve) {
      const last = lunarToSolar(y, 12, 30) || lunarToSolar(y, 12, 29);
      return last ? { y: last.y, m: last.m, d: last.d } : null;
    }
    const s = lunarToSolar(y, festival.month, festival.day);
    return s ? { y: s.y, m: s.m, d: s.d } : null;
  }
  return null;
}

/**
 * 某一年里所有节日的公历日期（按日期排序）。
 *
 * ⚠️ 农历节日可能落在下一年（腊月/除夕），所以按**公历**归年：
 *    先算 `year-1` 的腊月节日，再筛出落在 `year` 里的那些。
 */
export function festivalsInYear(year) {
  const out = [];
  for (const f of FESTIVALS) {
    for (const y of [year - 1, year, year + 1]) {
      const d = festivalDate(f, y);
      if (!d || d.y !== year) continue;
      out.push({
        ...f,
        date: `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`,
        y: d.y, m: d.m, d: d.d,
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** 某一天是哪些节日（月历格子挂标签用） */
export function festivalsOn(y, m, d) {
  const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return festivalsInYear(y).filter((f) => f.date === key);
}

/** 那一天的农历说法（"八月十五"）——月历上可以顺带显示，节日气泡的备注里也要用 */
export function lunarLabelOf(y, m, d) {
  const l = solarToLunar(y, m, d);
  if (!l) return '';
  return lunarDateName(l.month, l.day, l.isLeap);
}

/**
 * 从 `now` 往后看 `days` 天，找出"快要到了"的节日（气泡区用）。
 *
 * 用户的原话是"节日还剩 N 天时（默认 4 天，可调）出现节日气泡" ——
 * 所以这里返回的是**窗口内**的节日，含"就是今天"（daysLeft = 0）。
 *
 * @param {Date} now
 * @param {{days?:number, majorOnly?:boolean}} [opts]
 */
export function upcomingFestivals(now = new Date(), { days = 4, majorOnly = true } = {}) {
  const n = Number(days);
  const horizon = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const list = festivalsInYear(today.getFullYear());
  // 跨年：12 月底往后看要能看见明年元旦
  list.push(...festivalsInYear(today.getFullYear() + 1));

  const out = [];
  const seen = new Set();
  for (const f of list) {
    if (majorOnly && !f.major) continue;
    const dt = new Date(f.y, f.m - 1, f.d);
    const daysLeft = Math.round((dt.getTime() - today.getTime()) / 86_400_000);
    if (daysLeft < 0 || daysLeft > horizon) continue;
    if (seen.has(f.key + f.date)) continue;
    seen.add(f.key + f.date);
    out.push({ ...f, daysLeft, countdown: festivalCountdownText(daysLeft) });
  }
  out.sort((a, b) => a.daysLeft - b.daysLeft);
  return out;
}

/**
 * 把"快要到了的节日"变成**气泡区能画的虚拟事件**（不进库、不可编辑）。
 *
 * ⚠️ 形状要和真事件兼容（气泡区同一套渲染）：`type: 'festival'` 是给渲染层认的标记，
 *    颜色走 `FESTIVAL_COLORS`，`notes` 里就是**祝福语 + 节日介绍**（用户要求的）。
 */
export function festivalEvents(now = new Date(), { days = 4, majorOnly = true } = {}) {
  return upcomingFestivals(now, { days, majorOnly }).map((f) => ({
    // ⚠️ id 前缀 `festival:` —— 谁看一眼都知道这不是库里的事件，别拿去 patch/删
    id: `festival:${f.key}:${f.date}`,
    title: f.name,
    type: 'festival',
    level: 'red',
    festival: true,
    festivalKey: f.key,
    daysLeft: f.daysLeft,
    countdown: f.countdown,          // 「还剩 4 天」—— 气泡上那行小字就是它
    start: `${f.date}T00:00:00`,
    end: `${f.date}T23:59:00`,
    allDay: true,
    notes: `${f.blessing}\n\n${f.intro}`,
    blessing: f.blessing,
    intro: f.intro,
    lunarLabel: lunarLabelOf(f.y, f.m, f.d),
    done: false,
    readonly: true,
  }));
}
