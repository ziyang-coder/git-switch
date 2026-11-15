import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  EN,
  installPage,
  patchDom,
  stubFetch,
  sampleState,
  sampleKeys,
  fakeApp,
  useLanguage,
  findById,
  walk,
  findByTag,
  labelsFor,
  text,
} from './web-harness.mjs';

/**
 * Rendering robustness of the browser UI, driven through the real view modules.
 *
 * Three questions, all of them about untrusted input reaching the page:
 *
 *   XSS     — a directory name, identity name or note comes from profiles.yaml,
 *             which the user (or a cloned repo's instructions) control. It must
 *             arrive as text, never as markup.
 *   Garbage — a partial / null / wrong-shaped API response must not blank the
 *             page. `undefined` and "1 个 undefined" are both acceptable failures
 *             for a UI whose job is to explain what is wrong.
 *   a11y    — every control needs a name a screen reader can announce, and every
 *             button needs text.
 */

patchDom();

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function loadView(name) {
  return import(`../../web/src/views/${name}.js`);
}

/** Render one view against a stubbed API. */
async function render(view, { state = sampleState(), keys = sampleKeys(), routes = {} } = {}) {
  const dom = installPage();
  await useLanguage('en');
  stubFetch({ '/api/state': state, '/api/keys': keys, ...routes });
  const mod = await loadView(view);
  const app = fakeApp({ state });
  const renderers = {
    overview: mod.renderOverview,
    identities: mod.renderIdentities,
    rules: mod.renderRules,
    keys: mod.renderKeys,
    preview: mod.renderPreview,
    doctor: mod.renderDoctor,
    snapshot: mod.renderSnapshot,
    init: mod.renderInit,
  };
  await renderers[view](dom.main, app);
  return { dom, app, container: dom.main };
}

/** Every string reachable in the rendered tree, text and attributes alike. */
function allStrings(root) {
  const out = [];
  for (const node of walk(root)) {
    out.push({ node, value: node.textContent });
    for (const [name, value] of Object.entries(node.attributes)) {
      out.push({ node, name, value });
    }
  }
  return out;
}

/**
 * Prove the payload reached the page as text.
 *
 * A text node cannot contain elements, so: find the text nodes that carry the
 * payload, assert they are genuine `#text` nodes with no children, and assert no
 * element anywhere under `root` came from the payload itself (no event-handler
 * attribute, no smuggled href/srcdoc, no element node whose tag is a payload
 * string).
 */
function assertInert(root, payload) {
  const all = walk(root);
  for (const element of all) {
    assert.doesNotMatch(String(element.tagName), /<|>/i, `payload became the <${element.tagName}> element`);
    for (const name of Object.keys(element.attributes)) {
      assert.doesNotMatch(name, /^on/i, `payload created an event-handler attribute ${name}`);
      assert.ok(name !== 'href' && name !== 'srcdoc', `payload created a navigable attribute ${name}`);
    }
  }

  const carriers = all.filter((node) => node.textContent.includes(payload));
  const textNodes = carriers.flatMap((node) =>
    collectTextNodes(node).filter((textNode) => textNode._text.includes(payload)),
  );
  assert.ok(textNodes.length > 0, `the payload is not shown at all: ${JSON.stringify(payload)}`);
  for (const textNode of textNodes) {
    assert.equal(textNode.tagName, '#TEXT', `the payload was written to a <${textNode.tagName}> element`);
    assert.deepEqual(textNode.children, [], 'a text node has no children');
  }
}

/** Every `#text` node under (and including) `node`. */
function collectTextNodes(node, out = []) {
  if (node.tagName === '#TEXT') out.push(node);
  for (const child of node.children ?? []) collectTextNodes(child, out);
  return out;
}

const XSS = [
  '<img src=x onerror="alert(1)">',
  '"><script>alert(1)</script>',
  '<svg onload=alert(1)>',
  "javascript:alert('xss')",
  '<iframe srcdoc="<script>alert(1)</script>">',
];

/* ------------------------------------------------------------------ */
/* XSS: user-controlled strings                                      */
/* ------------------------------------------------------------------ */

