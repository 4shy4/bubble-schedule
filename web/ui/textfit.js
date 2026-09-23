// 文本折行 / 缩放适配：把标题塞进气泡这个圆形小地方。
//
// 为什么单独一个模块：这段逻辑**出过错且错得不明显**——
// 真机上 "CHILD-AMBER" 被折成 "CHILD-AM" / "BER"，看着像乱码。抽出来才能单测
// （bubble.js 依赖 canvas，Node 里没法直接测）。前后错了两次，都记在下面。
//
// 规则：
//   · 只在**允许断行的位置**断：CJK 每字可断、空白/连字符/斜杠/标点之后可断
//   · 拉丁词不从中间断；放不下就整段挪到下一行
//   · 整段自己就超宽（一个超长词）→ 只能段内硬断
//   · 超过 maxLines 时末行加省略号
//
// 踩过的两个坑：
//   ① 第一版逐字断行 → "CHILD-AM" / "BER"
//   ② 第二版"贪心填满再回退到词首" → 仍然会劈词：CHILD- 明明能独占一行，
//      但贪心把 AM 也塞了进去，回退点就落在词中间了。
//      正确做法是"只在允许的断点处断"，而不是"先填满再往后退"。

/**
 * "词内字符"：这些字符连在一起时不能从中间断开。
 *
 * ⚠️ 连字符 `-` **不能**算词内字符 —— 它是**断点**。
 * 第一版把 `-` 同时放进 WORD_CHAR 和 BREAK_AFTER，结果吃词的 while 循环
 * 把整个 "CHILD-AMBER" 吞成一段，BREAK_AFTER 永远轮不到，
 * 于是只能段内硬断成 "CHILD-AM" / "BER"（就是真机上看到的乱码）。
 * 去掉 `-` 之后切分是 ["CHILD-", "AMBER"]，正好在连字符处断开。
 */
const WORD_CHAR = /[A-Za-z0-9_']/;

/**
 * 允许断行的位置：这些字符**之后**可以换行。
 * 空白、连字符、斜杠、点、常见中英标点。
 */
const BREAK_AFTER = /[\s\-_/.,:;!?·—–、，。：；！？]/;

/**
 * 切成"原子段"：段内不允许断开，段与段之间可以。
 *   "CHILD-AMBER"  → ["CHILD-", "AMBER"]
 *   "交实验报告"    → ["交","实","验","报","告"]（CJK 每字一段）
 *   "写 Linux 驱动" → ["写"," ","Linux"," ","驱","动"]
 */
function toSegments(text) {
  const chars = [...String(text || '')];
  const segs = [];
  let cur = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    cur += ch;
    const isCjk = ch.charCodeAt(0) > 0x2e80;
    if (isCjk || BREAK_AFTER.test(ch)) {
      segs.push(cur);
      cur = '';
      continue;
    }
    if (!WORD_CHAR.test(ch)) continue;
    // 拉丁词：把整个词吞进一段，直到遇到非词字符
    let j = i + 1;
    while (j < chars.length && WORD_CHAR.test(chars[j])) { cur += chars[j]; j += 1; }
    i = j - 1;
    segs.push(cur);
    cur = '';
  }
  if (cur) segs.push(cur);
  return segs;
}

/**
 * 把文本折行（在"允许断行的位置"断）。
 *
 * ⚠️ 不能用"贪心填满再回退"的写法：那样遇到 CHILD-AMBER 这种
 * "连字符后可以断、但贪心会把半截词塞进上一行"的情况，会折成 CHILD-AM / BER。
 * 正确做法是**只在允许的断点处断**，并且尽量填满（放不下就整段挪到下一行）。
 */
