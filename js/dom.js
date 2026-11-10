/* Tiny DOM helper shared by the graph renderer and the app. */
(function (root) {
  'use strict';

  function append(el, children) {
    for (const child of children) {
      if (child == null || child === false) continue;
      if (Array.isArray(child)) append(el, child);
      else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  /** h('div', { class: 'x', title: 'y' }, child, [more, children], 'text') */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? '' : value);
      }
    }
    append(el, children);
    return el;
  }

  root.RJVDom = { h };
})(self);