test('an identity name renders as text, not markup', async () => {
  for (const payload of XSS) {
    const { dom } = await render('overview', {
      state: sampleState({
        identities: [
          { name: payload, email: 'x@example.com', userName: payload, sshKey: payload, sites: [] },
        ],
      }),
    });
    const grid = dom.main.querySelectorAll('.grid')[0];
    assert.ok(grid, 'the identity grid rendered');
    assert.ok(text(grid).includes(payload), `${payload} is shown`);
    assertInert(grid, payload);
  }
});

test('a rule directory renders as text, not markup', async () => {
  for (const payload of XSS) {
    const { dom } = await render('rules', {
      state: sampleState({ rules: [{ dir: payload, identity: 'work' }] }),
    });
    const row = dom.main.querySelectorAll('.row')[0];
    assert.ok(row, 'the rule row rendered');
    assertInert(row, payload);
  }
});

test('an identity name and note render as text in the identities screen', async () => {
  for (const payload of XSS) {
    const { dom } = await render('identities', {
      state: sampleState({
        identities: [
          {
            name: payload,
            email: `${payload}@example.com`,
            userName: payload,
            sshKey: null,
            sites: [{ host: payload, port: 22, alias: payload }],
          },
        ],
        rules: [{ dir: payload, identity: payload }],
      }),
    });
    assert.ok(text(dom.main).includes(payload));
    const cards = dom.main.querySelectorAll('.card');
    for (const card of cards) {
      for (const element of walk(card)) {
        assert.doesNotMatch(element.tagName, /^SCRIPT$|^IMG$|^IFRAME$|^SVG$/i);
      }
    }
    assertInert(dom.main.querySelectorAll('.grid')[0], payload);
  }
});

test('a site host from the profile renders as text, not markup', async () => {
  for (const payload of XSS) {
    const { dom } = await render('overview', {
      state: sampleState({
        identities: [
          { name: 'work', email: 'w@example.com', userName: 'w', sshKey: 'k', sites: [{ host: payload, port: null, alias: null }] },
        ],
      }),
    });
    assertInert(dom.main.querySelectorAll('.grid')[0], payload);
  }
});

test('a key name and fingerprint render as text', async () => {
  for (const payload of XSS) {
    const { dom } = await render('keys', {
      state: sampleState(),
      keys: {
        keys: [
          { name: payload, type: 'ED25519', fingerprint: payload, comment: payload, hasPublic: true, usedBy: [payload] },
        ],
      },
    });
    assertInert(dom.main.querySelectorAll('.card')[0], payload);
  }
});

test('a diff hunk renders as text, not markup', async () => {
  const payload = '<img src=x onerror="alert(1)">';
  const { dom } = await render('preview', {
    routes: {
      '/api/plan': {
        dirty: true,
        errors: [],
        warnings: [],
        files: [{ label: '~/.gitconfig', kind: 'update', diff: `+${payload}\n-context` }],
      },
    },
  });
  const pre = findByTag(dom.main, 'pre')[0];
  assert.ok(pre, 'the diff block rendered');
  // one coloured span per line; the payload never became a nested element
  assert.equal(findByTag(pre, 'span').length, 2, 'one span per diff line');
  assertInert(pre, payload);
});

test('a doctor message and fix render as text', async () => {
  const payload = '<img src=x onerror="alert(1)">';
  const { dom } = await render('doctor', {
    routes: {
      '/api/doctor': {
        errors: 1,
        warnings: 0,
        results: [{ id: 'a', level: 'error', title: payload, detail: payload, fix: payload }],
      },
    },
  });
  const card = dom.main.querySelectorAll('.card').at(-1);
  assertInert(card, payload);
});


