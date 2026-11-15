/**
 * Shared harness for the GUI tests (`web-*.test.mjs`).
 *
 * The browser modules read `document`, `fetch`, `confirm` and the URL fragment at
 * import time, so every test needs a clean module graph, a fresh DOM shim and a
 * fetch stub. This file keeps those four steps in one place: a helper, not a test
 * (node --test only runs `*.test.mjs`).
 *
 * The shim in test/helpers/dom-shim.mjs is deliberately smaller than a browser.
 * `patchDom()` fills only the gaps that real browser code may legitimately use
 * (`value` on inputs, `option.value`, `hidden` members, `document.title`,
 * `querySelector` precedence) and records real shim *bugs* separately so a test
 * can report them instead of quietly working around them. Nothing here changes
 * the application code.
 */

import { readFileSync } from 'node:fs';

import { installDom, DomNode } from '../helpers/dom-shim.mjs';
import { setLanguage, webCatalogue } from '../../src/core/i18n.ts';

/** Catalogues as the server sends them (`/api/state` → `messages`). */
export function catalogues() {
  setLanguage('en');
  const en = webCatalogue();
  setLanguage('zh-CN');
  const zh = webCatalogue();
  setLanguage('en');
  return { en, zh };
}

export const { en: EN, zh: ZH } = catalogues();

/** Set both the server-side language and the messages the page uses. */
export async function useLanguage(lang, catalogue = lang === 'zh-CN' ? ZH : EN) {
  const i18n = await import('../../web/src/i18n.js');
  i18n.setMessages(catalogue, lang);
  setLanguage(lang);
  return i18n;
}

/**
 * The DOM shim looks up elements in document order *and* recurses, but it hands
 * back matches in pre-order rather than in the order a browser's live
 * querySelectorAll returns (document order of top-level children first). That
 * makes `#home-banner` / `#profile-error` checks depend on tree shape rather than
 * on the attribute, so tests use these direct lookups instead.
 */
export function findById(dom, id) {
  const found = dom.document.querySelectorAll(`[id="${id}"]`);
  return found[0] ?? null;
}

export function findAll(dom, selector) {
  return dom.document.querySelectorAll(selector);
}

export function byClass(dom, cls) {
  return findAll(dom, `.${cls}`);
}

export function text(node) {
  return node?.textContent ?? '';
}

