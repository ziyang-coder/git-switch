import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installDom } from '../helpers/dom-shim.mjs';
import { webCatalogue, setLanguage } from '../../src/core/i18n.ts';

/**
 * The status bar must end up showing real information, not the "loading…"
 * placeholder.
 *
 * It once carried `data-i18n="web.loading"`, so every call to translateChrome()
 * re-wrote the element — after boot() had already filled in the counts. The
 * result was a permanent "loading…" in the corner. Guard both halves: the markup
 * must not mark the status element as translatable, and the text must survive a
 * translation pass.
 */

setLanguage('en');
const EN = webCatalogue();
const { setMessages, applyStaticTranslations, t } = await import('../../web/src/i18n.js');
setMessages(EN, 'en');

test('index.html does not mark the status element as translatable', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const statusTag = /<div[^>]*id="status"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(statusTag.length > 0, 'the status element exists');
  assert.doesNotMatch(
    statusTag,
    /data-i18n/,
    'data-i18n on #status makes translateChrome() overwrite the live text',
  );

  // the element must start empty; HTML comments are stripped first so the
  // explanation above it does not count as content
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const statusBody = /<div[^>]*id="status"[^>]*>([\s\S]*?)<\/div>/.exec(withoutComments)?.[1] ?? 'x';
  assert.equal(statusBody.trim(), '', 'no placeholder text is baked into the markup');
});

test('translated chrome leaves a dynamic status text alone', () => {
  const dom = installDom();
  const status = dom.document.getElementById('status');

  status.textContent = t('web.counts', 2, 3, 1);
  const filled = status.textContent;
  assert.notEqual(filled, '', 'counts were written');

  // this is what every render does
  applyStaticTranslations(dom.document);

  assert.equal(status.textContent, filled, 'translating the chrome must not reset the status');
  assert.doesNotMatch(status.textContent, /loading/i);
});

test('the counts message reads as a summary', () => {
  setLanguage('en');
  const text = t('web.counts', 2, 3, 1);
  assert.match(text, /2/);
  assert.match(text, /3/);
  assert.doesNotMatch(text, /loading/i);

  setLanguage('zh-CN');
  setMessages(webCatalogue(), 'zh-CN');
  const zh = t('web.counts', 2, 3, 1);
  assert.doesNotMatch(zh, /加载中/);
  assert.match(zh, /2/);

  setLanguage('en');
  setMessages(EN, 'en');
});

test('boot writes the status after rendering, not before', async () => {
  const source = await readFile('web/src/main.js', 'utf8');

  // Extract boot() by matching its braces. A non-greedy `/async function boot[\s\S]*?\n}/`
  // stops at the first line-leading `}` — inside a nested callback — which once
  // made this test pass locally and fail on a fresh clone.
  const start = source.indexOf('async function boot()');
  assert.ok(start !== -1, 'boot() exists');
  let depth = 0;
  let end = -1;
  let seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
      seen = true;
    } else if (source[i] === '}') {
      depth--;
      if (seen && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end !== -1, 'boot() body is balanced');

  const boot = source.slice(start, end);
  const gotoIndex = boot.indexOf("await app.goto('overview')");
  // The counts are written at boot's own depth (4 spaces). The language-change
  // callback also mentions the same message, deeper (8 spaces), and appears
  // earlier in the source — hence the explicit indent.
  //
  // Line endings differ by checkout: a Windows clone with autocrlf produces CRLF
  // while the repository stores LF, so the pattern must accept both.
  const countsIndex = boot.search(/\r?\n {4}status\.textContent = t\(\r?\n {6}'web\.counts'/);

  assert.ok(gotoIndex !== -1, 'boot renders the overview');
  assert.ok(countsIndex !== -1, 'boot writes the counts');
  assert.ok(
    gotoIndex < countsIndex,
    'the counts must be written after goto(), which re-translates the chrome',
  );
});