test('no frontend module assigns innerHTML, outerHTML or insertAdjacentHTML', async () => {
  const files = [];
  const dir = 'web/src';
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(entry.parentPath ?? dir, entry.name));
  }
  assert.ok(files.length >= 10, `expected the views, found ${files.length} files`);

  /** Strip strings and comments so a mention in prose is not a sink. */
  const codeOnly = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  const offenders = [];
  for (const file of files) {
    const source = codeOnly(await readFile(file, 'utf8'));
    for (const match of source.matchAll(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b/g)) {
      offenders.push(`${file.split(path.sep).join('/')}: ${match[0]}`);
    }
    if (/\bdocument\.write\s*\(/.test(source)) offenders.push(`${file.split(path.sep).join('/')}: document.write`);
  }
  assert.deepEqual(offenders, [], `markup injection sinks in the frontend:\n${offenders.join('\n')}`);

  // el() feeds every view: it must write text through textContent only
  const dom = codeOnly(await readFile('web/src/dom.js', 'utf8'));
  assert.match(dom, /node\.textContent = value/, 'el() sets the text property');
  assert.doesNotMatch(dom, /innerHTML|createContextualFragment/, 'el() must never build markup');
});

test('el() routes every attribute through setAttribute and every child through text nodes', async () => {
  const { el } = await import('../../web/src/dom.js');
  const node = el('div', {
    class: 'card',
    text: '<b>not bold</b>',
    title: '"><script>x</script>',
    dataset: { view: '<x>' },
    onclick: () => {},
    'data-x': true,
  });
  assert.equal(node.className, 'card');
  assert.equal(node.textContent, '<b>not bold</b>');
  assert.equal(walk(node).length, 0, 'text became an element');
  assert.equal(node.attributes.title, '"><script>x</script>', 'attributes are stored verbatim, never parsed');
  assert.equal(node.attributes['data-x'], '');
  assert.ok(node.listeners.click);
});

/* ------------------------------------------------------------------ */
/* degraded data                                                       */
/* ------------------------------------------------------------------ */

const BROKEN_STATES = [
  { name: 'no identities key', state: { rules: [], repositories: [] } },
  { name: 'null fields', state: { identities: null, rules: null, repositories: null } },
  { name: 'empty everything', state: { identities: [], rules: [], repositories: [] } },
  {
    name: 'identity missing every optional field',
    state: { identities: [{ name: 'x' }], rules: [], repositories: [] },
  },
  {
    name: 'site missing its host',
    state: { identities: [{ name: 'x', email: 'x@y', userName: 'x', sshKey: null, sites: [{}] }], rules: [], repositories: [] },
  },
  { name: 'null profilePath', state: { identities: [], rules: [], repositories: [], profilePath: null } },
  { name: 'numeric fields where strings are expected', state: { identities: [{ name: 1, email: 2, userName: 3, sites: [] }], rules: [], repositories: [] } },
];

for (const { name, state } of BROKEN_STATES) {
  test(`the overview screen survives a partial state: ${name}`, async () => {
    try {
      await render('overview', { state });
    } catch (err) {
      // A degraded /api/state must never crash the screen: main.js surfaces the
      // raw TypeError in a red notice and the tab goes blank.
      assert.fail(`renderOverview threw for "${name}": ${err.message}`);
    }
  });

  test(`the identities screen survives a partial state: ${name}`, async () => {
    try {
      await render('identities', { state });
    } catch (err) {
      assert.fail(`renderIdentities threw for "${name}": ${err.message}`);
    }
  });
}

test('an empty profile says so instead of rendering a blank page', async () => {
  const { dom } = await render('identities', {
    state: { identities: [], rules: [], repositories: [], profilePath: '~/.config/gs/profiles.yaml' },
  });
  assert.ok(
    text(dom.main).includes(EN['web.noIdentities']),
    `expected "${EN['web.noIdentities']}" in: ${text(dom.main)}`,
  );
});

test('a profile with no rules explains the fallback', async () => {
  const { dom } = await render('rules', { state: sampleState({ rules: [] }) });
  assert.ok(text(dom.main).includes(EN['web.noRules']));
});

test('rendered text never contains undefined, NaN or [object Object]', async () => {
  for (const { name, state } of BROKEN_STATES) {
    for (const view of ['overview', 'identities', 'rules']) {
      let dom;
      try {
        ({ dom } = await render(view, { state }));
      } catch {
        continue; // the crash itself is asserted above for the two main screens
      }
      const rendered = text(dom.main);
      for (const sentinel of ['undefined', 'NaN', '[object Object]']) {
        assert.ok(
          !rendered.includes(sentinel),
          `${view} / ${name} rendered ${sentinel}: ${rendered.slice(0, 300)}`,
        );
      }
    }
  }
});

