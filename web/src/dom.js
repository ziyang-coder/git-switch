/** Tiny DOM helpers: no framework, no build step. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function tag(level, text) {
  return el('span', { class: `tag ${level}`, text });
}

/** Render a unified diff with per-line colouring, without innerHTML. */
export function diffBlock(diffText) {
  const pre = el('pre', { class: 'diff' });
  for (const line of diffText.split('\n')) {
    const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    pre.append(el('span', { class: cls, text: line + '\n' }));
  }
  return pre;
}

export function notice(level, text) {
  return el('div', { class: `notice ${level}`, text });
}

/**
 * Coerce an API field into an array.
 *
 * Views render whatever `/api/state` returns. A degraded response (an older
 * server, a partial profile) can omit a list entirely, and `.length`/`.map()` on
 * undefined threw a TypeError that blanked the whole screen. Callers get an empty
 * array and render their empty state instead.
 */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Coerce a field into an object, so property access never throws. */
export function asObject(value) {
  return value !== null && typeof value === 'object' ? value : {};
}