export function wrapText(ctx2d, text, maxWidth, fontSize, maxLines) {
  setFitFont(ctx2d, fontSize);
  const chars = [...String(text || '')];
  const segments = toSegments(text);
  const lines = [];
  let line = '';
  let truncated = false;

  const fits = (s) => ctx2d.measureText(s).width <= maxWidth;
  const flush = () => { lines.push(line); line = ''; };
  const full = () => lines.length >= maxLines;

  /** 把独占一段都放不下的超长词切开放进若干行（唯一没办法的情况） */
  const hardBreak = (seg) => {
    let piece = '';
    for (const ch of seg) {
      if (piece && !fits(piece + ch)) {
        lines.push(piece);
        piece = ch;
        if (full()) break;
      } else {
        piece += ch;
      }
    }
    line = piece;
  };

  for (const seg of segments) {
    if (full()) break;
    if (fits(line + seg)) { line += seg; continue; }
    if (line) flush();
    if (full()) break;
    if (fits(seg)) line = seg;
    else hardBreak(seg);
  }
  if (!full() && line) lines.push(line);

  if (lines.length >= maxLines && lines.join('').length < chars.length) {
    lines[maxLines - 1] = ellipsize(ctx2d, `${lines[maxLines - 1]}…`, maxWidth);
    truncated = true;
  }
  lines.truncated = truncated;
  return lines;
}

/** 截到能放下为止再加省略号 */
export function ellipsize(ctx2d, text, maxWidth) {
  let s = String(text);
  if (ctx2d.measureText(s).width <= maxWidth) return s;
  while (s.length > 1 && ctx2d.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

/** 字体粗细（折行和绘制必须用同一个字体，否则宽度算不准） */
const FONT_WEIGHT = 650;

/** 给 canvas 设好字体 */
export function setFitFont(ctx2d, fontSize) {
  ctx2d.font = `${FONT_WEIGHT} ${fontSize}px system-ui, sans-serif`;
}

/** 折行结果里有没有"一个词被劈成两半" */
export function hasWordSplit(lines) {
  for (let i = 0; i < lines.length - 1; i += 1) {
    const a = lines[i];
    const b = lines[i + 1];
    if (!a || !b) continue;
    // 在分隔符之后断行是正常的（"CHILD-" / "AMBER" 就属于这种），不算劈开
    if (BREAK_AFTER.test(a[a.length - 1])) continue;
    // 前一行以词内字符结尾、后一行也以词内字符开头 → 中间没有分隔 → 必然劈了词
    if (WORD_CHAR.test(a[a.length - 1]) && WORD_CHAR.test(b[0])) return true;
  }
  return false;
}

/**
 * 折行，并在"宁可小一点也别把词劈开"时自动缩字号。
 *
 * 为什么要这一步：气泡里遇到长英文/编号（"CHILD-AMBER"、"CS101-Project"）时，
 * 按词断行会让半截词占一整行，看着像乱码；硬断又难看。
 * 用户的真数据是中文（逐字断行本来就没问题），但截图里的英文标题暴露了这个缺口。
 *
 * 策略：先按原字号折；如果出现"词被劈开"，就把字号缩小一档重试，
 * 最多缩到 minFontSize（再不行就接受硬断，总比超出气泡好）。
 *
 * @returns {{lines:string[], fontSize:number}}
 */
export function wrapTextToFit(ctx2d, text, maxWidth, fontSize, maxLines, minFontSize = 8) {
  let size = fontSize;
  let lines = wrapText(ctx2d, text, maxWidth, size, maxLines);
  // 两个"需要缩"的信号：
  //   · 被省略号截断了 → 肯定没放下
  //   · 出现"词被劈开" → 缩一点也许就能整词放进某一行
  const bad = (ls) => ls.truncated || hasWordSplit(ls);
  if (!bad(lines)) return { lines, fontSize: size };

  // 每次缩 12%，返回**第一个成功的**（不是最后一次尝试，否则会白缩到下限）
  while (size > minFontSize) {
    const next = Math.max(minFontSize, size * 0.88);
    if (next >= size) break;
    size = next;
    const attempt = wrapText(ctx2d, text, maxWidth, size, maxLines);
    if (!bad(attempt)) return { lines: attempt, fontSize: size };
    lines = attempt;
  }
  // 缩到下限还是不行 → 接受最后的结果（总比超出气泡好）
  return { lines, fontSize: size };
}
