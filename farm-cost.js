/**
 * Print Farm Cost Calculator (UI).
 *
 * The sums live in farm-cost-lib.js and are tested there. This file is the
 * screen: it reads your printers and filaments from Printventory, keeps the cost
 * assumptions in the settings table, and redraws the quote on every keystroke.
 *
 * Everything user-supplied (printer names, filament names) goes in via
 * textContent, never innerHTML. Printer nicknames are free text and I don't
 * fancy debugging an XSS in a cost calculator.
 *
 * Wishlist, in rough order: remember quotes per model; pull grams and print time
 * out of the 3MF metadata automatically; time-of-use electricity. Each of those
 * is a small job on its own and none of them is today's job.
 */
(function () {
  'use strict';

  const FC = window.FarmCost;
  const CONFIG_KEY = 'farmCostConfig';
  const JOB_KEY = 'farmCostLastJob';
  const MAX_FILAMENT_LINES = 8;

  let cfg = FC ? FC.normaliseConfig({}) : null;
  let configSaved = false;      // false until the user has stored a config at least once
  let job = defaultJob();
  let printers = [];
  let filaments = [];
  let outcomeStats = [];
  let built = false;
  let saveTimer = null;
  let tab = 'quote';
  let batchSelection = null;    // Set of printer ids ticked in the batch planner; null = all active

  function defaultJob() {
    return {
      name: '', printerId: 'average', hours: '', minutes: '', plates: 1, unitsPerPlate: 1,
      filaments: [{ filamentId: '', costPerKg: '', grams: '' }],
      setupMinutes: 5, postMinutesPerUnit: 0, packagingPerUnit: '', extrasPerUnit: '',
      failureRatePct: '', mode: 'margin', value: ''
    };
  }

  // ---------- tiny DOM helpers ----------
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === undefined || kid === null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  const $ = (id) => document.getElementById(id);
  const money = (v) => FC.formatMoney(v, cfg.currency);
  const pct = (v, d = 1) => `${(Number.isFinite(v) ? v : 0).toFixed(d)}%`;
  const hoursText = (h) => {
    if (!Number.isFinite(h) || h <= 0) return '0 min';
    const whole = Math.floor(h);
    const mins = Math.round((h - whole) * 60);
    if (mins === 60) return `${whole + 1} h`;
    return whole ? `${whole} h ${mins} min` : `${mins} min`;
  };
  const printerLabel = (p) => p.nickname || [p.manufacturer, p.model].filter(Boolean).join(' ') || `Printer ${p.id}`;
  const filamentLabel = (f) => [f.vendor, f.name, f.material].filter(Boolean).join(' · ') || `Filament ${f.id}`;

  function field(label, input, hint) {
    return el('label', { class: 'fc-field' }, el('span', { class: 'fc-label', text: label }), input, hint ? el('span', { class: 'fc-hint', text: hint }) : null);
  }
  function numInput(value, onInput, attrs) {
    const i = el('input', Object.assign({ type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: value === undefined || value === null ? '' : String(value) }, attrs));
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }

  // ---------- persistence ----------
  async function loadStored() {
    try {
      const raw = await window.electron.getSetting(CONFIG_KEY);
      if (raw) { cfg = FC.normaliseConfig(JSON.parse(raw)); configSaved = true; }
    } catch (_) { /* corrupt JSON or no setting: start from defaults */ }
    try {
      const raw = await window.electron.getSetting(JOB_KEY);
      if (raw) job = Object.assign(defaultJob(), JSON.parse(raw));
      if (!Array.isArray(job.filaments) || !job.filaments.length) job.filaments = defaultJob().filaments;
    } catch (_) { job = defaultJob(); }
  }

  function setStatus(text, isError) {
    const s = $('farm-cost-status');
    if (!s) return;
    s.textContent = text || '';
    s.classList.toggle('fc-error', !!isError);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    setStatus('Saving...');
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await window.electron.saveSetting(CONFIG_KEY, JSON.stringify(cfg));
        await window.electron.saveSetting(JOB_KEY, JSON.stringify(job));
        configSaved = true;
        setStatus('Saved');
      } catch (e) {
        setStatus(`Could not save: ${e?.message || e}`, true);
      }
    }, 500);
  }

  // ---------- data from Printventory ----------
  async function loadLibraryData() {
    try { printers = (await window.electron.getAllPrinters()) || []; } catch (_) { printers = []; }
    try { filaments = (await window.electron.getAllFilaments()) || []; } catch (_) { filaments = []; }
    try { outcomeStats = (await window.electron.getPrintOutcomeStats()) || []; } catch (_) { outcomeStats = []; }
    for (const p of printers) {
      const id = String(p.id);
      cfg.printers[id] = FC.normalisePrinter(cfg.printers[id] || {});
    }
    for (const f of filaments) {
      const id = String(f.id);
      cfg.filaments[id] = FC.normaliseFilament(cfg.filaments[id] || {});
    }
  }

  // ---------- turning the form into a lib job ----------
  function libJob() {
    const hours = FC.num(job.hours, 0, { min: 0 }) + FC.num(job.minutes, 0, { min: 0 }) / 60;
    return {
      printerId: job.printerId === 'average' ? undefined : job.printerId,
      printHours: hours,
      plates: job.plates, unitsPerPlate: job.unitsPerPlate,
      filaments: job.filaments.map((l) => (
        l.filamentId && l.filamentId !== 'custom'
          ? { grams: l.grams, filamentId: l.filamentId }
          : { grams: l.grams, costPerGram: FC.num(l.costPerKg, 0, { min: 0 }) / 1000 }
      )),
      setupMinutes: job.setupMinutes, postMinutesPerUnit: job.postMinutesPerUnit,
      packagingPerUnit: job.packagingPerUnit === '' ? undefined : job.packagingPerUnit,
      extrasPerUnit: job.extrasPerUnit,
      failureRatePct: job.failureRatePct === '' ? undefined : job.failureRatePct,
      pricing: { mode: job.mode, value: job.value === '' ? undefined : FC.num(job.value, 0) }
    };
  }

  function historyRate(printerId) {
    return FC.failureRateFromStats(outcomeStats, printerId === 'average' ? undefined : printerId);
  }

  // ---------- skeleton ----------
  function buildUi() {
    const body = $('farm-cost-body');
    body.textContent = '';
    body.append(
      el('div', { class: 'fc-tabs', role: 'tablist' },
        el('button', { type: 'button', role: 'tab', id: 'fc-tab-quote', class: 'fc-tab', onclick: () => switchTab('quote') }, 'Quote'),
        el('button', { type: 'button', role: 'tab', id: 'fc-tab-farm', class: 'fc-tab', onclick: () => switchTab('farm') }, 'Farm setup')),
      el('div', { id: 'fc-pane-quote', class: 'fc-pane', role: 'tabpanel' }),
      el('div', { id: 'fc-pane-farm', class: 'fc-pane', role: 'tabpanel' }));
    built = true;
  }

  function switchTab(next) {
    tab = next;
    $('fc-pane-quote').hidden = tab !== 'quote';
    $('fc-pane-farm').hidden = tab !== 'farm';
    for (const [id, name] of [['fc-tab-quote', 'quote'], ['fc-tab-farm', 'farm']]) {
      const b = $(id);
      b.classList.toggle('active', tab === name);
      b.setAttribute('aria-selected', tab === name ? 'true' : 'false');
    }
    if (tab === 'farm') renderFarm();
    else renderQuote();
  }

  // ---------- QUOTE TAB ----------
  function renderQuote() {
    const pane = $('fc-pane-quote');
    pane.textContent = '';

    const printerSelect = el('select', { id: 'fc-printer', onchange: (e) => { job.printerId = e.target.value; persist(); } },
      el('option', { value: 'average', text: printers.length ? 'Farm average (any printer)' : 'Farm average (add printers in Printer Manager)' }),
      printers.map((p) => el('option', { value: String(p.id), text: printerLabel(p) })));
    printerSelect.value = job.printerId;

    const filamentLines = el('div', { class: 'fc-filament-lines' });
    job.filaments.forEach((line, idx) => filamentLines.append(filamentRow(line, idx)));

    const modeSelect = el('select', { id: 'fc-mode', onchange: (e) => { job.mode = e.target.value; job.value = ''; renderQuote(); persist(); } },
      el('option', { value: 'margin', text: 'Target margin %' }),
      el('option', { value: 'markup', text: 'Markup on cost %' }),
      el('option', { value: 'price', text: 'My price per unit' }));
    modeSelect.value = job.mode;
    const modeDefault = job.mode === 'margin' ? cfg.targetMarginPct : job.mode === 'markup' ? cfg.markupPct : '';

    const hist = historyRate(job.printerId);
    const failHint = hist.ratePct === null
      ? `Default ${pct(cfg.failureRatePct, 0)}. Your history has ${hist.total} logged prints, too few to use.`
      : `Default ${pct(cfg.failureRatePct, 0)}. Your logged prints say ${pct(hist.ratePct)} (${hist.failed} of ${hist.total}).`;

    const inputs = el('div', { class: 'fc-col fc-inputs' },
      el('h4', { text: 'The job' }),
      field('Name (for the copied quote)', el('input', { type: 'text', value: job.name, maxlength: '80', placeholder: 'e.g. Dragon bust x10', oninput: (e) => { job.name = e.target.value; persist(); } })),
      field('Printer', printerSelect),
      el('div', { class: 'fc-row' },
        field('Print time (h)', numInput(job.hours, (v) => { job.hours = v; persist(); }, { min: '0', step: '1', placeholder: '0' }), 'Per plate, from your slicer'),
        field('(min)', numInput(job.minutes, (v) => { job.minutes = v; persist(); }, { min: '0', step: '1', placeholder: '0' }))),
      el('div', { class: 'fc-row' },
        field('Plates', numInput(job.plates, (v) => { job.plates = v; persist(); }, { min: '1', step: '1' }), 'How many plates to print'),
        field('Items per plate', numInput(job.unitsPerPlate, (v) => { job.unitsPerPlate = v; persist(); }, { min: '1', step: '1' }))),
      el('h4', { text: 'Filament per plate' }),
      filamentLines,
      el('button', { type: 'button', class: 'fc-link-btn', id: 'fc-add-filament', onclick: addFilamentLine, disabled: job.filaments.length >= MAX_FILAMENT_LINES }, '+ Add another filament'),
      el('h4', { text: 'Time and extras' }),
      el('div', { class: 'fc-row' },
        field('Setup (min per plate)', numInput(job.setupMinutes, (v) => { job.setupMinutes = v; persist(); })),
        field('Finishing (min per item)', numInput(job.postMinutesPerUnit, (v) => { job.postMinutesPerUnit = v; persist(); }))),
      el('div', { class: 'fc-row' },
        field('Packaging per item', numInput(job.packagingPerUnit, (v) => { job.packagingPerUnit = v; persist(); }, { placeholder: String(cfg.packagingPerUnit) })),
        field('Other costs per item', numInput(job.extrasPerUnit, (v) => { job.extrasPerUnit = v; persist(); }, { placeholder: '0' }), 'Inserts, magnets, paint')),
      field('Failure rate %', numInput(job.failureRatePct, (v) => { job.failureRatePct = v; persist(); }, { placeholder: String(cfg.failureRatePct) }), failHint),
      el('h4', { text: 'Pricing' }),
      el('div', { class: 'fc-row' },
        field('Method', modeSelect),
        field(job.mode === 'price' ? `Price per item (${cfg.currency})` : 'Value (%)', numInput(job.value, (v) => { job.value = v; persist(); }, { placeholder: String(modeDefault) }))));

    const results = el('div', { class: 'fc-col fc-results', id: 'fc-results', 'aria-live': 'polite' });
    pane.append(el('div', { class: 'fc-grid' }, inputs, results));
    recalc();
  }

  function filamentRow(line, idx) {
    const sel = el('select', { 'aria-label': `Filament ${idx + 1}`, onchange: (e) => { line.filamentId = e.target.value; persist(); renderQuote(); } },
      el('option', { value: '', text: filaments.length ? 'Choose filament...' : 'Custom (no filaments in the library)' }),
      filaments.map((f) => el('option', { value: String(f.id), text: `${filamentLabel(f)}${cfg.filaments[f.id]?.spoolPrice ? '' : ' (no price set)'}` })),
      el('option', { value: 'custom', text: 'Custom price per kg' }));
    sel.value = line.filamentId || '';
    const custom = (line.filamentId === 'custom' || (!line.filamentId && !filaments.length));
    return el('div', { class: 'fc-filament-row' },
      sel,
      custom ? numInput(line.costPerKg, (v) => { line.costPerKg = v; persist(); }, { placeholder: `${cfg.currency}/kg`, 'aria-label': 'Price per kilogram' }) : null,
      numInput(line.grams, (v) => { line.grams = v; persist(); }, { placeholder: 'grams', 'aria-label': 'Grams per plate' }),
      job.filaments.length > 1 ? el('button', { type: 'button', class: 'fc-icon-btn', 'aria-label': 'Remove this filament', title: 'Remove', onclick: () => { job.filaments.splice(idx, 1); persist(); renderQuote(); } }, '×') : null);
  }

  function addFilamentLine() {
    if (job.filaments.length >= MAX_FILAMENT_LINES) return;
    job.filaments.push({ filamentId: '', costPerKg: '', grams: '' });
    persist();
    renderQuote();
  }

  function persist() { scheduleSave(); recalc(); }

  function recalc() {
    const box = $('fc-results');
    if (!box) return;
    const lj = libJob();
    const r = FC.computeJob(cfg, lj);
    box.textContent = '';

    // warnings first: a quote built on missing numbers is worse than no quote
    const warnings = [];
    if (!configSaved) warnings.push('Electricity, labour and the other assumptions are placeholders until you set them in Farm setup.');
    if (!(lj.printHours > 0)) warnings.push('Enter a print time and the machine cost will appear.');
    if (!r.grams) warnings.push('No filament weight entered, so material cost is zero.');
    const usedPrinter = job.printerId !== 'average' ? cfg.printers[job.printerId] : null;
    if (usedPrinter && usedPrinter.price === 0) warnings.push('This printer has no purchase price yet, so wear and tear is counted as zero. Set it in Farm setup.');
    if (job.mode !== 'price' && !r.reachable) warnings.push('Platform fees plus your target margin come to 100% or more. No price can deliver that. Lower one of them.');
    if (job.mode === 'price' && !(FC.num(job.value, 0) > 0)) warnings.push('Enter the price you plan to charge per item.');
    for (const l of job.filaments) {
      if (l.filamentId && l.filamentId !== 'custom' && l.grams && !(cfg.filaments[l.filamentId]?.spoolPrice > 0)) {
        warnings.push('A selected filament has no spool price. Set it in Farm setup or use a custom price.');
        break;
      }
    }
    if (warnings.length) box.append(el('ul', { class: 'fc-warnings' }, warnings.map((w) => el('li', { text: w }))));

    const priced = job.mode === 'price' || r.reachable;
    box.append(
      el('div', { class: 'fc-headline' },
        el('div', { class: 'fc-price-label', text: 'Price per item' }),
        el('div', { class: 'fc-price', text: priced ? money(r.unitPrice) : '-' }),
        el('div', { class: 'fc-price-sub', text: priced ? `${money(r.revenue)} for ${r.units} item${r.units === 1 ? '' : 's'}` : '' })),
      el('div', { class: 'fc-tiles' },
        tile('Cost per item', money(r.costPerUnit)),
        tile('Profit', priced ? money(r.profit) : '-', priced && r.profit < 0 ? 'bad' : ''),
        tile('Margin', priced ? pct(r.marginPct) : '-', priced && r.marginPct < 0 ? 'bad' : '', 'Share of the selling price you keep'),
        tile('Markup', priced ? pct(r.markupPct, 0) : '-', '', 'Extra on top of cost. A 50% markup is only a 33% margin.'),
        tile('Profit per machine hour', priced ? money(r.profitPerMachineHour) : '-', priced && r.profitPerMachineHour < 0 ? 'bad' : '', 'What an hour of printer time earns on this job'),
        tile('Machine time', hoursText(r.printer.machineHours))));

    // breakdown
    const b = r.breakdown;
    const parts = [
      ['Material', b.material], ['Printer wear', b.machine.depreciation], ['Electricity', b.machine.electricity],
      ['Maintenance', b.machine.maintenance], ['Overhead share', b.machine.overhead],
      ['Hands-on labour', b.handsOn], ['Unattended time', b.unattended], ['Packaging', b.packaging],
      ['Other costs', b.extras], ['Failure allowance', b.failureBuffer], ['Platform fees', priced ? r.fees : 0]
    ].filter(([, v]) => v > 0.0005);
    const totalForBars = parts.reduce((s, [, v]) => s + v, 0);
    box.append(el('h4', { text: 'Where the money goes' }),
      el('table', { class: 'fc-table fc-breakdown' },
        el('tbody', {}, parts.map(([label, v]) => el('tr', {},
          el('th', { scope: 'row', text: label }),
          el('td', { class: 'fc-num', text: money(v) }),
          el('td', { class: 'fc-bar-cell' }, el('span', { class: 'fc-bar', style: `width:${Math.max(2, (v / totalForBars) * 100).toFixed(1)}%` }))))),
        el('tfoot', {}, el('tr', {}, el('th', { scope: 'row', text: 'Total cost' }), el('td', { class: 'fc-num', text: money(r.cost) }), el('td')))));

    // what-if
    if (priced && r.cost > 0) {
      const s = FC.sensitivity(cfg, lj);
      box.append(el('h4', { text: 'What if... (price held where it is)' }),
        el('table', { class: 'fc-table' }, el('tbody', {}, s.rows.map((row) => el('tr', {},
          el('th', { scope: 'row', text: row.label }),
          el('td', { class: `fc-num ${row.deltaProfit < 0 ? 'fc-neg' : 'fc-pos'}`, text: `${row.deltaProfit >= 0 ? '+' : ''}${money(row.deltaProfit)}` }),
          el('td', { class: 'fc-num', text: `margin ${pct(row.marginPct)}` }))))));
    }

    box.append(batchPlanner(lj, r));
    box.append(el('div', { class: 'fc-actions' },
      el('button', { type: 'button', class: 'fc-btn', onclick: () => copyQuote(r, lj) }, 'Copy quote as text'),
      el('span', { id: 'fc-copy-status', class: 'fc-hint' })));
  }

  function tile(label, value, tone, title) {
    return el('div', { class: `fc-tile ${tone || ''}`, title: title || null }, el('div', { class: 'fc-tile-value', text: value }), el('div', { class: 'fc-tile-label', text: label }));
  }

  // ---------- batch planner (the "it's a farm" bit) ----------
  function batchPlanner(lj, r) {
    const active = printers.filter((p) => cfg.printers[String(p.id)]?.active);
    const wrap = el('div', { class: 'fc-batch' });
    if (r.plates < 2 || active.length < 2 || !(lj.printHours > 0)) {
      if (r.plates >= 2 && active.length < 2) wrap.append(el('p', { class: 'fc-hint', text: 'Add or enable a second printer and this will show how to split the plates across your farm.' }));
      return wrap;
    }
    const selected = batchSelection || new Set(active.map((p) => String(p.id)));
    wrap.append(el('h4', { text: `Splitting ${r.plates} plates across the farm` }),
      el('div', { class: 'fc-checks' }, active.map((p) => {
        const id = String(p.id);
        const cb = el('input', { type: 'checkbox', id: `fc-batch-${id}` });
        cb.checked = selected.has(id);
        cb.addEventListener('change', () => {
          const next = new Set(batchSelection || active.map((x) => String(x.id)));
          if (cb.checked) next.add(id); else next.delete(id);
          batchSelection = next;
          recalc();
        });
        return el('label', { class: 'fc-check', for: `fc-batch-${id}` }, cb, ' ', printerLabel(p));
      })));
    const ids = [...selected];
    if (!ids.length) { wrap.append(el('p', { class: 'fc-hint', text: 'Tick at least one printer.' })); return wrap; }
    const sched = FC.scheduleBatch(cfg, { plates: r.plates, printHours: lj.printHours, printerIds: ids });
    const nameOf = (id) => { const p = printers.find((x) => String(x.id) === String(id)); return p ? printerLabel(p) : id; };
    wrap.append(el('table', { class: 'fc-table' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Printer' }), el('th', { class: 'fc-num', text: 'Plates' }), el('th', { class: 'fc-num', text: 'Busy for' }), el('th', { class: 'fc-num', text: 'Machine cost' }))),
      el('tbody', {}, sched.lanes.filter((l) => l.plates > 0).map((l) => el('tr', {},
        el('th', { scope: 'row', text: nameOf(l.id) }), el('td', { class: 'fc-num', text: l.plates }), el('td', { class: 'fc-num', text: hoursText(l.busyHours) }), el('td', { class: 'fc-num', text: money(l.cost) })))),
      el('tfoot', {}, el('tr', {}, el('th', { scope: 'row', text: 'Whole batch ready in' }), el('td'), el('td', { class: 'fc-num', text: hoursText(sched.makespanHours) }), el('td', { class: 'fc-num', text: money(sched.machineCost) })))));
    const oneHours = FC.printTimeOn(cfg.printers[ids[0]], lj.printHours) * r.plates;
    if (oneHours > sched.makespanHours + 0.01) wrap.append(el('p', { class: 'fc-hint', text: `On ${nameOf(ids[0])} alone it would take ${hoursText(oneHours)}.` }));
    return wrap;
  }

  function copyQuote(r, lj) {
    const lines = [
      job.name ? `Quote: ${job.name}` : 'Quote',
      `Items: ${r.units} (${r.plates} plate${r.plates === 1 ? '' : 's'} x ${r.unitsPerPlate})`,
      `Price per item: ${money(r.unitPrice)}`,
      `Total: ${money(r.revenue)}`,
      `Cost: ${money(r.cost)}  Profit: ${money(r.profit)}  Margin: ${pct(r.marginPct)}`,
      `Machine time: ${hoursText(r.printer.machineHours)}  Filament: ${Math.round(r.grams)} g`
    ];
    const text = lines.join('\n');
    const done = (ok) => { const s = $('fc-copy-status'); if (s) s.textContent = ok ? 'Copied' : 'Copy failed, select and copy by hand'; };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    else {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) { /* nope */ }
      ta.remove(); done(ok);
    }
  }

  // ---------- FARM SETUP TAB ----------
  function cfgNumber(label, key, hint, attrs) {
    return field(label, numInput(cfg[key], (v) => { cfg[key] = FC.num(v, 0); scheduleSave(); refreshFarmSummary(); }, attrs), hint);
  }

  function renderFarm() {
    const pane = $('fc-pane-farm');
    pane.textContent = '';
    const histAll = FC.failureRateFromStats(outcomeStats);

    const currency = el('input', { type: 'text', maxlength: '4', value: cfg.currency, 'aria-label': 'Currency symbol', oninput: (e) => { cfg.currency = e.target.value || '£'; scheduleSave(); refreshFarmSummary(); } });
    const failBtn = el('button', { type: 'button', class: 'fc-btn fc-small', onclick: () => {
      if (histAll.ratePct === null) { setStatus(`Only ${histAll.total} logged prints. Need at least 10 to say anything useful.`, true); return; }
      cfg.failureRatePct = Math.round(histAll.ratePct * 10) / 10; scheduleSave(); renderFarm();
    } }, histAll.ratePct === null ? `History: ${histAll.total} prints (too few)` : `Use my history: ${pct(histAll.ratePct)}`);

    const business = el('section', { class: 'fc-card' },
      el('h4', { text: 'Business' }),
      el('div', { class: 'fc-settings-grid' },
        field('Currency symbol', currency),
        cfgNumber('Electricity (per kWh)', 'electricityRate', 'From your bill, in the currency above'),
        cfgNumber('Your hourly rate', 'labourRate', 'Hands-on time: setup, finishing, packing'),
        cfgNumber('Monitoring rate (per machine hour)', 'unattendedRate', 'Optional. Some pricing guides charge a lower rate for unattended machine time than for hands-on work. A guideline, not a rule'),
        cfgNumber('Overhead per month', 'overheadPerMonth', 'Rent, insurance, software, accountant. Spread over planned machine hours'),
        field('Failure rate %', numInput(cfg.failureRatePct, (v) => { cfg.failureRatePct = FC.num(v, 0, { min: 0, max: 90 }); scheduleSave(); }), 'Share of plates that fail'),
        field('Your own numbers', failBtn),
        cfgNumber('Target margin %', 'targetMarginPct', 'Share of the selling price you keep'),
        cfgNumber('Markup % (markup mode)', 'markupPct'),
        cfgNumber('Platform fee %', 'feePct', 'Etsy, eBay, card fees: percent of the price'),
        cfgNumber(`Fixed fee per order`, 'feeFixed'),
        cfgNumber('Packaging per item', 'packagingPerUnit'),
        cfgNumber('Round prices up to', 'roundUpTo', '0 for none. 0.5 rounds to the next 50p')));

    const printerRows = printers.length
      ? printers.map((p) => printerRow(p))
      : [el('tr', {}, el('td', { colspan: '9', class: 'fc-hint', text: 'No printers yet. Add them in Printer Manager and they appear here.' }))];
    const printerCard = el('section', { class: 'fc-card' },
      el('h4', { text: 'Printers' }),
      el('p', { class: 'fc-hint', text: 'Desktop printers typically draw 100 to 150 W while printing, enclosed or heated-chamber ones 200 to 400 W, and last somewhere between 3,000 and 10,000 print hours. Treat those as starting points (PrintPal) and measure your own with a plug-in meter if you can.' }),
      el('div', { class: 'fc-scroll' }, el('table', { class: 'fc-table fc-edit-table' },
        el('thead', {}, el('tr', {}, ['On', 'Printer', 'Price', 'Resale', 'Lifetime h', 'Watts', 'Upkeep /h', 'Hours /month', 'Speed x', 'Logged fails'].map((h) => el('th', { text: h })))),
        el('tbody', {}, printerRows))));

    const filamentRows = filaments.length
      ? filaments.map((f) => filamentSetupRow(f))
      : [el('tr', {}, el('td', { colspan: '4', class: 'fc-hint', text: 'No filaments in the library yet. Add them in Filament Manager (or sync from Spoolman) and set prices here.' }))];
    const filamentCard = el('section', { class: 'fc-card' },
      el('h4', { text: 'Filament prices' }),
      el('div', { class: 'fc-scroll' }, el('table', { class: 'fc-table fc-edit-table' },
        el('thead', {}, el('tr', {}, ['Filament', 'Spool price', 'Spool grams', 'Cost per kg'].map((h) => el('th', { text: h })))),
        el('tbody', {}, filamentRows))));

    const summaryCard = el('section', { class: 'fc-card' }, el('h4', { text: 'What the farm costs to run' }), el('div', { id: 'fc-farm-summary' }));

    const io = el('section', { class: 'fc-card' },
      el('h4', { text: 'Backup' }),
      el('div', { class: 'fc-actions' },
        el('button', { type: 'button', class: 'fc-btn fc-small', onclick: exportConfig }, 'Export settings (JSON)'),
        el('label', { class: 'fc-btn fc-small fc-file' }, 'Import settings', el('input', { type: 'file', accept: 'application/json,.json', onchange: importConfig }))));

    pane.append(business, printerCard, filamentCard, summaryCard, io);
    refreshFarmSummary();
  }

  function printerRow(p) {
    const id = String(p.id);
    const c = cfg.printers[id];
    const set = (key) => (v) => { c[key] = FC.num(v, 0); scheduleSave(); refreshFarmSummary(); };
    const hist = FC.failureRateFromStats(outcomeStats, p.id);
    const active = el('input', { type: 'checkbox', 'aria-label': `${printerLabel(p)} is in service` });
    active.checked = c.active;
    active.addEventListener('change', () => { c.active = active.checked; scheduleSave(); refreshFarmSummary(); });
    return el('tr', {},
      el('td', {}, active),
      el('th', { scope: 'row', text: printerLabel(p) }),
      el('td', {}, numInput(c.price, set('price'), { 'aria-label': 'Purchase price' })),
      el('td', {}, numInput(c.residual, set('residual'), { 'aria-label': 'Resale value' })),
      el('td', {}, numInput(c.lifetimeHours, set('lifetimeHours'), { min: '1', 'aria-label': 'Lifetime in hours' })),
      el('td', {}, numInput(c.watts, set('watts'), { 'aria-label': 'Watts while printing' })),
      el('td', {}, numInput(c.maintenancePerHour, set('maintenancePerHour'), { 'aria-label': 'Upkeep cost per hour' })),
      el('td', {}, numInput(c.hoursPerMonth, set('hoursPerMonth'), { max: '744', 'aria-label': 'Planned print hours per month' })),
      el('td', {}, numInput(c.speedFactor, set('speedFactor'), { min: '0.1', 'aria-label': 'Speed compared with the slicer estimate' })),
      el('td', { class: 'fc-num', text: hist.ratePct === null ? `${hist.total} logged` : pct(hist.ratePct) }));
  }

  function filamentSetupRow(f) {
    const id = String(f.id);
    const c = cfg.filaments[id];
    const perKg = el('td', { class: 'fc-num' });
    const showPerKg = () => { perKg.textContent = c.spoolPrice > 0 ? `${money((c.spoolPrice / c.spoolGrams) * 1000)}/kg` : '-'; };
    showPerKg();
    return el('tr', {},
      el('th', { scope: 'row', text: filamentLabel(f) }),
      el('td', {}, numInput(c.spoolPrice, (v) => { c.spoolPrice = FC.num(v, 0); showPerKg(); scheduleSave(); }, { 'aria-label': 'Spool price' })),
      el('td', {}, numInput(c.spoolGrams, (v) => { c.spoolGrams = FC.num(v, 1000, { min: 1 }); showPerKg(); scheduleSave(); }, { min: '1', 'aria-label': 'Grams per spool' })),
      perKg);
  }

  function refreshFarmSummary() {
    const box = $('fc-farm-summary');
    if (!box) return;
    box.textContent = '';
    const ref = libJob();
    const hasRef = ref.printHours > 0 && job.filaments.some((l) => FC.num(l.grams, 0) > 0);
    const s = FC.farmSummary(cfg, hasRef ? { ...ref, pricing: ref.pricing } : null);
    if (!s.rows.length) { box.append(el('p', { class: 'fc-hint', text: 'Tick at least one printer as in service.' })); return; }
    const nameOf = (id) => { const p = printers.find((x) => String(x.id) === String(id)); return p ? printerLabel(p) : id; };
    box.append(
      el('p', { class: 'fc-hint', text: `Planned ${Math.round(s.monthlyHours)} machine hours a month. Overhead works out at ${money(s.overheadPerHour)} per machine hour. Fixed monthly cost (overhead plus wear): ${money(s.fixedMonthly)}.` }),
      el('div', { class: 'fc-scroll' }, el('table', { class: 'fc-table' },
        el('thead', {}, el('tr', {}, ['Printer', 'Wear /h', 'Power /h', 'Upkeep /h', 'Overhead /h', 'Total /h', hasRef ? 'Pays back in' : ''].map((h) => el('th', { class: h === 'Printer' ? '' : 'fc-num', text: h })))),
        el('tbody', {}, s.rows.map((row) => el('tr', {},
          el('th', { scope: 'row', text: nameOf(row.id) }),
          ...['depreciation', 'electricity', 'maintenance', 'overhead', 'total'].map((k) => el('td', { class: 'fc-num', text: money(row.hourly[k]) })),
          el('td', { class: 'fc-num', text: hasRef ? (row.paybackMonths ? `${row.paybackMonths.toFixed(1)} months` : 'never at this price') : '' })))))),
      hasRef
        ? el('p', { class: 'fc-hint', text: `Payback uses the job on the Quote tab as a typical job, running flat out for each printer's planned hours.${s.monthlyProfit !== null ? ` Farm profit on that basis: ${money(s.monthlyProfit)} a month.` : ''} It is only as good as that quote.` })
        : el('p', { class: 'fc-hint', text: 'Fill in a quote (print time and filament) and payback times appear here.' }));
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify({ app: 'printventory-farm-cost', version: 1, config: cfg }, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'farm-cost-settings.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function importConfig(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (data.app !== 'printventory-farm-cost' || !data.config) throw new Error('not a Printventory farm cost export');
        cfg = FC.normaliseConfig(data.config);
        // printer ids belong to this library; keep entries only for printers that exist here
        for (const k of Object.keys(cfg.printers)) if (!printers.some((p) => String(p.id) === k)) delete cfg.printers[k];
        for (const k of Object.keys(cfg.filaments)) if (!filaments.some((f) => String(f.id) === k)) delete cfg.filaments[k];
        for (const p of printers) cfg.printers[String(p.id)] = FC.normalisePrinter(cfg.printers[String(p.id)] || {});
        for (const f of filaments) cfg.filaments[String(f.id)] = FC.normaliseFilament(cfg.filaments[String(f.id)] || {});
        scheduleSave(); renderFarm(); setStatus('Imported. Printer and filament entries only carry over where the IDs match this library.');
      } catch (err) {
        setStatus(`Could not import: ${err.message}`, true);
      }
    };
    reader.readAsText(file);
  }

  // ---------- open / close ----------
  async function openFarmCost() {
    const dialog = $('farm-cost-dialog');
    if (!dialog || !FC) return;
    if (!built) buildUi();
    await loadStored();
    await loadLibraryData();
    dialog.classList.add('modal-fullscreen');
    syncFullscreenButton();
    switchTab(tab);
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  }

  function syncFullscreenButton() {
    const btn = $('farm-cost-fullscreen-toggle');
    const dialog = $('farm-cost-dialog');
    if (!btn || !dialog) return;
    const full = dialog.classList.contains('modal-fullscreen');
    btn.title = full ? 'Exit Full Screen' : 'Full Screen';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', full ? 'true' : 'false');
  }

  function init() {
    if (!FC) { console.error('[FarmCost] farm-cost-lib.js did not load'); return; }
    window._electronRealEventHandlers = window._electronRealEventHandlers || {};
    window._electronRealEventHandlers['open-farm-cost'] = function () { openFarmCost(); };
    if (window._electronPendingEvents?.['open-farm-cost']) {
      window._electronPendingEvents['open-farm-cost'].forEach((args) => window._electronRealEventHandlers['open-farm-cost'].apply(null, args));
      delete window._electronPendingEvents['open-farm-cost'];
    }
    window.openFarmCost = openFarmCost;
    $('farm-cost-button')?.addEventListener('click', openFarmCost);
    $('farm-cost-close')?.addEventListener('click', () => $('farm-cost-dialog')?.close());
    $('farm-cost-fullscreen-toggle')?.addEventListener('click', () => {
      $('farm-cost-dialog')?.classList.toggle('modal-fullscreen');
      syncFullscreenButton();
    });
    $('farm-cost-dialog')?.addEventListener('close', () => {
      // flush any pending debounce so closing quickly never loses an edit
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; Promise.resolve().then(async () => { try { await window.electron.saveSetting(CONFIG_KEY, JSON.stringify(cfg)); await window.electron.saveSetting(JOB_KEY, JSON.stringify(job)); } catch (_) { /* nothing more to do */ } }); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
