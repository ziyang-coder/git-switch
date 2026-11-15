import { api, hasToken } from './api.js';
import { el } from './dom.js';
import { setMessages, applyStaticTranslations, t, getLanguage } from './i18n.js';
import { renderOverview } from './views/overview.js';
import { renderIdentities } from './views/identities.js';
import { renderRules } from './views/rules.js';
import { renderPreview } from './views/preview.js';
import { renderDoctor } from './views/doctor.js';
import { renderKeys } from './views/keys.js';
import { renderSnapshot } from './views/snapshot.js';
import { renderInit } from './views/init.js';

const VIEWS = {
  overview: renderOverview,
  identities: renderIdentities,
  rules: renderRules,
  keys: renderKeys,
  snapshot: renderSnapshot,
  preview: renderPreview,
  doctor: renderDoctor,
  init: renderInit,
};

const LANGUAGES = ['en', 'zh-CN'];

/**
 * Show a broken profile as a banner above every screen.
 *
 * One invalid field (say a site host pasted as a URL) used to make /api/state
 * fail, which left every tab blank with no explanation. The API now degrades to
 * empty data plus `profileError`, and this banner is what the user sees.
 */
function renderProfileError(state) {
  const slot = document.getElementById('profile-error');
  if (!slot) return;
  slot.replaceChildren();
  if (!state?.profileError) return;

  slot.append(
    Object.assign(document.createElement('div'), {
      className: 'notice error',
      textContent: t('web.profileError', state.profileError),
    }),
  );

  const hint = Object.assign(document.createElement('div'), {
    className: 'notice warn',
    textContent: t('web.profileErrorHint', state.profilePath ?? '~/.config/gs/profiles.yaml'),
  });
  slot.append(hint);

  const actions = Object.assign(document.createElement('div'), { className: 'form-actions' });

  // The common failure is a URL pasted into a host field; offer to fix it
  // rather than telling the user to edit YAML they came here to avoid.
  const fix = Object.assign(document.createElement('button'), {
    textContent: t('web.tryFix'),
    className: 'primary',
  });
  fix.addEventListener('click', async () => {
    fix.disabled = true;
    try {
      const preview = await api.repair(false);
      if (preview.ok) {
        window.location.reload();
        return;
      }
      if (!preview.suggestion || preview.suggestion.fixable !== true) {
        slot.append(
          Object.assign(document.createElement('div'), {
            className: 'notice warn',
            textContent: t('web.cannotFix'),
          }),
        );
        return;
      }

      const before = preview.suggestion.problem;
      const after = preview.suggestion.fixed;
      if (!confirm(t('web.confirmFix', before, after))) {
        fix.disabled = false;
        return;
      }

      const done = await api.repair(true);
      if (done.ok) {
        window.location.reload();
      } else {
        slot.append(
          Object.assign(document.createElement('div'), {
            className: 'notice error',
            textContent: done.error ?? t('web.cannotFix'),
          }),
        );
      }
    } catch (err) {
      slot.append(
        Object.assign(document.createElement('div'), {
          className: 'notice error',
          textContent: err.message,
        }),
      );
    }
  });
  actions.append(fix);

  const reload = Object.assign(document.createElement('button'), {
    textContent: t('web.reload'),
  });
  reload.addEventListener('click', () => window.location.reload());
  actions.append(reload);

  // a copyable path is faster than describing where the file lives
  const reveal = Object.assign(document.createElement('button'), {
    textContent: t('web.showFile'),
  });
  reveal.addEventListener('click', () => {
    slot.append(
      Object.assign(document.createElement('div'), {
        className: 'notice ok',
        textContent: state.profilePath ?? '~/.config/gs/profiles.yaml',
      }),
    );
  });
  actions.append(reveal);

  slot.append(actions);
}

/** True only for plain http(s) URLs — anything else is shown as inert text. */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fill the "about" menu with the running build.
 *
 * The CLI answers this with `gs version`; the browser needs the same report, but
 * a string like `0.1.0+29.g4f3a3bf.dirty` is far too wide to sit in the header,
 * so it lives behind a menu alongside the author and licence.
 */