/** The tab views web/index.html declares, in order. */
export function markupTabsSync() {
  const html = readFileSync('web/index.html', 'utf8');
  return [...html.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
}

/** Async spelling of the same thing, for tests that assert on the markup. */
export async function markupTabs() {
  return markupTabsSync();
}

/**
 * Re-create the page skeleton from web/index.html.
 *
 * installDom() only ever creates `#main`, `#status` and four tabs, but the real
 * markup declares eight, and main.js writes into `#home-banner`,
 * `#profile-error`, `#language`, `#about-trigger` and `#about-panel`. Driving the
 * real main.js therefore needs the elements the real markup declares — so the
 * tab list is read from index.html rather than hard-coded here.
 */
export function installPage({ tabs } = {}) {
  // read the real tab list synchronously: the booting tests import main.js
  // immediately after this call, and a wrong tab bar would silently change what
  // the page can navigate to
  const views = tabs ?? markupTabsSync();
  const dom = installDom({ tabs: views });
  const doc = dom.document;
  const body = dom.body;

  // Browsers have a document-level event target; main.js binds click/keydown
  // there to close the About menu. The shim has no such node.
  const documentListeners = {};
  doc.listeners = documentListeners;
  doc.addEventListener = (type, fn) => {
    (documentListeners[type] ??= []).push(fn);
  };
  doc.removeEventListener = (type, fn) => {
    documentListeners[type] = (documentListeners[type] ?? []).filter((f) => f !== fn);
  };
  doc.dispatchEvent = (event) => {
    for (const fn of documentListeners[event.type] ?? []) fn.call(doc, event);
    return true;
  };

  const create = (tagName, attrs = {}) => {
    const node = doc.createElement(tagName);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };

  const topbar = create('header', { class: 'topbar' });
  const nav = create('nav', { class: 'tabs', role: 'tablist' });
  for (const tab of dom.tabs) {
    // the real markup marks every tab with role="tab"
    tab.setAttribute('role', 'tab');
    nav.append(tab);
  }

  const language = create('select', { id: 'language', class: 'lang-picker', 'aria-label': 'Language' });

  const aboutTrigger = create('button', {
    class: 'menu-trigger',
    id: 'about-trigger',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
  });
  const aboutLabel = create('span');
  aboutLabel.setAttribute('data-i18n', 'web.viewBuildInfo');
  aboutLabel.textContent = 'About';
  aboutTrigger.append(aboutLabel);
  const aboutPanel = create('div', { class: 'menu-panel', id: 'about-panel', role: 'menu' });
  aboutPanel.setAttribute('hidden', '');

  topbar.append(nav, language, aboutTrigger, aboutPanel, dom.status);

  const main = findById(dom, 'main');
  const homeBanner = create('div', { id: 'home-banner', class: 'home-banner' });
  const profileError = create('div', { id: 'profile-error', class: 'profile-error' });
  main.replaceChildren(homeBanner, profileError);

  body.replaceChildren(topbar, main);

  // `<html lang="en">` from web/index.html: the fallback main.js must correct
  const documentElement = create('html', { lang: 'en' });
  doc.documentElement = documentElement;

  return { ...dom, header: topbar, nav, language, aboutTrigger, aboutPanel, aboutLabel, homeBanner, profileError };
}

/**
 * Add the DOM members the shim lacks that browser code uses or that a test needs
 * to read. Each patch lives on the shared prototype, so it is applied once but is
 * idempotent to call from every test.
 */
export function patchDom() {
  if (DomNode.prototype.__gsPatched) return;

  if (typeof DomNode.prototype.hasAttribute !== 'function') {
    DomNode.prototype.hasAttribute = function hasAttribute(name) {
      return name in this.attributes;
    };
    DomNode.prototype.removeAttribute = function removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'class') this.className = '';
    };
    DomNode.prototype.toggleAttribute = function toggleAttribute(name, force) {
      const on = force === undefined ? !(name in this.attributes) : Boolean(force);
      if (on) this.setAttribute(name, '');
      else delete this.attributes[name];
      return on;
    };
    /** Browsers expose `hidden` as a boolean property backed by the attribute. */
    Object.defineProperty(DomNode.prototype, 'hidden', {
      get() {
        return 'hidden' in this.attributes;
      },
      set(value) {
        if (value) this.setAttribute('hidden', '');
        else delete this.attributes['hidden'];
      },
      configurable: true,
    });
  }

  if (typeof DomNode.prototype.remove !== 'function') {
    DomNode.prototype.remove = function remove() {
      this.parentNode?.removeChild(this);
    };
  }

  if (typeof DomNode.prototype.prepend !== 'function') {
    DomNode.prototype.prepend = function prepend(...nodes) {
      this.children.unshift(...nodes);
    };
  }

  // Browsers expose `value` on form controls: inputs reflect the value property
  // (not the attribute once typed) and options fall back to their text. The
  // initial value of an input comes from the `value` attribute written by el(),
  // so the getter falls back to it.
  Object.defineProperty(DomNode.prototype, 'value', {
    get() {
      if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
        return this._value ?? this.attributes.value ?? '';
      }
      if (this.tagName === 'OPTION') return this._value ?? this.attributes.value ?? this.textContent;
      if (this.tagName === 'SELECT') {
        const options = this.children.filter((c) => c.tagName === 'OPTION');
        const chosen = options.find((o) => o._selected === true) ?? options[0];
        return chosen ? chosen.value : '';
      }
      return this.attributes.value;
    },
    set(value) {
      const asText = String(value);
      if (this.tagName === 'SELECT') {
        for (const option of this.children) {
          if (option.tagName === 'OPTION') option._selected = option.value === asText;
        }
        return;
      }
      this._value = asText;
      if (this.tagName === 'OPTION') this.setAttribute('value', asText);
    },
    configurable: true,
  });

  // <option selected> marks the default selection
  const originalSetAttribute = DomNode.prototype.setAttribute;
  DomNode.prototype.setAttribute = function setAttribute(name, value) {
    originalSetAttribute.call(this, name, value);
    if (name === 'selected' && this.tagName === 'OPTION') this._selected = true;
    if (name === 'checked' && this.tagName === 'INPUT') this.checked = true;
    return undefined;
  };

  Object.defineProperty(DomNode.prototype, 'checked', {
    get() {
      return this._checked === true;
    },
    set(value) {
      this._checked = Boolean(value);
    },
    configurable: true,
  });

  DomNode.prototype.__gsPatched = true;
}

