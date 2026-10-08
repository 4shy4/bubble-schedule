// 帧回调的**最后一道护栏**：任何异常都不许让 `requestAnimationFrame` 的续排停掉。
//
// ===========================================================================
// 为什么要有这个文件（用户报的 iPad bug 的一半根因就在这里）
// ===========================================================================
//
// 这个项目的帧循环原来长这样：
//
//     function frame(now) {
//       stepHold(dt);            // ← 无保护
//       if (!paused) step(dt);   // ← 无保护（物理/碰撞）
//       try { restyleAll(); } catch { … }   // 只有这里有保护
//       draw();                  // ← 内部只保护了"每颗泡泡"，函数自己的前后没有
//       if (debugHost) updateDebug();       // ← 无保护
//       raf = requestAnimationFrame(frame); // ← **这一句就是命门**
//     }
//
// 只要上面任何一处抛出，最后那句就**永远不会执行** —— 整个循环死掉。
// 症状会分成两半，而且看起来像两个不相干的 bug：
//   · **泡泡不再重画** → 用户报的"泡泡隐身了但还能点到"（命中走几何模型，不靠绘制）
//   · **长按永远不触发** → 用户报的"长按 2.5 秒无响应"
//     因为老实现的长按计时/进度/判定**全都在这个循环里**（`stepHold`）
//   · 而单击/双击仍然正常 → 它们在 pointerup 分支里处理，压根不经过循环
//     （这也正是"为什么只有长按坏了"的答案）
//
// 用户还补了一条关键线索："之前长按有效，应该也和节日改动有关"——
// 节日图案（`drawFestivalArt`）是后来加进绘制路径的，它给"帧内抛出"多开了几个入口
// （形状清单可能脏、用户自己换的图、以及 catch 里那句不配对的 `restore()`）。
//
// 所以修法是两层，缺一不可：
//   ① **长按与帧循环解耦** —— 见 `web/ui/bubble-gesture.js`（真正把 bug 修掉的那一层）
//   ② **帧循环无条件续排** —— 就是这个文件（保证"循环死掉"这类症状不再复现）
//
// 注意 ② 是**兜底**、不是 ① 的替代：循环活着是为了画面，不能把业务正确性压在它身上。

/**
 * 判断"报过的错"要不要再报一次。
 *
 * 每帧都弹 toast 会把气泡区刷满、还会盖住真正的问题（第一版就这么干过）。
 * 所以默认**同一条错误只报一次**，但换了错误内容就再报（换错误 = 换了新根因）。
 */
export function createOnceReporter(onReport) {
  const seen = new Set();
  return function reportOnce(err) {
    const key = `${(err && err.name) || 'Error'}|${(err && err.message) || String(err)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    try { onReport(err); } catch { /* 上报自己炸了不能再抛，否则每帧递归 */ }
    return true;
  };
}

/**
 * 帧回调的护栏：把整帧包起来，**无论如何都会调用 `reschedule`**。
 *
 * 为什么用 `finally` 而不是"在 try 末尾顺手写一句"：
 *   末尾那句只覆盖"没抛"的情况；`return` / 未来的 `continue` 类改动都会绕过它。
 *   `finally` 是唯一"不管怎么出去都会执行"的位置 —— 这正是本文件存在的理由。
 *
 * @param {() => void} body 这一帧真正要做的事
 * @param {object} o
 * @param {() => void} o.reschedule   续排下一帧（`() => { raf = requestAnimationFrame(frame) }`）
 * @param {(err:any) => void} [o.onError] 出错了怎么办（默认只报一次 console.error）
 * @param {() => boolean} [o.isStopped] 视图已经停掉时**不要**再续排（否则定时器/帧泄漏）
 * @returns {boolean} 这一帧是否正常跑完（测试用它数"循环还活着吗"）
 */
export function runGuardedFrame(body, { reschedule, onError, isStopped } = {}) {
  let ok = true;
  try {
    body();
  } catch (err) {
    ok = false;
    if (typeof onError === 'function') {
      try { onError(err); } catch { /* 同上：兜底不许再抛 */ }
    }
  } finally {
    // ⚠️ 即使 body 抛了、即使 onError 也抛了，这一句都会执行 —— 循环永远不会因为异常而停。
    const stopped = typeof isStopped === 'function' ? isStopped() : false;
    if (!stopped && typeof reschedule === 'function') reschedule();
  }
  return ok;
}
