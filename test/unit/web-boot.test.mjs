import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EN, ZH, installPage, patchDom, stubFetch, sampleState, sampleKeys, useLanguage, findById, findByTag, text } from './web-harness.mjs';

/**
 * Integration tests for the real `web/src/main.js`.
 *
 * main.js boots itself on import: it reads the URL fragment (via api.js), fetches
 * `/api/state` and renders. Two consequences shape this file:
 *
 *   - web/src/api.js captures the token when *it* is imported, so the page must
 *     be installed and the token set before main.js is first imported;
 *   - the module graph keeps its state for the whole process, so every test here
 *     shares one booted page and drives it through the language picker, exactly
 *     as a user does. Requests are answered from a mutable route table.
 *
 * This file therefore must not import any other view module first. That is why
 * the page-level tests live apart from web-render.test.mjs.
 */

patchDom();

const ROUTES = {
  '/api/state': sampleState(),
  '/api/keys': sampleKeys(),
  '/api/version': {
    version: '0.1.0+29.g4f3a3bf',
    name: 'git-switch',
    author: 'CodeMonkeyJust',
    license: 'MIT',
    repository: 'https://github.com/CodeMonkeyJust/git-switch',
    commit: '4f3a3bf',
    builtAt: '2026-01-01',
    channel: 'release',
    dirty: false,
  },
  '/api/plan': { dirty: false, errors: [], warnings: [], files: [] },
  '/api/doctor': { errors: 0, warnings: 0, results: [] },
  '/api/identities': { identities: [], rules: [], repositories: [] },
};

const dom = installPage();
const PAGE = await (async () => {
  await useLanguage('en');
  stubFetch(ROUTES);
  globalThis.location = { hash: '#token=test-token', href: 'http://127.0.0.1/', reload() {} };
  globalThis.confirm = () => true;
  await import('../../web/src/main.js');
  await waitFor(() => findById(dom, 'about-panel').children.length > 0, 'the About panel was filled');
  return dom;
})();

/** Poll until `predicate` holds; failure reports what the test was waiting for. */
async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/**
 * Switch the language through the picker, the way a user does, and wait until
 * the reloaded catalogue is in effect. The API keeps answering from ROUTES, so
 * the caller decides which catalogue the server returns.
 */
async function switchLanguage(lang) {
  const marker = lang === 'zh-CN' ? '身份管理' : 'identities';
  // The picker only fires `change` when the value really changes, so a no-op
  // switch has to return immediately or waitFor() would wait for a re-render
  // that never comes.
  if (dom.language.value === lang && dom.document.title.includes(marker)) return;

  dom.language.value = lang;
  dom.language.dispatchEvent({ type: 'change', target: dom.language });
  await waitFor(
    () => dom.document.title.includes(marker),
    `the page to switch to ${lang} (title is ${JSON.stringify(dom.document.title)})`,
  );
  await waitFor(() => dom.language.value === lang, `the picker to settle on ${lang}`);
}

const statusNode = () => findById(dom, 'status');
const viewNode = () => findById(dom, 'main').children.find((child) => child.className === 'view');

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

test('boot renders the overview and the status summary', async () => {
  assert.ok(statusNode(), 'the status bar exists');
  assert.equal(statusNode().textContent, EN['web.counts'].replace('{0}', '2').replace('{1}', '1').replace('{2}', '0'));
  assert.doesNotMatch(statusNode().textContent, /loading/i, 'the loading placeholder was replaced');

  const view = viewNode();
  assert.ok(view, 'a view container was rendered');
  assert.match(text(view), /work/, 'the overview lists the identities');
});

test('the tab bar is labelled from the catalogue', () => {
  const tabs = dom.body.querySelectorAll('.tab');
  assert.equal(tabs.length, 8);
  for (const tab of tabs) {
    const expected = EN[`web.tab.${tab.dataset.view}`];
    assert.equal(tab.textContent, expected, `${tab.dataset.view} tab label`);
  }
});

test('the page title and the About trigger come from the catalogue', () => {
  assert.equal(dom.document.title, EN['web.title']);
  const label = findByTag(dom.aboutTrigger, 'span')[0];
  assert.equal(label.textContent, EN['web.viewBuildInfo']);
});

test('the home banner says which home is being edited', () => {
  const banner = findById(dom, 'home-banner');
  assert.ok(text(banner).includes('C:/Users/me'), `banner did not name the home: ${text(banner)}`);
  assert.ok(text(banner).includes(EN['web.dismiss']), 'the banner can be dismissed');
});

test('the language picker offers exactly the supported languages', () => {
  const options = findByTag(dom.language, 'option').map((option) => option.value);
  assert.deepEqual(options, ['en', 'zh-CN']);
});

/* ------------------------------------------------------------------ */
/* language switching                                                  */
/* ------------------------------------------------------------------ */

