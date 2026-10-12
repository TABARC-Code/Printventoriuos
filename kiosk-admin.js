/**
 * Quote requests (admin side): the inbox, the catalogue you offer to customers, and the settings.
 * The customer's page is separate (kiosk.html); this is where you run it.
 *
 * Everything customers typed is untrusted text, so it only ever goes in through textContent,
 * and the reply-by-email link is built from an address that has passed the same check the
 * server applied.
 */
(function () {
  'use strict';

  const api = () => window.electron;
  const $ = (id) => document.getElementById(id);
  const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
  const STATUSES = [['new', 'New'], ['quoted', 'Quoted'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['done', 'Done']];

  let tab = 'requests';
  let built = false;
  let settingsData = null;
  let filaments = [];
  let statusFilter = '';
  let pollTimer = null;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) { if (kid !== undefined && kid !== null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    return n;
  }
  const money = (v, cur) => `${cur || ''}${Number(v || 0).toFixed(2)}`;
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return iso; } };
  const fmtDay = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return iso; } };
  function say(msg, bad) { const s = $('ka-status'); if (s) { s.textContent = msg || ''; s.classList.toggle('ka-bad', !!bad); } }
  const clean = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');

  // ---------- skeleton ----------
  function build() {
    const body = $('kiosk-admin-body');
    body.textContent = '';
    body.append(
      el('div', { class: 'ka-tabs', role: 'tablist' },
        ...[['requests', 'Requests'], ['catalogue', 'Catalogue'], ['settings', 'Settings']].map(([id, label]) => el('button', { type: 'button', role: 'tab', id: `ka-tab-${id}`, class: 'ka-tab', onclick: () => switchTab(id) }, label, id === 'requests' ? el('span', { id: 'ka-badge', class: 'ka-badge', hidden: true }) : null))),
      el('div', { id: 'ka-pane', role: 'tabpanel' }));
    built = true;
  }

  async function switchTab(next) {
    tab = next;
    ['requests', 'catalogue', 'settings'].forEach((id) => { const b = $(`ka-tab-${id}`); b.classList.toggle('active', id === tab); b.setAttribute('aria-selected', id === tab ? 'true' : 'false'); });
    say('');
    const pane = $('ka-pane');
    pane.textContent = '';
    try {
      if (tab === 'requests') await renderRequests(pane);
      else if (tab === 'catalogue') await renderCatalogue(pane);
      else await renderSettings(pane);
    } catch (e) { say(clean(e), true); }
  }

  async function refreshBadge() {
    try {
      const n = await api().getKioskRequestCount();
      const b = $('ka-badge');
      if (b) { b.textContent = String(n); b.hidden = !n; b.setAttribute('aria-label', `${n} new`); }
      const side = $('kiosk-admin-button');
      if (side) side.textContent = n ? `Quote requests (${n} new)` : 'Quote requests';
      return n;
    } catch (_) { return 0; }
  }

  // ---------- requests ----------
  async function renderRequests(pane) {
    const select = el('select', { id: 'ka-filter', 'aria-label': 'Show requests with status', onchange: (e) => { statusFilter = e.target.value; switchTab('requests'); } },
      el('option', { value: '', text: 'All requests' }), ...STATUSES.map(([v, l]) => el('option', { value: v, text: l })));
    select.value = statusFilter;
    const rows = await api().listKioskRequests(statusFilter);
    pane.append(el('div', { class: 'ka-row' }, select, el('button', { type: 'button', class: 'ka-btn ka-small', onclick: () => switchTab('requests') }, 'Refresh')));
    if (!rows.length) pane.append(el('p', { class: 'ka-hint', text: statusFilter ? 'Nothing with that status.' : 'No quote requests yet. They appear here when a customer sends one from the quote page.' }));
    rows.forEach((r) => pane.append(requestCard(r)));
    refreshBadge();
  }

  function requestCard(r) {
    const status = el('select', { 'aria-label': `Status of ${r.reference}`, onchange: async (e) => { try { await api().updateKioskRequest(r.id, e.target.value); say(`${r.reference} marked ${e.target.value}`); refreshBadge(); } catch (err) { say(clean(err), true); } } },
      ...STATUSES.map(([v, l]) => el('option', { value: v, text: l })));
    status.value = r.status;
    const price = r.price_shown ? money(r.total_price, r.currency) : `${money(r.total_price, r.currency)} (customer was not shown a price)`;
    const subject = `Your print quote ${r.reference}`;
    const bodyText = `Hello${r.customer_name ? ' ' + r.customer_name : ''},\n\nThanks for your request ${r.reference}: ${r.quantity} x ${r.item_name}.\nQuote: ${money(r.total_price, r.currency)} (valid until ${fmtDay(r.valid_until)}).\n\n`;
    const mail = EMAIL.test(r.customer_email) ? el('a', { class: 'ka-btn ka-small', href: `mailto:${r.customer_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}` }, 'Reply by email') : null;
    return el('article', { class: 'ka-card' },
      el('div', { class: 'ka-card-head' }, el('strong', { text: `${r.reference}  ${r.quantity} x ${r.item_name || 'item'}` }), el('span', { class: 'ka-muted', text: fmtDate(r.created_at) })),
      el('p', { text: `Quote ${price}. Valid until ${fmtDay(r.valid_until)}.` }),
      el('p', { class: 'ka-muted', text: `Your cost ${money(r.internal_cost, r.currency)}, profit ${money(r.internal_profit, r.currency)} (not shown to the customer).` }),
      el('p', {}, el('strong', { text: 'From: ' }), `${r.customer_email}${r.customer_name ? ` (${r.customer_name})` : ''}`),
      r.message ? el('p', { class: 'ka-msg', text: r.message }) : null,
      r.notify_status === 'failed' ? el('p', { class: 'ka-bad', text: 'The webhook message for this request failed to send.' }) : null,
      el('div', { class: 'ka-row' }, status, mail, el('button', { type: 'button', class: 'ka-btn ka-small ka-danger', onclick: async (e) => {
        if (!window.confirm(`Delete request ${r.reference} and the customer's email address? This cannot be undone.`)) return;
        try { await api().deleteKioskRequest(r.id); e.target.closest('article').remove(); refreshBadge(); say('Deleted'); } catch (err) { say(clean(err), true); }
      } }, 'Delete')));
  }

  // ---------- catalogue ----------
  async function renderCatalogue(pane) {
    filaments = (await api().getAllFilaments()) || [];
    const items = await api().listKioskItems();
    const list = el('div', { id: 'ka-items' });
    pane.append(el('p', { class: 'ka-hint', text: 'Only items listed here are shown to customers, and only with the print time and weight you enter. Check you are allowed to sell prints of each model (the licence is shown).' }),
      el('button', { type: 'button', class: 'ka-btn', onclick: () => addForm(pane) }, 'Offer another model'), list);
    if (!items.length) list.append(el('p', { class: 'ka-hint', text: 'Nothing offered yet.' }));
    items.forEach((it) => list.append(itemCard(it, pane)));
  }

  function itemCard(it, pane) {
    return el('article', { class: 'ka-card' },
      el('div', { class: 'ka-card-head' }, el('strong', { text: it.title || it.fileName.replace(/\.[a-z0-9]{2,5}$/i, '') }), el('span', { class: it.enabled ? 'ka-pill' : 'ka-pill ka-off', text: it.enabled ? 'Offered' : 'Hidden' })),
      el('p', { class: 'ka-muted', text: `${it.print_hours} h, ${it.grams} g, ${it.units_per_plate} per plate. Licence: ${it.license || 'not recorded'}.${it.designer && it.designer !== 'Unknown' ? ` Designer: ${it.designer}.` : ''}` }),
      el('div', { class: 'ka-row' },
        el('button', { type: 'button', class: 'ka-btn ka-small', onclick: () => addForm(pane, it) }, 'Edit'),
        el('button', { type: 'button', class: 'ka-btn ka-small ka-danger', onclick: async () => { if (!window.confirm('Stop offering this model to customers?')) return; await api().removeKioskItem(it.model_id); switchTab('catalogue'); } }, 'Remove')));
  }

  function field(label, input, hint) {
    return el('label', { class: 'ka-field' }, el('span', { class: 'ka-label', text: label }), input, hint ? el('span', { class: 'ka-hint', text: hint }) : null);
  }
  const num = (v) => el('input', { type: 'number', step: 'any', min: '0', value: v === undefined || v === null ? '' : String(v) });

  function addForm(pane, existing) {
    pane.querySelector('#ka-form')?.remove();
    const form = el('form', { id: 'ka-form', class: 'ka-card ka-form', onsubmit: (e) => e.preventDefault() });
    let modelId = existing ? existing.model_id : null;
    const modelLabel = el('p', { class: 'ka-muted', id: 'ka-model', text: existing ? existing.fileName : 'No model chosen yet.' });
    const search = el('input', { type: 'search', placeholder: 'Search your library by file name', 'aria-label': 'Search your library' });
    const results = el('div', { class: 'ka-results' });
    let t = null;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
      results.textContent = '';
      if (search.value.trim().length < 2) return;
      const rows = await api().searchKioskModels(search.value.trim());
      rows.forEach((m) => results.append(el('button', { type: 'button', class: 'ka-result', onclick: () => { modelId = m.id; modelLabel.textContent = `${m.fileName}${m.license ? ` (licence: ${m.license})` : ' (licence not recorded)'}`; results.textContent = ''; } }, m.fileName)));
      if (!rows.length) results.append(el('p', { class: 'ka-hint', text: 'No models match.' }));
    }, 250); });
    const title = el('input', { type: 'text', maxlength: '120', value: existing && existing.title || '', placeholder: 'Optional: a friendlier name for customers' });
    const hours = num(existing && existing.print_hours); const grams = num(existing && existing.grams);
    const per = el('input', { type: 'number', min: '1', max: '500', step: '1', value: String(existing ? existing.units_per_plate : 1) });
    const filament = el('select', {}, el('option', { value: '', text: 'Average of my priced filaments' }), ...filaments.map((f) => el('option', { value: String(f.id), text: [f.vendor, f.name, f.material].filter(Boolean).join(' ') })));
    filament.value = existing && existing.filament_id != null ? String(existing.filament_id) : '';
    const note = el('input', { type: 'text', maxlength: '300', value: existing && existing.note || '', placeholder: 'Optional: shown under the name, e.g. "Hand painted"' });
    const on = el('input', { type: 'checkbox' }); on.checked = existing ? !!existing.enabled : true;
    const preview = el('p', { class: 'ka-preview', role: 'status' });
    const read = () => ({ modelId, title: title.value, printHours: hours.value, grams: grams.value, unitsPerPlate: per.value, filamentId: filament.value, note: note.value, enabled: on.checked });
    const updatePreview = async () => {
      const r = read();
      if (!(Number(r.printHours) > 0 && Number(r.grams) > 0)) { preview.textContent = ''; return; }
      try {
        const q = await api().previewKioskQuote({ ...r, quantity: 1 });
        preview.textContent = q.ok ? `A customer asking for 1 would be quoted ${money(q.total, q.currency)}. Your cost ${money(q.internal.cost, q.currency)}, profit ${money(q.internal.profit, q.currency)}.` : q.error;
      } catch (e) { preview.textContent = clean(e); }
    };
    [hours, grams, per, filament].forEach((i) => i.addEventListener('input', updatePreview));
    filament.addEventListener('change', updatePreview);
    form.append(
      el('h4', { text: existing ? 'Edit offered model' : 'Offer a model to customers' }),
      existing ? null : field('Find the model', search), results, modelLabel,
      field('Name shown to customers', title),
      el('div', { class: 'ka-two' }, field('Print time per plate (hours)', hours, 'From your slicer'), field('Filament per plate (grams)', grams)),
      el('div', { class: 'ka-two' }, field('Items per plate', per), field('Filament', filament)),
      field('Short note', note),
      el('label', { class: 'ka-check' }, on, ' Show this to customers'),
      preview,
      el('div', { class: 'ka-row' },
        el('button', { type: 'button', class: 'ka-btn', onclick: async () => { try { await api().saveKioskItem(read()); switchTab('catalogue'); say('Saved'); } catch (e) { say(clean(e), true); } } }, 'Save'),
        el('button', { type: 'button', class: 'ka-btn ka-secondary', onclick: () => form.remove() }, 'Cancel')));
    pane.prepend(form);
    updatePreview();
    form.scrollIntoView({ block: 'nearest' });
  }

  // ---------- settings ----------
  async function renderSettings(pane) {
    const r = await api().getKioskSettings();
    settingsData = r.settings;
    const s = r.settings;
    const warnings = [];
    if (s.enabled && !r.ready.ok) r.ready.problems.forEach((p) => warnings.push(p));
    if (s.enabled && !r.status.serverMode) warnings.push('You are running the desktop app. The quote page is only reachable from this computer. For a customer screen, run Server Mode and open the quote page from the kiosk device.');
    if (s.enabled && r.status.serverMode && !r.status.tokenSet) warnings.push('The quote page is on, but this server has no access token, so anyone who can reach it can also open the admin interface. Set PRINTVENTORY_ACCESS_TOKEN (see the Server Mode section of the README) before putting a screen in front of customers.');
    if (warnings.length) pane.append(el('ul', { class: 'ka-warn' }, warnings.map((w) => el('li', { text: w }))));

    const check = (key, label, note) => { const i = el('input', { type: 'checkbox', id: `ka-${key}` }); i.checked = !!s[key]; return { input: i, node: el('label', { class: 'ka-switch', for: `ka-${key}` }, i, el('span', {}, el('strong', { text: label }), note ? el('small', { text: note }) : null)) }; };
    const text = (key, label, hint, area) => { const i = el(area ? 'textarea' : 'input', area ? { rows: '2', maxlength: '400' } : { type: 'text', maxlength: '400' }); i.value = s[key] || ''; return { input: i, node: field(label, i, hint) }; };
    const number = (key, label, hint, min, max) => { const i = el('input', { type: 'number', min: String(min), max: String(max), step: key === 'minimumCharge' ? '0.5' : '1' }); i.value = String(s[key]); return { input: i, node: field(label, i, hint) }; };
    const enabled = check('enabled', 'Turn the quote page on', 'Customers can open /kiosk on this server. Off means every address under it answers "not available".');
    const showPrice = check('showPrice', 'Show customers the price', 'Off: they are told you will email a quote, and the price goes only to you.');
    const fields = {
      title: text('title', 'Page title'), intro: text('intro', 'Welcome text', '', true), privacy: text('privacy', 'Privacy line shown beside the email box', 'Say what you do with the address.', true),
      validityDays: number('validityDays', 'Quote valid for (days)', '', 1, 90), minimumCharge: number('minimumCharge', 'Minimum charge', 'Quotes are never lower than this.', 0, 10000),
      idleSeconds: number('idleSeconds', 'Clear the screen after (seconds without touching it)', 'So the next customer doesn’t see the last one’s details.', 20, 1800),
      retentionDays: number('retentionDays', 'Delete requests after (days)', 'Requests, with the customer’s email address, are deleted automatically after this long.', 1, 3650),
      webhookUrl: text('webhookUrl', 'Webhook address (optional)', 'We post new requests here as JSON. A Discord or Slack webhook URL works as it is. https only.')
    };
    const testBtn = el('button', { type: 'button', class: 'ka-btn ka-small', onclick: async () => { await save(); const t = await api().testKioskWebhook(); say(t.ok ? 'Test message sent' : `Test failed: ${t.error || t.status}`, !t.ok); } }, 'Send a test message');
    async function save() {
      const patch = { enabled: enabled.input.checked, showPrice: showPrice.input.checked };
      for (const [k, f] of Object.entries(fields)) patch[k] = ['validityDays', 'minimumCharge', 'idleSeconds', 'retentionDays'].includes(k) ? Number(f.input.value) : f.input.value;
      settingsData = await api().saveKioskSettings(patch);
      say('Saved');
      return settingsData;
    }
    const address = `${location.origin.startsWith('http') ? location.origin : 'http://this-server:5000'}/kiosk`;
    pane.append(
      enabled.node, showPrice.node,
      el('p', { class: 'ka-hint' }, 'Customer page address: ', el('code', { text: address })),
      fields.title.node, fields.intro.node, fields.privacy.node,
      el('div', { class: 'ka-two' }, fields.validityDays.node, fields.minimumCharge.node),
      el('div', { class: 'ka-two' }, fields.idleSeconds.node, fields.retentionDays.node),
      fields.webhookUrl.node, testBtn,
      el('p', { class: 'ka-hint', text: 'Prices come from the Farm Cost Calculator, using the average of your printers in service. Nothing is stored on the customer’s device. What you keep (the email address and the quote) lives only in this library.' }),
      el('div', { class: 'ka-row' }, el('button', { type: 'button', class: 'ka-btn', onclick: async () => { try { await save(); setupSideButton(); await switchTab('settings'); say('Saved'); } catch (e) { say(clean(e), true); } } }, 'Save settings')));
  }

  // ---------- open, close, badge ----------
  async function open() {
    const dialog = $('kiosk-admin-dialog');
    if (!dialog) return;
    if (!built) build();
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    await switchTab(tab);
    refreshBadge();
  }

  /** A shortcut under the library buttons, only once the quote page is on. */
  async function setupSideButton() {
    try {
      const r = await api().getKioskSettings();
      let btn = $('kiosk-admin-button');
      if (!r.settings.enabled) { btn?.remove(); clearInterval(pollTimer); pollTimer = null; return; }
      if (!btn) {
        const anchor = $('view-library-button');
        if (!anchor) return;
        btn = el('button', { type: 'button', id: 'kiosk-admin-button', class: 'secondary-button', onclick: open }, 'Quote requests');
        anchor.insertAdjacentElement('afterend', btn);
      }
      refreshBadge();
      if (!pollTimer) pollTimer = setInterval(refreshBadge, 60000);
    } catch (_) { /* admin API not ready yet */ }
  }

  function init() {
    window._electronRealEventHandlers = window._electronRealEventHandlers || {};
    window._electronRealEventHandlers['open-kiosk-admin'] = () => open();
    if (window._electronPendingEvents?.['open-kiosk-admin']) {
      window._electronPendingEvents['open-kiosk-admin'].forEach((args) => window._electronRealEventHandlers['open-kiosk-admin'].apply(null, args));
      delete window._electronPendingEvents['open-kiosk-admin'];
    }
    window.openKioskAdmin = open;
    $('kiosk-admin-close')?.addEventListener('click', () => $('kiosk-admin-dialog')?.close());
    try { window.electron?.onKioskRequestsChanged?.(() => refreshBadge()); } catch (_) { /* older bridge */ }
    setTimeout(setupSideButton, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