test('a failing preview call shows the error and no apply button', async () => {
  const dom = installPage();
  await useLanguage('en');
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({ error: 'plan exploded' }) });
  const { renderPreview } = await loadView('preview');
  await renderPreview(dom.main, fakeApp());

  assert.ok(text(dom.main).includes('plan exploded'));
  const apply = findByTag(dom.main, 'button').find((b) => b.textContent === EN['web.apply']);
  assert.equal(apply, undefined, 'nothing may be applied when the plan could not be computed');
});

test('a failing doctor call shows the error instead of throwing', async () => {
  const dom = installPage();
  await useLanguage('en');
  globalThis.fetch = async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: 'no profile' }) });
  const { renderDoctor } = await loadView('doctor');
  await renderDoctor(dom.main, fakeApp());
  assert.ok(text(dom.main).includes('no profile'));
});

test('a doctor report with no results still renders the summary', async () => {
  const { dom } = await render('doctor', { routes: { '/api/doctor': { errors: 0, warnings: 0, results: [] } } });
  assert.ok(text(dom.main).includes(EN['web.okTag'].replace('{0}', '0')));
});

test('init on an existing profile explains why it will not run', async () => {
  const { dom } = await render('init', { state: sampleState({ profileExists: true }) });
  assert.ok(text(dom.main).includes(EN['web.initAlreadyExists']));
});

/* ------------------------------------------------------------------ */
/* long text                                                           */
/* ------------------------------------------------------------------ */

const LONG_PATH = `D:/${'very-long-directory-name/'.repeat(60)}project`;
const LONG_LINE = 'x'.repeat(20000);

test('a very long path renders without truncating inside the DOM', async () => {
  const { dom } = await render('rules', {
    state: sampleState({ rules: [{ dir: LONG_PATH, identity: 'work' }] }),
  });
  const pathNode = dom.main.querySelectorAll('.path')[0];
  assert.ok(pathNode, 'the rule path rendered');
  assert.equal(pathNode.textContent, LONG_PATH, 'the DOM keeps the whole path; CSS ellipsizes it');
});

test('long text is never split into one character per node', async () => {
  const { dom } = await render('overview', {
    state: sampleState({
      identities: [{ name: LONG_LINE, email: 'x@y', userName: LONG_LINE, sshKey: null, sites: [] }],
    }),
  });
  const strong = findByTag(dom.main, 'strong')[0];
  assert.ok(strong, 'the identity name rendered');
  assert.equal(walk(strong).length, 0, 'the name is one text node, not one node per character');
  assert.equal(strong.textContent, LONG_LINE);
});

test('a 20 000 character diff line does not crash the diff block', async () => {
  const { dom } = await render('preview', {
    routes: {
      '/api/plan': { dirty: true, errors: [], warnings: [], files: [{ label: 'f', kind: 'update', diff: `+${LONG_LINE}\n-x\n ctx` }] },
    },
  });
  const pre = findByTag(dom.main, 'pre')[0];
  assert.ok(pre, 'the diff rendered');
  // one coloured span per line: +line, -line, context line
  assert.equal(findByTag(pre, 'span').length, 3, 'one span per diff line');
});

test('the CSS keeps pathological text from breaking the layout', async () => {
  const css = await readFile('web/src/styles/main.css', 'utf8');
  const ruleOf = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join('\n');
  };

  assert.match(ruleOf('.path'), /text-overflow:\s*ellipsis/, 'long paths must ellipsize');
  assert.match(ruleOf('.path'), /min-width:\s*0/, '.path must be allowed to shrink');
  assert.match(ruleOf('.kv-value'), /overflow-wrap:\s*anywhere/, 'long values must wrap instead of overflowing');
  assert.match(ruleOf('pre.diff'), /overflow-x:\s*auto/, 'a wide diff needs its own scroll container');
  assert.match(ruleOf('.profile-error .notice'), /overflow-wrap:\s*anywhere/, 'a long parse error must wrap');
});

