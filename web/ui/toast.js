// 站内提示（Toast）：替代 alert()，3 秒自动消散，不打断操作。
import { $, el } from './dom.js';

const host = () => $('#toast-host');

export function toast({ title, body = '', kind = 'ok', timeout = 3200, onClick } = {}) {
  const node = el(`div.toast.${kind}`, {
    role: 'status',
    onclick: onClick ? () => { onClick(); dismiss(); } : null,
  }, [
    el('div', { style: { flex: '1', minWidth: '0' } }, [
      el('b', { text: title }),
      body ? el('small', { text: body }) : null,
    ]),
    el('button.t-close', {
      'aria-label': '关闭',
      text: '✕',
      onclick: (e) => { e.stopPropagation(); dismiss(); },
    }),
  ]);

  let timer = null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    node.style.transition = 'opacity .15s, transform .15s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 160);
  }
  host().appendChild(node);
  if (timeout) timer = setTimeout(dismiss, timeout);
  return dismiss;
}

/**
 * 提醒专用：停留更久，点了能跳到日程**或**去写祝福。
 *
 * ⚠️ 两种点击目标是**互斥**的（2026-10-01 加祝福提醒时明确过）：
 *   · `eventId`      → 事件提醒，点了打开那条日程；
 *   · `greetingKeys` → 祝福提醒，点了去通讯录页写祝福。
 *   一个提醒不可能又是日程又是祝福，所以用 if/else 而不是"两个都挂"。
 *
 * ⚠️ `greetingKeys` 是**数组**：一条祝福提醒 = 一个节日，可能对应**多张**草稿卡
 *    （用户原话"一次就够了吧，弹多了烦" → 合并成一条，见 `core/greetings.js`）。
 */
export function alertToast({ title, body, eventId, greetingKeys, minutes, mirror, fromServer }) {
  const tags = [];
  if (fromServer) tags.push('服务端提醒');
  else if (mirror) tags.push('同时已发送系统通知');
  else if (minutes > 0) tags.push(`提前 ${minutes} 分钟`);

  const gKeys = Array.isArray(greetingKeys) ? greetingKeys.filter(Boolean) : [];
  let onClick = null;
  if (gKeys.length) {
    // ⚠️ 用事件而不是直接调通讯录页：toast.js 是纯展示层，
    //    不该认识"怎么切页、怎么开草稿"（那是 app.js 的事）。
    onClick = () => {
      window.dispatchEvent(new CustomEvent('timetable:open-greeting', {
        detail: { keys: gKeys },
      }));
    };
  } else if (eventId) {
    onClick = () => {
      window.dispatchEvent(new CustomEvent('timetable:open-event', { detail: { id: eventId } }));
    };
  }

  return toast({
    title,
    body: [body, tags.join(' · ')].filter(Boolean).join('  —  '),
    kind: 'alert',
    timeout: 12000,
    onClick,
  });
}