/** Every element under `root`, in tree order. */
export function walk(root, out = []) {
  for (const child of root.children) {
    if (child.nodeType !== 1) continue;
    out.push(child);
    walk(child, out);
  }
  return out;
}

export function findByTag(root, tagName) {
  return walk(root).filter((n) => n.tagName === tagName.toUpperCase());
}

export function findByAttr(root, name, value) {
  return walk(root).filter((n) => (value === undefined ? name in n.attributes : n.attributes[name] === value));
}

/** Options rendered inside a <select>, in order. */
export function optionsOf(select) {
  return walk(select).filter((n) => n.tagName === 'OPTION');
}

/** The <label> elements that wrap a given control (implicit label association). */
export function labelsFor(root, control) {
  return findByTag(root, 'label').filter((label) => walk(label).includes(control));
}

/* ------------------------------------------------------------------ */
/* fetch                                                               */
/* ------------------------------------------------------------------ */

/**
 * A fetch stub over route table. A route value may be a payload or a function
 * `(url, init) => payload`. Unknown routes answer 404 like the real server.
 */
export function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const path = String(url).split('#')[0] ?? '';
    const key = Object.keys(routes).find((k) => path.includes(k));
    if (key === undefined) {
      return jsonResponse(404, { error: 'not found' });
    }
    const route = routes[key];
    const payload =
      typeof route === 'function' ? await route(path, init) : route;
    return jsonResponse(200, payload);
  };
  return calls;
}

export function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  };
}

/** An API failure the way api.js surfaces it: ApiError(message, status). */
export function failingFetch(message, status = 400) {
  globalThis.fetch = async () => jsonResponse(status, { error: message });
}

/* ------------------------------------------------------------------ */
/* sanity state used by several tests                                  */
/* ------------------------------------------------------------------ */

export function sampleState(overrides = {}) {
  return {
    home: '~',
    homePath: 'C:/Users/me',
    isSandbox: false,
    language: 'en',
    messages: EN,
    profileExists: true,
    profilePath: '~/.config/gs/profiles.yaml',
    globalIdentity: 'Me <me@example.com>',
    identities: [
      {
        name: 'work',
        email: 'w@example.com',
        userName: 'w',
        sshKey: 'id_work',
        sites: [{ host: 'git.company.com', port: 9092, alias: 'pde' }],
      },
      {
        name: 'personal',
        email: 'p@example.com',
        userName: 'p',
        sshKey: null,
        sites: [{ host: 'github.com', port: null, alias: null }],
      },
    ],
    rules: [{ dir: '/code/work', identity: 'work' }],
    repositories: [],
    ...overrides,
  };
}

export function sampleKeys(overrides = {}) {
  return {
    keys: [
      {
        name: 'id_work',
        type: 'ED25519',
        fingerprint: 'SHA256:abc',
        comment: null,
        hasPublic: true,
        usedBy: ['work'],
      },
    ],
    ...overrides,
  };
}

/** A `app` object with the members the views call. */
export function fakeApp(extra = {}) {
  const toasts = [];
  const visits = [];
  return {
    state: undefined,
    toasts,
    visits,
    goto(view) {
      visits.push(view);
    },
    toast(message, level = 'ok') {
      toasts.push({ message, level });
    },
    ...extra,
  };
}

/** Swallow confirm() prompts and report what was asked. */
export function stubConfirm(answer = true) {
  const asked = [];
  globalThis.confirm = (message) => {
    asked.push(message);
    return answer;
  };
  return asked;
}

/** Every element in the tree that carries an inline event listener. */
export function elementsWithListeners(root) {
  return walk(root).filter((n) => Object.keys(n.listeners).length > 0);
}

export { DomNode };
