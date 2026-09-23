// 极简 DOM 工具，替代框架的模板层。
// 只用 createElement/textContent，天然免疫 XSS（用户输入不会被当 HTML 解析）。

/** el('div.card', {onclick}, [子元素]) */
export function el(spec, props = {}, children = []) {
  const [tagPart, ...classes] = String(spec).split('.');
  const node = document.createElement(tagPart || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = `${node.className} ${value}`.trim();
    else if (key === 'style' && typeof value === 'object') applyStyle(node, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value; // 仅用于我们自己写的常量字符串
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }

  append(node, children);
  return node;
}

/**
 * 把 style 对象应用到元素上。
 *
 * ⚠️ 不能用 `Object.assign(node.style, obj)` —— 那对 **CSS 自定义属性无效**：
 * `CSSStyleDeclaration` 不认 `--xxx` 这种键，赋值会被静默丢掉。
 * 后果很隐蔽：`el('div.x', { style: { '--c': 'red' } })` 看起来正常，
 * 但 `var(--c)` 解析为空 → 元素**没有背景色**，而控制台一声不响。
 * （课程表色块就是这么变成透明的；同一个坑在气泡/课表色条上也踩过。）
 */
function applyStyle(node, obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('--')) node.style.setProperty(k, String(v));
    else node.style[k] = v;
  }
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(host, ...nodes) {
  clear(host);
  append(host, nodes);
  return host;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function icon(name) {
  const map = {
    month: '▦', week: '▤', three: '▥', list: '☰', course: '🎓',
    prev: '‹', next: '›', today: '◉', settings: '⚙', help: '?',
    plus: '＋', close: '✕', trash: '🗑', bell: '🔔', check: '✓',
  };
  return map[name] || '•';
}
