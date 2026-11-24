// Just enough DOM for panels built with createElement, so their wiring can be
// tested without a browser. Not a layout or HTML engine.
class MiniEvent {
  constructor(type, init = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; }
}

class MiniTarget {
  #listeners = new Map();
  addEventListener(type, handler, { signal } = {}) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(handler);
    signal?.addEventListener('abort', () => this.#listeners.get(type).delete(handler));
  }
  removeEventListener(type, handler) { this.#listeners.get(type)?.delete(handler); }
  // Bubbles like a real event and resolves when async handlers have finished.
  async fire(type, init = {}) {
    const event = new MiniEvent(type, { target: this, ...init });
    for (let node = this; node; node = node.parent) await Promise.all([...(node.#listeners.get(type) || [])].map(handler => handler(event)));
    return event;
  }
}

class MiniElement extends MiniTarget {
  #value = '';
  #text = '';
  constructor(document, tag) {
    super();
    Object.assign(this, { ownerDocument: document, tagName: tag.toUpperCase(), children: [], parent: null, attributes: new Map(),
      hidden: false, disabled: false, checked: false, className: '', dataset: {}, style: {}, title: '', innerHTML: '', files: [] });
    const classes = () => new Set(this.className.split(' ').filter(Boolean));
    this.classList = {
      contains: name => classes().has(name),
      toggle: (name, on = !classes().has(name)) => { const set = classes(); set[on ? 'add' : 'delete'](name); this.className = [...set].join(' '); },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (['hidden', 'disabled', 'checked'].includes(name)) this[name] = true;
    else if (name === 'value') this.value = String(value);
    else if (name === 'class') this.className = String(value);
    else if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? Object.assign(this.ownerDocument.createElement('span'), { textContent: node }) : node;
      child.parent = this;
      this.children.push(child);
    }
    if (this.tagName === 'SELECT' && !this.children.some(option => option.value === this.#value)) this.#value = this.children[0]?.value ?? '';
  }
  replaceChildren(...nodes) { this.children = []; if (this.tagName === 'SELECT') this.#value = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  get value() { return this.#value; }
  // A select only holds a value it has an option for.
  set value(next) { this.#value = this.tagName === 'SELECT' && !this.children.some(option => option.value === String(next)) ? '' : String(next); }
  get textContent() { return this.#text + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.children = []; this.#text = String(text); }
  *descendants() { for (const child of this.children) { yield child; yield* child.descendants(); } }
  // Selectors: one tag, class, or [attribute="value"], alone or combined, with descendants.
  matches(selector) {
    const tests = [...selector.matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)"|=([^"\]]*))?\]|^([a-z0-9]+)/gi)];
    if (tests.map(part => part[0]).join('') !== selector) throw new Error('mini-dom does not support ' + selector);
    return tests.every(([, name, attribute, quoted, bare, tag]) => {
      if (tag) return this.tagName === tag.toUpperCase();
      if (name) return this.className.split(' ').includes(name);
      const wanted = quoted ?? bare;
      return this.attributes.has(attribute) && (wanted === undefined || this.getAttribute(attribute) === wanted);
    });
  }
  querySelectorAll(selector) {
    const parts = selector.match(/(?:\[[^\]]*\]|[^\s[])+/g);
    return [...this.descendants()].filter(node => {
      if (!node.matches(parts.at(-1))) return false;
      let index = parts.length - 2;
      for (let up = node.parent; up && index >= 0; up = up.parent) if (up.matches(parts[index])) index -= 1;
      return index < 0;
    });
  }
  contains(node) { for (let up = node; up; up = up.parent) if (up === this) return true; return false; }
  closest(selector) {
    for (let up = this; up; up = up.parent) if (selector.split(',').some(part => up.matches(part))) return up;
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  click() { return this.disabled ? Promise.resolve() : this.fire('click'); }
}

export function memoryStorage() {
  const items = new Map();
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)); }, removeItem: key => { items.delete(key); } };
}

export function createMiniDocument({ localStorage = memoryStorage(), sessionStorage = memoryStorage() } = {}) {
  const window = new MiniTarget();
  const document = new MiniTarget();
  Object.assign(document, { createElement: tag => new MiniElement(document, tag), defaultView: window, activeElement: null });
  Object.assign(window, { document, localStorage, sessionStorage, setTimeout, clearTimeout });
  document.body = document.createElement('body');
  return { document, window };
}