test('switching the language re-translates the chrome and the view', async () => {
  ROUTES['/api/state'] = sampleState({ language: 'zh-CN', messages: ZH });

  try {
    await switchLanguage('zh-CN');

    assert.equal(dom.document.title, ZH['web.title']);
    for (const tab of dom.body.querySelectorAll('.tab')) {
      assert.equal(tab.textContent, ZH[`web.tab.${tab.dataset.view}`], `${tab.dataset.view} tab is translated`);
    }
    assert.equal(findByTag(dom.aboutTrigger, 'span')[0].textContent, ZH['web.viewBuildInfo']);
    assert.match(text(viewNode()), /身份/, 'the overview was rendered in Chinese');
  } finally {
    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');
  }
});

test('a language round trip never resets the status bar to the loading placeholder', async () => {
  const expectedStatus = EN['web.counts'].replace('{0}', '2').replace('{1}', '1').replace('{2}', '0');

  try {
    ROUTES['/api/state'] = sampleState({ language: 'zh-CN', messages: ZH });
    await switchLanguage('zh-CN');
    assert.equal(dom.document.title, ZH['web.title'], 'the title is translated');
    assert.doesNotMatch(
      statusNode().textContent,
      /加载中|loading/i,
      'the status fell back to the loading placeholder (the historical regression)',
    );

    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');

    assert.equal(dom.document.title, EN['web.title'], 'the title is back to English');
    for (const tab of dom.body.querySelectorAll('.tab')) {
      assert.equal(tab.textContent, EN[`web.tab.${tab.dataset.view}`], `${tab.dataset.view} back to English`);
    }
    // The status text was written by boot(); translateChrome() must not touch it.
    assert.equal(
      statusNode().textContent,
      expectedStatus,
      `a language switch overwrote the status bar: got ${JSON.stringify(statusNode().textContent)}`,
    );
  } finally {
    ROUTES['/api/state'] = sampleState();
  }
});

// WEB-1 (the status bar is not re-translated) and WEB-2 (<html lang> is never
// updated) are reproduced in web-known-defects.test.mjs, alongside every other
// defect this audit found. This file keeps the behaviour that must hold today.

test('the home banner is re-translated and not duplicated by a language switch', async () => {
  try {
    ROUTES['/api/state'] = sampleState({ language: 'zh-CN', messages: ZH });
    await switchLanguage('zh-CN');

    const banner = findById(dom, 'home-banner');
    const notices = findByTag(banner, 'div').filter((node) => node.className.startsWith('notice'));
    assert.equal(notices.length, 1, 'exactly one banner, not one per render');
    assert.match(text(notices[0]), /真实 home|沙箱/);

    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');
    const english = findByTag(findById(dom, 'home-banner'), 'div').filter((node) => node.className.startsWith('notice'));
    assert.equal(english.length, 1);
    assert.match(text(english[0]), /Operating on your real home/);
  } finally {
    ROUTES['/api/state'] = sampleState();
  }
});

test('a sandbox home is called out as a sandbox after a language switch', async () => {
  try {
    ROUTES['/api/state'] = sampleState({
      isSandbox: true,
      homePath: 'C:/tmp/gs-sandbox',
      language: 'zh-CN',
      messages: ZH,
    });
    await switchLanguage('zh-CN');

    const banner = findByTag(findById(dom, 'home-banner'), 'div').find((node) => node.className === 'notice error');
    assert.ok(banner, 'a sandbox banner is styled as a warning');
    assert.equal(banner.className, 'notice error');
    assert.match(text(banner), /沙箱/);
  } finally {
    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');
  }
});

test('switching tabs after a language switch keeps the tab labels translated', async () => {
  try {
    ROUTES['/api/state'] = sampleState({ language: 'zh-CN', messages: ZH });
    await switchLanguage('zh-CN');

    const rulesTab = dom.body.querySelectorAll('.tab').find((tab) => tab.dataset.view === 'rules');
    rulesTab.dispatchEvent({ type: 'click', target: rulesTab });
    await waitFor(() => text(viewNode()).includes(ZH['web.addRuleTitle']), 'the rules view in Chinese');

    assert.equal(rulesTab.getAttribute('aria-selected'), 'true');
    const overviewTab = dom.body.querySelectorAll('.tab').find((tab) => tab.dataset.view === 'overview');
    assert.equal(overviewTab.getAttribute('aria-selected'), 'false');
  } finally {
    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');
  }
});

/* ------------------------------------------------------------------ */
/* user-controlled text                                                */
/* ------------------------------------------------------------------ */

test('a profile error banner shows user text as text', async () => {
  const payload = '<img src=x onerror="alert(1)">';

  try {
    ROUTES['/api/state'] = sampleState({
      profileError: `invalid field: ${payload}`,
      language: 'zh-CN',
      messages: ZH,
    });
    // the language picker is the path that re-renders the banner in place
    await switchLanguage('zh-CN');

    const slot = findById(dom, 'profile-error');
    assert.ok(text(slot).includes(payload), 'the message is shown');
    assert.equal(findByTag(slot, 'img').length, 0, 'no markup was created');
    assert.equal(findByTag(slot, 'script').length, 0, 'no script was created');
    for (const node of findByTag(slot, 'div')) {
      for (const name of Object.keys(node.attributes)) {
        assert.doesNotMatch(name, /^on/i, `an event handler attribute ${name} was created`);
      }
    }
    // and the repair offer is translated
    assert.ok(text(slot).includes(ZH['web.tryFix']), 'the "fix it for me" action is translated');
  } finally {
    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');
  }

  assert.equal(text(findById(dom, 'profile-error')), '', 'the banner disappears once the profile loads');
});