async function renderVersion() {
  const trigger = document.getElementById('about-trigger');
  const panel = document.getElementById('about-panel');
  if (!trigger || !panel) return;

  let info;
  try {
    info = await api.version();
  } catch {
    trigger.hidden = true; // a missing version must never break the app
    return;
  }

  const channel = info.channel === 'release' ? t('web.channelRelease') : t('web.channelDev');
  trigger.setAttribute('title', `${info.version} · ${channel}`);

  const line = (label, value, as) => {
    if (value === null || value === undefined || value === '') return null;

    // Only ever link to a real web address. The value comes from package.json,
    // but a `javascript:` or `file:` url there must never become clickable.
    let rendered;
    if (as === 'link' && isHttpUrl(String(value))) {
      rendered = el('a', {
        class: 'kv-value mono',
        href: String(value),
        target: '_blank',
        // noreferrer also strips the Referer, so the local port/token in the URL
        // never leaks to an external site
        rel: 'noopener noreferrer',
        title: String(value),
        text: String(value),
      });
    } else {
      rendered = el('span', { class: 'kv-value mono', text: String(value) });
    }

    return el('div', { class: 'kv' }, [el('span', { class: 'kv-label', text: label }), rendered]);
  };

  panel.replaceChildren(
    line(t('web.version'), info.version),
    line(t('version.channel'), channel),
    line(t('version.author'), info.author),
    line(t('version.license'), info.license),
    line(t('version.repository'), info.repository, 'link'),
    line(t('version.commit'), info.commit),
    line(t('version.builtAt'), info.builtAt),
    info.dirty ? el('div', { class: 'notice warn', text: t('version.dirty') }) : null,
    el('div', { class: 'muted', text: t('web.aboutHint') }),
  );

  if (!trigger.dataset.bound) {
    trigger.dataset.bound = '1';
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = panel.hasAttribute('hidden');
      panel.toggleAttribute('hidden', !open);
      trigger.setAttribute('aria-expanded', String(open));
    });
    // clicking anywhere else, or pressing Escape, closes the menu
    document.addEventListener('click', () => {
      panel.setAttribute('hidden', '');
      trigger.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        panel.setAttribute('hidden', '');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
  }
}
/** Re-label the tab bar and the language picker in the active language. */
function translateChrome() {
  applyStaticTranslations(document);
  for (const tab of document.querySelectorAll('.tab')) {
    const view = tab.dataset.view;
    if (view) tab.textContent = t(`web.tab.${view}`);
  }
  document.title = t('web.title');
  // Declare the language the page is actually written in, so screen readers
  // pronounce it correctly and the browser offers to translate the right way.
  const language = getLanguage();
  document.documentElement.lang = language;
  document.documentElement.setAttribute('lang', language);
  const select = document.getElementById('language');
  if (select) {
    select.value = language;
    select.setAttribute('aria-label', t('web.language'));
  }
  renderHomeBanner(app.state);
  renderProfileError(app.state);
}

/**
 * State which home this instance operates on.
 *
 * A GUI started with --home looks identical to the real one. Without this banner
 * a user can spend an hour configuring an identity in a sandbox and wonder why
 * their real ~/.ssh never changed.
 */
function renderHomeBanner(state) {
  const slot = document.getElementById('home-banner');
  if (!slot) return;
  slot.replaceChildren();
  if (!state) return;

  const sandbox = state.isSandbox === true;
  const banner = Object.assign(document.createElement('div'), {
    className: `notice ${sandbox ? 'error' : 'ok'}`,
    textContent: sandbox
      ? t('web.sandboxBanner', state.homePath ?? state.home)
      : t('web.realHomeBanner', state.homePath ?? state.home),
  });
  const dismiss = Object.assign(document.createElement('button'), {
    textContent: t('web.dismiss'),
    className: 'dismiss',
  });
  dismiss.addEventListener('click', () => slot.replaceChildren());
  banner.append(dismiss);
  slot.append(banner);
}

const app = {
  state: undefined,
  current: 'overview',

  /** Pull state (and with it the catalogue) for the active language. */
  async refreshState(lang) {
    const state = await api.state(undefined, lang ?? getLanguage());
    setMessages(state.messages, state.language);
    this.state = state;
    translateChrome();
    return state;
  },

  async goto(view) {
    this.current = view;
    for (const tab of document.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === view));
    }
    const main = document.getElementById('main');
    // the banner lives outside the view container so switching tabs keeps it
    const banner = document.getElementById('home-banner');
    const errorSlot = document.getElementById('profile-error');
    main.replaceChildren();
    if (banner) main.append(banner);
    if (errorSlot) main.append(errorSlot);
    const host = Object.assign(document.createElement('div'), { className: 'view' });
    main.append(host);
    try {
      await VIEWS[view](host, this);
    } catch (err) {
      host.replaceChildren(
        Object.assign(document.createElement('div'), {
          className: 'notice error',
          textContent: err.message,
        }),
      );
    }
  },

  toast(message, level = 'ok') {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${level}`;
    clearTimeout(app._toastTimer);
    app._toastTimer = setTimeout(() => {
      status.textContent = '';
      status.className = 'status';
    }, 6000);
  },
};

async function boot() {
  if (!hasToken()) {
    document.getElementById('main').replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'notice error',
        textContent: t('web.missingToken'),
      }),
    );
    return;
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => app.goto(tab.dataset.view));
  }

  // language picker: switching re-fetches the catalogue and re-renders in place
  const language = document.getElementById('language');
  if (language) {
    for (const code of LANGUAGES) {
      language.append(
        Object.assign(document.createElement('option'), { value: code, textContent: code }),
      );
    }
    language.addEventListener('change', async () => {
      try {
        const state = await app.refreshState(language.value);
        await app.goto(app.current);
        // the counts are dynamic text, so they are not re-translated by the
        // chrome pass: rewrite them in the language now selected
        document.getElementById('status').textContent = t(
          'web.counts',
          (state.identities ?? []).length,
          (state.rules ?? []).length,
          (state.repositories ?? []).length,
        );
        // the tag's tooltip and expanded panel follow the new language
        await renderVersion();
      } catch (err) {
        app.toast(err.message, 'error');
      }
    });
  }

  // show something while the first request is in flight; it is replaced below
  const status = document.getElementById('status');
  status.textContent = t('web.loading');

  // the build tag is independent of the profile, so it loads in parallel
  const versionPromise = renderVersion();

  try {
    const state = await app.refreshState();
    // render first: goto() re-translates the chrome, and the status text is
    // written afterwards so nothing can overwrite it
    await app.goto('overview');
    status.textContent = t(
      'web.counts',
      state.identities.length,
      state.rules.length,
      state.repositories.length,
    );
  } catch (err) {
    await app.goto('overview');
    status.textContent = err.message;
    status.className = 'status error';
  }

  await versionPromise;
}

boot();
