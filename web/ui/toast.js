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

/** 提醒专用：停留更久，点了能跳到日程 */
export function alertToast({ title, body, eventId, minutes, mirror, fromServer }) {
  const tags = [];
  if (fromServer) tags.push('服务端提醒');
  else if (mirror) tags.push('同时已发送系统通知');
  else if (minutes > 0) tags.push(`提前 ${minutes} 分钟`);

  return toast({
    title,
    body: [body, tags.join(' · ')].filter(Boolean).join('  —  '),
    kind: 'alert',
    timeout: 12000,
    onClick: eventId ? () => {
      window.dispatchEvent(new CustomEvent('timetable:open-event', { detail: { id: eventId } }));
    } : null,
  });
}
