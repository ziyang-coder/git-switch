import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { EN, ZH } from './web-harness.mjs';

/**
 * Internationalisation coverage for the browser UI.
 *
 * `test/unit/i18n.test.ts` guards the CLI catalogues; this file guards the
 * *browser* contract:
 *
 *   - the catalogue the server sends really carries every key the page asks for,
 *     in both languages (a missing key renders as its raw id, e.g. "web.save");
 *   - English and Chinese describe the same set of phrases, with the same
 *     placeholders, so a Chinese user never sees a half-translated screen;
 *   - a message is only ever filled through `t()`, never with hard-coded English
 *     or hand-built strings that skip a placeholder;
 *   - the static markup is translated too, not just the dynamically built DOM.
 */

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function walk(dir, predicate, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, predicate, out);
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

/** Frontend source files, with posix paths for readable failure messages. */
async function frontendSources() {
  const files = await walk('web/src', (name) => name.endsWith('.js'));
  return Promise.all(
    files.map(async (file) => ({
      file: file.split(path.sep).join('/'),
      source: await readFile(file, 'utf8'),
    })),
  );
}

const placeholderTokens = (value) => (value.match(/\{\d+\}/g) ?? []).sort();

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** Keys the page can ask for, including the ones built from a template. */
function keysUsedByFrontend(sources) {
  const used = new Set();
  for (const { source } of sources) {
    // t('web.save') and any other literal message key
    for (const match of source.matchAll(/\bt\(\s*'([a-z][\w]*(?:\.[\w]+)+)'/g)) {
      used.add(match[1]);
    }
    // `web.tab.${view}` — expand the known view ids instead of guessing one
    for (const match of source.matchAll(/`([a-z][\w]*\.[\w.]*)\$\{/g)) {
      const prefix = match[1];
      if (prefix === 'web.tab.') {
        for (const view of ['overview', 'keys', 'identities', 'rules', 'preview', 'doctor', 'snapshot', 'init']) {
          used.add(`web.tab.${view}`);
        }
      } else {
        throw new Error(`unexpanded message-key template in the frontend: ${prefix}\${…}`);
      }
    }
  }
  return used;
}

/** Attributes in web/index.html and the JS, as {tag, attrs}. */
async function markupTags() {
  const html = await readFile('web/index.html', 'utf8');
  const tags = [];
  for (const match of html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*"[^"]*")?)*)\s*\/?>/g)) {
    const attrs = {};
    for (const attr of match[2].matchAll(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g)) {
      if (attr[1]) attrs[attr[1]] = attr[2] ?? '';
    }
    tags.push({ name: match[1].toLowerCase(), attrs });
  }
  return tags;
}

/** Decode the few entities index.html uses, so text compares as a browser sees it. */
function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/* ------------------------------------------------------------------ */
/* catalogue completeness                                              */
/* ------------------------------------------------------------------ */

test('the browser payload carries every web.* and version.* key, in both languages', () => {
  const enKeys = Object.keys(EN).sort();
  const zhKeys = Object.keys(ZH).sort();

  const notShipped = enKeys.filter((key) => !key.startsWith('web.') && !key.startsWith('version.'));
  assert.deepEqual(notShipped, [], `CLI-only keys leaked into the API payload: ${notShipped.join(', ')}`);

  assert.deepEqual(zhKeys, enKeys, 'the Chinese payload must carry exactly the English keys');

  // the tab bar is generated from `web.tab.<view>`, so a missing tab key is blank
  for (const view of ['overview', 'keys', 'identities', 'rules', 'preview', 'doctor', 'snapshot', 'init']) {
    assert.ok(EN[`web.tab.${view}`], `missing English tab label for ${view}`);
    assert.ok(ZH[`web.tab.${view}`], `missing Chinese tab label for ${view}`);
  }
});

test('every frontend t() key is in the payload for both languages', async () => {
  const used = keysUsedByFrontend(await frontendSources());
  assert.ok(used.size > 100, `only ${used.size} keys found — the scan is probably broken`);

  for (const [lang, catalogue] of [
    ['en', EN],
    ['zh-CN', ZH],
  ]) {
    const missing = [...used].filter((key) => catalogue[key] === undefined).sort();
    assert.deepEqual(missing, [], `${lang}: keys used by the page but not shipped: ${missing.join(', ')}`);
  }
});

test('English and Chinese placeholder sets match key by key', () => {
  const differences = [];
  for (const key of Object.keys(EN)) {
    const en = EN[key];
    const zh = ZH[key];
    if (zh === undefined) continue;

    const enTokens = placeholderTokens(en);
    const zhTokens = placeholderTokens(zh);
    if (enTokens.join(',') !== zhTokens.join(',')) {
      differences.push(`${key}: en=[${enTokens.join(',')}] zh=[${zhTokens.join(',')}]`);
    }
    // an index hole ({0} but no {1} while {2} is used) leaves a suffix unfilled
    const indices = enTokens.map((token) => Number(token.slice(1, -1)));
    const expected = [...Array(indices.length).keys()];
    if (indices.length > 0 && new Set(indices).size !== indices.length) {
      differences.push(`${key}: duplicate placeholder index in en=[${enTokens.join(',')}]`);
    } else if (indices.sort((a, b) => a - b).join(',') !== expected.join(',')) {
      differences.push(`${key}: placeholder indices are not 0..n in en=[${enTokens.join(',')}]`);
    }
  }
  assert.deepEqual(differences, [], `placeholder mismatches:\n${differences.join('\n')}`);
});

test('the Chinese payload is actually translated', () => {
  // Key-shaped values ("web.counts") and identical en/zh pairs both mean the
  // page shows English text to a Chinese user.
  const untranslated = Object.keys(ZH).filter((key) => ZH[key] === EN[key] && !CJK.test(ZH[key]));
  const allowed = new Set([
    // acronyms and identifiers that are language-neutral by intent
    'web.sshKey',
    'web.keysTitle',
    'web.section.key',
    'web.field.sshKey',
    'web.field.keyType',
    'web.keyType',
  ]);
  const suspicious = untranslated.filter((key) => !allowed.has(key) && EN[key] !== key);
  assert.deepEqual(
    suspicious.map((key) => `${key}: ${JSON.stringify(EN[key])}`),
    [],
    'these Chinese entries are still the English text',
  );

  for (const key of Object.keys(ZH)) {
    assert.notEqual(ZH[key], key, `${key} fell back to the raw key — it is missing from the Chinese map`);
    assert.ok(ZH[key].trim() !== '', `${key} is empty in Chinese`);
  }
  for (const key of Object.keys(EN)) {
    assert.ok(EN[key].trim() !== '', `${key} is empty in English`);
  }
});

test('no message renders a placeholder sentinel instead of a value', () => {
  for (const [lang, catalogue] of [
    ['en', EN],
    ['zh-CN', ZH],
  ]) {
    for (const [key, value] of Object.entries(catalogue)) {
      assert.doesNotMatch(
        value,
        /(?:^|[\s"'(])(?:undefined|null|NaN)(?:$|[\s"').,;:!?])/,
        `${lang}:${key} renders the sentinel ${JSON.stringify(value)}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* static markup                                                       */
/* ------------------------------------------------------------------ */

test('index.html never hard-codes English UI text', async () => {
  const runs = textRuns(await readFile('web/index.html', 'utf8'));

  const offenders = [];
  for (const run of runs) {
    if (!/[A-Za-z]/.test(run.text)) continue;

    // The brand ("gs") and the tab labels are allowed to be English in source:
    // translateChrome() replaces every tab label from the catalogue on the first
    // render. Everything else would stay English after switching to Chinese.
    if (run.text === 'gs') continue;
    if (run.text === 'gs — Git & SSH identities') continue;
    if (run.ancestors.some((tag) => tag.attrs['data-view'])) continue; // a tab label
    if (run.ancestors.some((tag) => tag.attrs['data-i18n'])) continue; // translated below

    offenders.push(`${run.text}  (inside <${run.ancestors.map((tag) => tag.name).join(' > ')}>)`);
  }

  assert.deepEqual(offenders, [], `text that no data-i18n can replace after a language switch:\n${offenders.join('\n')}`);
});

/**
 * Text runs of an HTML document, each with its ancestor element chain.
 *
 * A deliberately tiny parser: it only has to understand the markup this project
 * writes (elements, void elements, attributes, comments). Text inside an element
 * is reported separately from the element's own attribute values, which is what
 * distinguishes a translated label from a hard-coded one.
 */
function textRuns(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/i, '');
  const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source']);
  const stack = [];
  const runs = [];

  for (const token of source.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (token[5] !== undefined) {
      const value = decodeEntities(token[5].replace(/\s+/g, ' ').trim());
      if (value !== '') runs.push({ text: value, ancestors: [...stack].reverse() });
      continue;
    }
    const name = token[2].toLowerCase();
    if (token[1] === '/') {
      const index = stack.map((tag) => tag.name).lastIndexOf(name);
      if (index >= 0) stack.length = index;
      continue;
    }
    const attrs = {};
    for (const attr of token[3].matchAll(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g)) {
      if (attr[1]) attrs[attr[1]] = attr[2] === undefined ? '' : decodeEntities(attr[2]);
    }
    const element = { name, attrs };
    if (!VOID.has(name) && token[4] !== '/') stack.push(element);
  }
  return runs;
}

test('the tab bar in the markup is fully covered by the catalogue', async () => {
  const tags = await markupTags();
  const tabs = tags.filter((tag) => tag.attrs['data-view']);
  assert.ok(tabs.length >= 8, `expected at least 8 tabs, found ${tabs.length}`);

  const views = tabs.map((tag) => tag.attrs['data-view']);
  assert.equal(new Set(views).size, views.length, 'duplicate data-view values');
  for (const view of views) {
    assert.ok(EN[`web.tab.${view}`], `no English label for the ${view} tab`);
    assert.ok(ZH[`web.tab.${view}`], `no Chinese label for the ${view} tab`);
  }

  // every static data-i18n hook names a key that exists in both payloads
  for (const attr of ['data-i18n', 'data-i18n-title']) {
    for (const tag of tags.filter((candidate) => candidate.attrs[attr])) {
      const key = tag.attrs[attr];
      assert.ok(EN[key], `${attr}="${key}" does not exist in the English payload`);
      assert.ok(ZH[key], `${attr}="${key}" does not exist in the Chinese payload`);
    }
  }
});

test('the page declares the language it is written in', async () => {
  const tags = await markupTags();
  const html = tags.find((tag) => tag.name === 'html');
  // A hard-coded lang="en" makes a Chinese page claim to be English, which
  // breaks screen-reader pronunciation and browser translation. main.js must own
  // the attribute; web-boot.test.mjs asserts that it really changes.
  assert.equal(html?.attrs.lang, 'en', 'the fallback language in the markup');
  const main = await readFile('web/src/main.js', 'utf8');
  const updatesLang = /documentElement\.lang/.test(main);
  assert.ok(updatesLang, 'main.js never updates <html lang> when the catalogue language changes');
});

/* ------------------------------------------------------------------ */
/* no hard-coded UI text in the views                                  */
/* ------------------------------------------------------------------ */

test('the views never render a literal English label', async () => {
  const sources = await frontendSources();
  // element names are markup, not user-facing text
  const IGNORED = new Set(['input', 'select', 'option', 'button', 'label', 'fieldset', 'textarea', 'a', 'span']);
  const problems = [];

  for (const { file, source } of sources) {
    // el('tag', { … }) / document.createElement('tag') argument lists
    for (const match of source.matchAll(/\bel\(\s*'([\w-]+)'/g)) {
      const head = source.slice(match.index, match.index + 400);
      const literal = /\btext:\s*'([^'\\]*)'/.exec(head);
      if (literal && /[A-Za-z]{3,}/.test(literal[1])) {
        problems.push(`${file}: el('${match[1]}', { text: '${literal[1]}' }) — use t('…')`);
      }
    }

    // document.createElement(...) followed by textContent = 'literal'
    for (const match of source.matchAll(/createElement\(\s*'[\w-]+'\s*\)/g)) {
      const tail = source.slice(match.index, match.index + 300);
      const literal = /textContent:\s*'([^'\\]*)'/.exec(tail);
      if (literal && /[A-Za-z]{3,}/.test(literal[1])) {
        problems.push(`${file}: textContent: '${literal[1]}' — use t('…')`);
      }
    }

    // tag('ok', 'literal') — the level is code, the label is text
    for (const match of source.matchAll(/\btag\(\s*'(?:ok|warn|error)'\s*,\s*'([^'\\]*)'/g)) {
      if (/[A-Za-z]{3,}/.test(match[1])) problems.push(`${file}: tag(…, '${match[1]}') — use t('…')`);
    }

    // notice('error', 'literal') — the level is code, the message is text
    for (const match of source.matchAll(/\bnotice\(\s*'(?:ok|warn|error)'\s*,\s*'([^'\\]*)'/g)) {
      if (/[A-Za-z]{3,}/.test(match[1])) problems.push(`${file}: notice(…, '${match[1]}') — use t('…')`);
    }

    void IGNORED;
  }

  assert.deepEqual(problems, [], `hard-coded UI text:\n${problems.join('\n')}`);
});

test('every English string the views do put in attributes is either code or translated', async () => {
  const sources = await frontendSources();
  const problems = [];

  for (const { file, source } of sources) {
    // placeholder: 'literal' / title: 'literal' — both are shown to the user
    for (const match of source.matchAll(/\b(?:placeholder|title):\s*'([^'\\]*)'/g)) {
      const value = match[1];
      if (!/[A-Za-z]{3,}/.test(value)) continue;
      // sample values for a field the user fills in (an email, a key name) are
      // acceptable; anything that reads like prose is a missing t() call
      if (isCodeSample(value)) continue;
      problems.push(`${file}: ${match[0]} — prose must come from t('…')`);
    }
  }

  assert.deepEqual(problems, [], `untranslated attribute text:\n${problems.join('\n')}`);
});

/** True for sample values (Alex Chen, you@example.com, ssh.github.com, …). */
function isCodeSample(value) {
  if (/@/.test(value)) return true; // an email sample
  if (/^[a-z0-9_.:/@-]+$/i.test(value) && !/\s/.test(value)) return true; // host, path, key name
  if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(value)) return true; // a person's name
  return false;
}

