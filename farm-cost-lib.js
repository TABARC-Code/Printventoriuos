/*
 * farm-cost-lib.js
 *
 * The maths behind the Print Farm Cost Calculator. No DOM, no database, no
 * Electron: numbers in, numbers out, so it can be tested properly and used from
 * both the browser page and Node.
 *
 * What the research said (notes in docs/farm-cost-research.md): nearly every
 * calculator does filament + electricity + wear, plus a failure allowance. Few
 * treat a *farm* as a farm. This one knows each printer has its own price, power
 * draw, lifespan and speed, so the same plate costs different amounts on
 * different machines, and "which printer should take this" is a real question.
 *
 * Choices worth knowing about, because they differ from the simple calculators:
 *
 *  1. The failure allowance only applies to what a failed print actually wastes:
 *     material, machine time and unattended monitoring. A failed print doesn't
 *     un-wrap a parcel. PrintCost-style tools apply it to the whole subtotal,
 *     which overstates the buffer when labour is large.
 *  2. Overhead (rent, insurance, software...) is spread over the farm's planned
 *     monthly machine hours, so a half-empty farm shows its true hourly cost.
 *  3. Pricing is done on margin of the selling price, after platform fees:
 *         price = (cost + fixed fee) / (1 - fee% - margin)
 *     Markup mode is there too, since plenty of people think in markup. Be aware
 *     a 50% markup is only a 33% margin. Easy to get wrong; the page shows both.
 *  4. Failure rate can come from your own logged prints, not a guess.
 *
 * Money is held as plain numbers (pounds, dollars, whatever the currency symbol
 * says) and rounded only for display. Fine for quoting. Don't build accounts on it.
 *
 * Wishlist: time-of-use electricity tariffs (cheap overnight units are a real
 * thing for a farm that runs at night). Not today.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmCost = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Placeholders. They are NOT market data. Replace with your own numbers.
  const DEFAULT_CONFIG = Object.freeze({
    currency: '£',
    electricityRate: 0.25,      // per kWh
    labourRate: 15,             // per hands-on hour
    unattendedRate: 0,          // per machine hour spent keeping an eye on things
    overheadPerMonth: 0,        // rent, insurance, software, accountant
    failureRatePct: 8,          // percent of plates that fail
    targetMarginPct: 40,        // percent of the selling price
    markupPct: 50,              // used only in markup mode
    feePct: 0,                  // marketplace / payment fee, percent of the price
    feeFixed: 0,                // fixed fee per order
    packagingPerUnit: 0,
    roundUpTo: 0,               // 0 = no rounding; 0.5 rounds prices up to the next 50p
    printers: {},               // by printer id: see normalisePrinter
    filaments: {}               // by filament id: see normaliseFilament
  });

  function num(value, fallback = 0, { min = -Infinity, max = Infinity } = {}) {
    const n = typeof value === 'string' ? parseFloat(value.replace(',', '.')) : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalisePrinter(p = {}) {
    return {
      price: num(p.price, 0, { min: 0 }),
      residual: num(p.residual, 0, { min: 0 }),
      lifetimeHours: num(p.lifetimeHours, 5000, { min: 1 }),
      watts: num(p.watts, 150, { min: 0 }),
      maintenancePerHour: num(p.maintenancePerHour, 0, { min: 0 }),
      hoursPerMonth: num(p.hoursPerMonth, 400, { min: 0, max: 744 }), // 744 = hours in a 31 day month
      speedFactor: num(p.speedFactor, 1, { min: 0.1, max: 10 }),
      active: p.active === undefined ? true : !!p.active
    };
  }

  function normaliseFilament(f = {}) {
    return {
      spoolPrice: num(f.spoolPrice, 0, { min: 0 }),
      spoolGrams: num(f.spoolGrams, 1000, { min: 1 })
    };
  }

  function normaliseConfig(raw = {}) {
    const c = Object.assign({}, DEFAULT_CONFIG, raw || {});
    const out = {
      currency: String(c.currency || '£').slice(0, 4),
      electricityRate: num(c.electricityRate, DEFAULT_CONFIG.electricityRate, { min: 0 }),
      labourRate: num(c.labourRate, DEFAULT_CONFIG.labourRate, { min: 0 }),
      unattendedRate: num(c.unattendedRate, 0, { min: 0 }),
      overheadPerMonth: num(c.overheadPerMonth, 0, { min: 0 }),
      failureRatePct: num(c.failureRatePct, DEFAULT_CONFIG.failureRatePct, { min: 0, max: 90 }),
      targetMarginPct: num(c.targetMarginPct, DEFAULT_CONFIG.targetMarginPct, { min: 0, max: 95 }),
      markupPct: num(c.markupPct, DEFAULT_CONFIG.markupPct, { min: 0, max: 1000 }),
      feePct: num(c.feePct, 0, { min: 0, max: 95 }),
      feeFixed: num(c.feeFixed, 0, { min: 0 }),
      packagingPerUnit: num(c.packagingPerUnit, 0, { min: 0 }),
      roundUpTo: num(c.roundUpTo, 0, { min: 0 }),
      printers: {},
      filaments: {}
    };
    for (const [id, p] of Object.entries(c.printers || {})) out.printers[id] = normalisePrinter(p);
    for (const [id, f] of Object.entries(c.filaments || {})) out.filaments[id] = normaliseFilament(f);
    return out;
  }

  const filamentCostPerGram = (f) => {
    const n = normaliseFilament(f);
    return n.spoolPrice / n.spoolGrams;
  };

  /** Hours the farm plans to run per month, across active printers. */
  function plannedFarmHours(config) {
    return Object.values(config.printers).filter((p) => p.active).reduce((sum, p) => sum + p.hoursPerMonth, 0);
  }

  function overheadPerFarmHour(config) {
    const hours = plannedFarmHours(config);
    return hours > 0 ? config.overheadPerMonth / hours : 0;
  }

  /**
   * Cost of running one printer for one wall-clock hour, split out so the page can
   * show where the money goes. `speedFactor` is NOT applied here: a slow printer
   * costs the same per hour, it just needs more hours (see printTimeOn).
   */
  function printerHourly(config, printer) {
    const p = normalisePrinter(printer);
    const depreciation = Math.max(0, p.price - p.residual) / p.lifetimeHours;
    const electricity = (p.watts / 1000) * config.electricityRate;
    const maintenance = p.maintenancePerHour;
    const overhead = overheadPerFarmHour(config);
    return {
      depreciation, electricity, maintenance, overhead,
      total: depreciation + electricity + maintenance + overhead
    };
  }

  /** Slicer time is for a reference speed of 1. A 1.5x printer finishes in two thirds of it. */
  const printTimeOn = (printer, referenceHours) => num(referenceHours, 0, { min: 0 }) / normalisePrinter(printer).speedFactor;

  function averagePrinter(config) {
    const list = Object.values(config.printers).filter((p) => p.active);
    if (!list.length) return normalisePrinter({});
    const mean = (k) => list.reduce((s, p) => s + p[k], 0) / list.length;
    return normalisePrinter({
      price: mean('price'), residual: mean('residual'), lifetimeHours: mean('lifetimeHours'),
      watts: mean('watts'), maintenancePerHour: mean('maintenancePerHour'),
      hoursPerMonth: mean('hoursPerMonth'), speedFactor: mean('speedFactor')
    });
  }

  function resolvePrinter(config, printerId) {
    if (printerId !== undefined && printerId !== null && printerId !== '' && printerId !== 'average' && config.printers[printerId]) {
      return config.printers[printerId];
    }
    return averagePrinter(config);
  }

  function filamentGrams(config, line) {
    const grams = num(line.grams, 0, { min: 0 });
    let perGram = 0;
    if (line.costPerGram !== undefined && line.costPerGram !== '') perGram = num(line.costPerGram, 0, { min: 0 });
    else if (line.filamentId !== undefined && config.filaments[line.filamentId]) perGram = filamentCostPerGram(config.filaments[line.filamentId]);
    return { grams, perGram, cost: grams * perGram };
  }

  /**
   * One job: `plates` plates, each making `unitsPerPlate` items, on one printer type.
   *
   * job = {
   *   printerId, printHours (slicer estimate per plate), plates, unitsPerPlate,
   *   filaments: [{ grams (per plate), filamentId | costPerGram }],
   *   setupMinutes (per plate), postMinutesPerUnit, extrasPerUnit, packagingPerUnit,
   *   failureRatePct, pricing: { mode: 'margin'|'markup'|'price', value }
   * }
   */
  function computeJob(rawConfig, job = {}) {
    const config = normaliseConfig(rawConfig);
    const plates = Math.max(1, Math.round(num(job.plates, 1, { min: 1 })));
    const unitsPerPlate = Math.max(1, Math.round(num(job.unitsPerPlate, 1, { min: 1 })));
    const units = plates * unitsPerPlate;
    const printer = resolvePrinter(config, job.printerId);
    const hoursPerPlate = printTimeOn(printer, job.printHours);
    const machineHours = hoursPerPlate * plates;
    const rate = printerHourly(config, printer);
    const failurePct = job.failureRatePct === undefined || job.failureRatePct === ''
      ? config.failureRatePct : num(job.failureRatePct, config.failureRatePct, { min: 0, max: 90 });
    const f = failurePct / 100;

    const lines = (job.filaments || []).map((l) => filamentGrams(config, l));
    const material = lines.reduce((s, l) => s + l.cost, 0) * plates;
    const gramsTotal = lines.reduce((s, l) => s + l.grams, 0) * plates;

    const machine = {
      depreciation: rate.depreciation * machineHours,
      electricity: rate.electricity * machineHours,
      maintenance: rate.maintenance * machineHours,
      overhead: rate.overhead * machineHours
    };
    const machineTotal = machine.depreciation + machine.electricity + machine.maintenance + machine.overhead;

    const labourHours = (plates * num(job.setupMinutes, 0, { min: 0 }) + units * num(job.postMinutesPerUnit, 0, { min: 0 })) / 60;
    const handsOn = labourHours * config.labourRate;
    const unattended = machineHours * config.unattendedRate;
    const packaging = units * num(job.packagingPerUnit, config.packagingPerUnit, { min: 0 });
    const extras = units * num(job.extrasPerUnit, 0, { min: 0 });

    // Failure allowance: expected cost per *good* plate is cost / (1 - f). Only the
    // parts a failed print wastes are scaled up.
    const failureBearing = material + machineTotal + unattended;
    const failureBuffer = f >= 1 ? 0 : failureBearing * (f / (1 - f));

    const cost = material + machineTotal + handsOn + unattended + packaging + extras + failureBuffer;

    const pricing = job.pricing || { mode: 'margin' };
    const mode = ['margin', 'markup', 'price'].includes(pricing.mode) ? pricing.mode : 'margin';
    const feeRate = config.feePct / 100;
    let revenue = 0;
    let reachable = true;

    if (mode === 'price') {
      revenue = num(pricing.value, 0, { min: 0 }) * units;
    } else if (mode === 'markup') {
      const m = pricing.value === undefined ? config.markupPct : num(pricing.value, config.markupPct, { min: 0 });
      revenue = cost * (1 + m / 100);
    } else {
      const m = (pricing.value === undefined ? config.targetMarginPct : num(pricing.value, config.targetMarginPct, { min: 0, max: 95 })) / 100;
      const denom = 1 - feeRate - m;
      if (denom <= 0) { reachable = false; revenue = 0; } else revenue = (cost + config.feeFixed) / denom;
    }

    let unitPrice = units > 0 ? revenue / units : 0;
    if (config.roundUpTo > 0 && mode !== 'price' && reachable) {
      unitPrice = Math.ceil(unitPrice / config.roundUpTo - 1e-9) * config.roundUpTo;
      revenue = unitPrice * units;
    }

    const fees = reachable ? revenue * feeRate + (revenue > 0 ? config.feeFixed : 0) : 0;
    const profit = reachable ? revenue - fees - cost : 0;
    const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;
    const markupPct = cost > 0 ? ((revenue - cost) / cost) * 100 : 0;

    return {
      reachable,
      plates, unitsPerPlate, units,
      printer: { hourly: rate, hoursPerPlate, machineHours },
      grams: gramsTotal,
      labourHours,
      breakdown: { material, machine, machineTotal, handsOn, unattended, packaging, extras, failureBuffer },
      cost, costPerUnit: cost / units,
      revenue, unitPrice, fees, profit,
      marginPct, markupPct,
      profitPerMachineHour: machineHours > 0 ? profit / machineHours : 0,
      // before depreciation: what the printer actually earns towards paying for itself
      contributionPerMachineHour: machineHours > 0 ? (profit + machine.depreciation) / machineHours : 0
    };
  }

  /**
   * Spread plates across the active printers, always giving the next plate to
   * whichever printer would finish it soonest (ties go to the cheaper one). Not
   * optimal in theory, perfectly sensible in practice, and easy to explain.
   * Returns the load per printer, the finish time of the whole batch, and cost.
   */
  function scheduleBatch(rawConfig, { plates, printHours, printerIds } = {}) {
    const config = normaliseConfig(rawConfig);
    const ids = (printerIds && printerIds.length ? printerIds : Object.keys(config.printers))
      .filter((id) => config.printers[id] && config.printers[id].active);
    const total = Math.max(0, Math.round(num(plates, 0, { min: 0 })));
    const hours = num(printHours, 0, { min: 0 });
    const lanes = ids.map((id) => ({
      id, plates: 0, busyHours: 0,
      perPlateHours: printTimeOn(config.printers[id], hours),
      hourlyCost: printerHourly(config, config.printers[id]).total
    }));
    if (!lanes.length) return { lanes: [], makespanHours: 0, machineCost: 0, plates: total };

    for (let i = 0; i < total; i++) {
      let best = lanes[0];
      for (const lane of lanes) {
        const finish = lane.busyHours + lane.perPlateHours;
        const bestFinish = best.busyHours + best.perPlateHours;
        const cheaper = lane.perPlateHours * lane.hourlyCost < best.perPlateHours * best.hourlyCost;
        if (finish < bestFinish - 1e-9 || (Math.abs(finish - bestFinish) <= 1e-9 && cheaper)) best = lane;
      }
      best.plates++;
      best.busyHours += best.perPlateHours;
    }
    const machineCost = lanes.reduce((s, l) => s + l.busyHours * l.hourlyCost, 0);
    return {
      lanes: lanes.map((l) => ({ ...l, cost: l.busyHours * l.hourlyCost })),
      makespanHours: Math.max(...lanes.map((l) => l.busyHours)),
      machineCost,
      plates: total
    };
  }

  /** Per-printer hourly table plus the farm's monthly picture, for a reference job. */
  function farmSummary(rawConfig, referenceJob) {
    const config = normaliseConfig(rawConfig);
    const active = Object.entries(config.printers).filter(([, p]) => p.active);
    const ref = referenceJob ? computeJob(config, { ...referenceJob, printerId: undefined }) : null;
    const rows = active.map(([id, p]) => {
      const hourly = printerHourly(config, p);
      const row = { id, hourly, hoursPerMonth: p.hoursPerMonth, speedFactor: p.speedFactor, paybackMonths: null, monthlyProfit: null };
      if (ref && ref.printer.machineHours > 0) {
        // Contribution is per wall-clock hour of a typical printer, with depreciation
        // added back (it's what's left to pay for the machine). Then take this
        // printer's own depreciation off to get its monthly profit. Speed is left
        // out on purpose: hoursPerMonth is already wall-clock time.
        const monthly = p.hoursPerMonth * ref.contributionPerMachineHour;
        row.monthlyProfit = monthly - hourly.depreciation * p.hoursPerMonth;
        row.paybackMonths = monthly > 0 && p.price > 0 ? p.price / monthly : null;
      }
      return row;
    });
    const monthlyHours = plannedFarmHours(config);
    const monthlyProfit = rows.every((r) => r.monthlyProfit !== null) && rows.length
      ? rows.reduce((s, r) => s + r.monthlyProfit, 0) : null;
    const fixedMonthly = config.overheadPerMonth + active.reduce((s, [, p]) => s + (Math.max(0, p.price - p.residual) / p.lifetimeHours) * p.hoursPerMonth, 0);
    return { rows, monthlyHours, monthlyProfit, fixedMonthly, overheadPerHour: overheadPerFarmHour(config) };
  }

  /**
   * Failure rate from logged prints. `stats` is rows of { printer_id, outcome,
   * quantity }. Cancelled prints are left out: they're a decision, not a failure.
   * Returns null if there isn't enough history to say anything honest.
   */
  function failureRateFromStats(stats, printerId, minSamples = 10) {
    let printed = 0; let failed = 0;
    for (const row of stats || []) {
      if (printerId !== undefined && printerId !== null && String(row.printer_id) !== String(printerId)) continue;
      const q = Math.max(1, Math.round(num(row.quantity, 1, { min: 1 })));
      if (row.outcome === 'printed') printed += q;
      else if (row.outcome === 'failed') failed += q;
    }
    const total = printed + failed;
    if (total < minSamples) return { ratePct: null, total, failed };
    return { ratePct: (failed / total) * 100, total, failed };
  }

  /** Re-run a job with one assumption changed, to show how fragile the margin is. */
  function sensitivity(config, job) {
    const base = computeJob(config, job);
    const cfg = normaliseConfig(config);
    const failure = job.failureRatePct === undefined || job.failureRatePct === '' ? cfg.failureRatePct : num(job.failureRatePct, cfg.failureRatePct);
    // Hold the price at what the base case would charge, then vary the world.
    const priced = (c, j) => computeJob(c, { ...j, pricing: { mode: 'price', value: base.unitPrice } });
    const variants = [
      ['Failure rate +5 points', cfg, { ...job, failureRatePct: Math.min(90, failure + 5) }],
      ['Failure rate -5 points', cfg, { ...job, failureRatePct: Math.max(0, failure - 5) }],
      ['Electricity +25%', { ...cfg, electricityRate: cfg.electricityRate * 1.25 }, job],
      ['Electricity -25%', { ...cfg, electricityRate: cfg.electricityRate * 0.75 }, job],
      ['Filament +10%', cfg, { ...job, filaments: (job.filaments || []).map((l) => ({ ...l, ...(l.costPerGram !== undefined && l.costPerGram !== '' ? { costPerGram: num(l.costPerGram) * 1.1 } : { costPerGram: filamentGrams(cfg, l).perGram * 1.1 }) })) }]
    ];
    return {
      base,
      rows: variants.map(([label, c, j]) => {
        const r = priced(c, j);
        return { label, profit: r.profit, marginPct: r.marginPct, deltaProfit: r.profit - base.profit };
      })
    };
  }

  function formatMoney(value, currency = '£', digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${currency}0.00`;
    const sign = n < 0 ? '-' : '';
    return `${sign}${currency}${Math.abs(n).toFixed(digits)}`;
  }

  return {
    DEFAULT_CONFIG, num, normaliseConfig, normalisePrinter, normaliseFilament,
    filamentCostPerGram, plannedFarmHours, overheadPerFarmHour, printerHourly, printTimeOn,
    computeJob, scheduleBatch, farmSummary, failureRateFromStats, sensitivity, formatMoney
  };
});