test('the About menu never links to a non-web URL', async () => {
  const previousVersion = ROUTES['/api/version'];
  const previousState = ROUTES['/api/state'];
  const zhState = sampleState({ language: 'zh-CN', messages: ZH });

  try {
    for (const repository of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      ROUTES['/api/version'] = { ...previousVersion, repository };
      ROUTES['/api/state'] = zhState;
      // renderVersion() runs after every language switch, which is how the panel
      // picks up the new payload
      await switchLanguage('zh-CN');
      await waitFor(
        () => text(findById(dom, 'about-panel')).includes(repository),
        `the About panel to show ${repository}`,
      );

      const panel = findById(dom, 'about-panel');
      assert.equal(findByTag(panel, 'a').length, 0, `${repository} must not become a link`);
      assert.ok(text(panel).includes(repository), 'the value is still shown, as inert text');

      ROUTES['/api/state'] = previousState;
      await switchLanguage('en');
    }
  } finally {
    ROUTES['/api/version'] = previousVersion;
    ROUTES['/api/state'] = previousState;
    await switchLanguage('en');
  }
});

test('a real repository URL becomes a safe link', async () => {
  try {
    ROUTES['/api/state'] = sampleState({ language: 'zh-CN', messages: ZH });
    // the trigger is only rendered by renderVersion(), which every language
    // switch calls
    await switchLanguage('zh-CN');
    await waitFor(
      () => findByTag(findById(dom, 'about-panel'), 'a').length > 0,
      'the repository link to appear',
    );

    const link = findByTag(findById(dom, 'about-panel'), 'a')[0];
    assert.equal(link.getAttribute('href'), 'https://github.com/CodeMonkeyJust/git-switch');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  } finally {
    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');
  }
});

/* ------------------------------------------------------------------ */
/* the About menu                                                      */
/* ------------------------------------------------------------------ */

test('the About panel starts hidden and toggles aria-expanded', () => {
  const trigger = findById(dom, 'about-trigger');
  const panel = findById(dom, 'about-panel');

  panel.setAttribute('hidden', '');
  trigger.setAttribute('aria-expanded', 'false');

  trigger.dispatchEvent({ type: 'click', target: trigger, stopPropagation() {} });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'the first click opens the menu');
  assert.equal(panel.hasAttribute('hidden'), false, 'the panel is visible');

  trigger.dispatchEvent({ type: 'click', target: trigger, stopPropagation() {} });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'the second click closes it');
  assert.ok(panel.hasAttribute('hidden'));

  trigger.dispatchEvent({ type: 'click', target: trigger, stopPropagation() {} });
  dom.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Escape closes the menu');
  assert.ok(panel.hasAttribute('hidden'));
});

test('the About trigger carries the version and the channel in its tooltip', () => {
  const title = dom.aboutTrigger.getAttribute('title');
  assert.match(title, /0\.1\.0\+29\.g4f3a3bf/, 'the tooltip names the build');
  assert.ok(
    title.includes(EN['web.channelRelease']) || title.includes(EN['web.channelDev']),
    `the tooltip names the channel: ${title}`,
  );
});

test('the status bar follows the active language', async () => {
  try {
    ROUTES['/api/state'] = sampleState({ language: 'zh-CN', messages: ZH });
    await switchLanguage('zh-CN');

    const expected = ZH['web.counts'].replace('{0}', '2').replace('{1}', '1').replace('{2}', '0');
    // The status bar is written once by boot(); nothing re-renders it, so a
    // language switch leaves the boot-time English sentence on screen.
    assert.equal(
      statusNode().textContent,
      expected,
      `status text is stale after switching to zh-CN: got ${JSON.stringify(statusNode().textContent)}, expected ${JSON.stringify(expected)}`,
    );
  } finally {
    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');
  }
});

/* ------------------------------------------------------------------ */
/* document language                                                   */
/* ------------------------------------------------------------------ */

test('the document language follows the active catalogue', async () => {
  // Screen readers pick a pronunciation from <html lang>; a Chinese page that
  // still claims lang="en" is announced in an English voice, and browser
  // translation offers the wrong language. index.html ships lang="en" as a
  // fallback, so main.js must update it when the catalogue changes. Read it via
  // getAttribute: a browser mirrors the attribute on `lang`, the shim stores only
  // the attribute.
  const documentLang = () => dom.document.documentElement.getAttribute('lang');
  assert.equal(documentLang(), 'en', 'the markup fallback');

  try {
    ROUTES['/api/state'] = sampleState({ language: 'zh-CN', messages: ZH });
    await switchLanguage('zh-CN');

    assert.equal(documentLang(), 'zh-CN', '<html lang> must follow the catalogue');
  } finally {
    ROUTES['/api/state'] = sampleState();
    await switchLanguage('en');
  }
  assert.equal(documentLang(), 'en', '<html lang> is restored from the catalogue');
});
