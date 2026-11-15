import { el, clear, tag, asArray } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';

export async function renderOverview(container, app) {
  clear(container);
  const state = (await api.state()) ?? {};
  app.state = state;

  // A degraded or partial response must render its empty state, never throw: an
  // exception here leaves the whole overview blank.
  const identities = asArray(state.identities);
  const rules = asArray(state.rules);
  const repositories = asArray(state.repositories);

  container.append(el('h2', { text: t('web.tab.overview') }));

  const counts = el('div', { class: 'card' }, [
    el('div', {
      class: 'muted',
      text: t('web.counts', identities.length, rules.length, repositories.length),
    }),
    el('div', { class: 'mono muted', text: state.profilePath ?? '' }),
  ]);
  container.append(counts);

  const grid = el('div', { class: 'grid' });
  for (const identity of identities) {
    const record = identity ?? {};
    const sites = asArray(record.sites)
      .map((s) => (s?.port ? `${s.host}:${s.port}` : s?.host))
      .filter(Boolean)
      .join(', ');
    grid.append(
      el('div', { class: 'card' }, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, [
          el('strong', { text: record.name ?? '' }),
          record.sshKey ? tag('ok', record.sshKey) : tag('warn', t('web.noKey')),
        ]),
        el('div', { class: 'mono muted', text: `${record.userName ?? ''} <${record.email ?? ''}>` }),
        el('div', { class: 'mono muted', text: sites || t('web.noSites') }),
        el('button', {
          class: 'primary',
          style: 'margin-top:12px',
          text: t('web.viewDiff'),
          onclick: () => app.goto('preview'),
        }),
      ]),
    );
  }
  container.append(grid);

  container.append(
    el('h3', { text: t('web.nextStep') }),
    el('div', { class: 'card banner' }, [
      el('div', {}, [
        el('div', { text: t('web.nextStepBody') }),
        el('div', { class: 'muted', text: t('web.nextStepHint') }),
      ]),
      el('button', { class: 'primary', text: t('web.openPreview'), onclick: () => app.goto('preview') }),
    ]),
  );

  // Every directory without a rule uses this identity; without saying so, a
  // personal repo committing with a work address is invisible here.
  container.append(
    el('h3', { text: t('web.globalIdentity') }),
    el('div', { class: 'card' }, [
      el('div', {
        class: state.globalIdentity ? 'mono' : 'mono muted',
        text: state.globalIdentity ?? t('web.globalUnset'),
      }),
      el('div', { class: 'muted', text: t('web.globalIdentityHint') }),
    ]),
    globalIdentityForm(container, app, state),
  );
}

/** Edit ~/.gitconfig's user identity directly: it lives outside the gs block. */
function globalIdentityForm(container, app, state) {
  const card = el('div', { class: 'card' });
  const error = el('div', { class: 'form-error', text: '' });

  // prefill from the current value: "name <email>" or a bare value
  const current = state.globalIdentity ?? '';
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(current);
  const currentName = match ? (match[1] ?? '').trim() : current.trim();
  const currentEmail = match ? (match[2] ?? '').trim() : '';

  const nameInput = el('input', {
    type: 'text',
    class: 'input',
    value: currentName,
    placeholder: 'Alex Chen',
  });
  const emailInput = el('input', {
    type: 'text',
    class: 'input',
    value: currentEmail,
    placeholder: 'you@example.com',
  });

  const save = el('button', {
    class: 'primary',
    text: t('web.save'),
    onclick: async () => {
      error.textContent = '';
      try {
        const result = await api.setGlobalIdentity({
          name: nameInput.value.trim(),
          email: emailInput.value.trim(),
        });
        app.toast(t('web.globalIdentitySaved', result.after));
        if (result.before) app.toast(t('web.globalIdentityWas', result.before));
        await renderOverview(container, app);
      } catch (err) {
        error.textContent = err.message;
      }
    },
  });

  card.append(
    el('fieldset', { class: 'field-group' }, [
      el('legend', { text: t('web.globalIdentityTitle') }),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label' }, [
          t('web.field.userName'),
          el('span', { class: 'req', text: ' *' }),
        ]),
        nameInput,
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label' }, [
          t('web.field.email'),
          el('span', { class: 'req', text: ' *' }),
        ]),
        emailInput,
      ]),
    ]),
    el('div', { class: 'muted', text: t('web.globalIdentityFormHint') }),
    el('div', { class: 'form-actions' }, [save]),
    error,
  );
  return card;
}