/* ------------------------------------------------------------------ */
/* accessibility                                                       */
/* ------------------------------------------------------------------ */

const VIEW_RENDERERS = [
  ['overview', {}],
  ['identities', {}],
  ['rules', {}],
  ['keys', {}],
  ['snapshot', {}],
  ['init', { state: sampleState({ profileExists: false }) }],
  ['preview', { routes: { '/api/plan': { dirty: false, errors: [], warnings: [], files: [] } } }],
  ['doctor', { routes: { '/api/doctor': { errors: 0, warnings: 0, results: [] } } }],
];

for (const [view, options] of VIEW_RENDERERS) {
  test(`${view}: every button has an accessible name`, async () => {
    const { dom } = await render(view, options);
    const nameless = findByTag(dom.main, 'button').filter((button) => text(button).trim() === '');
    assert.deepEqual(nameless.map((b) => b.className), [], `${view} rendered a button with no text`);
  });
}

/** Controls that a screen reader must be able to name. Checkboxes are excluded: their text is the <label> content. */
function unlabelledControls(dom) {
  const controls = [
    ...findByTag(dom.main, 'input').filter((input) => input.getAttribute('type') !== 'checkbox'),
    ...findByTag(dom.main, 'select'),
  ];
  return controls
    .filter((control) => labelsFor(dom.main, control).length === 0 && !control.getAttribute('aria-label'))
    .map(
      (control) =>
        `<${control.tagName.toLowerCase()} class="${control.className}" placeholder="${control.getAttribute('placeholder') ?? ''}">`,
    );
}

// Every screen must name its controls: a placeholder disappears as soon as the
// user types and is never announced as a label.
for (const [view, options] of VIEW_RENDERERS) {
  test(`${view}: every input and select is named`, async () => {
    const { dom } = await render(view, options);
    assert.deepEqual(unlabelledControls(dom), [], `${view} has controls without an accessible name`);
  });
}

test('the identity edit panel labels every field', async () => {
  const { dom } = await render('identities', {});
  const edit = findByTag(dom.main, 'button').find((b) => b.textContent === EN['web.editIdentity']);
  edit.dispatchEvent({ type: 'click', target: edit });

  const panel = dom.main.querySelectorAll('.edit-panel')[0];
  assert.ok(panel, 'the edit panel opened');
  const controls = [...findByTag(panel, 'input'), ...findByTag(panel, 'select')];
  assert.ok(controls.length >= 8, `expected the full form, found ${controls.length} controls`);
  for (const control of controls) {
    assert.ok(labelsFor(panel, control).length > 0, `unlabelled ${control.tagName.toLowerCase()}`);
  }
});

test('the identity edit panel preserves the values shown on the card', async () => {
  // Opening the editor is how a user changes one field; every other field must
  // still hold the identity's current value, or saving silently clears it.
  const { dom } = await render('identities', {});
  const edit = findByTag(dom.main, 'button').find((b) => b.textContent === EN['web.editIdentity']);
  edit.dispatchEvent({ type: 'click', target: edit });

  const panel = dom.main.querySelectorAll('.edit-panel')[0];
  const inputs = findByTag(panel, 'input');
  const values = inputs.map((input) => input.value);
  assert.ok(
    values.includes('work') && values.includes('w@example.com') && values.includes('git.company.com'),
    `editor is not pre-filled with the card values: ${JSON.stringify(values)}`,
  );
});

test('the language picker and the tab bar expose their role and state', async () => {
  const dom = installPage();
  const nav = findByTag(dom.body, 'nav').find((node) => node.getAttribute('role') === 'tablist');
  assert.ok(nav, 'the tab bar is a nav with role=tablist');
  const tabs = findByTag(nav, 'button');
  assert.equal(tabs.length, 8, 'eight tabs, one per screen');
  for (const tab of tabs) {
    assert.equal(tab.getAttribute('role'), 'tab', 'each tab declares its role');
    assert.ok(tab.getAttribute('data-view'), 'each tab names its view');
  }
  const select = findById(dom, 'language');
  assert.ok(select.getAttribute('aria-label'), 'the language picker is labelled');
  const trigger = findById(dom, 'about-trigger');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'true');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
