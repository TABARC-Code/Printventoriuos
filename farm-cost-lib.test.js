'use strict';
const assert = require('assert');
const F = require('./farm-cost-lib');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// A £400 printer that lasts 2,000 hours, 150 W, 25p/kWh, £20 a kilo, £20 an hour for the human.
const cfg = {
  electricityRate: 0.25, labourRate: 20, failureRatePct: 10,
  printers: { 1: { price: 400, lifetimeHours: 2000, watts: 150, hoursPerMonth: 500 } },
  filaments: { 1: { spoolPrice: 20, spoolGrams: 1000 } }
};
const job = { printerId: 1, printHours: 3, filaments: [{ grams: 50, filamentId: 1 }], setupMinutes: 6 };

test('cost lines add up, checked by hand', () => {
  const r = F.computeJob(cfg, { ...job, pricing: { mode: 'markup', value: 0 } });
  close(r.breakdown.material, 1.0);                 // 50 g at 2p a gram
  close(r.breakdown.machine.depreciation, 0.6);     // 400 / 2000 * 3 h
  close(r.breakdown.machine.electricity, 0.1125);   // 0.15 kW * 0.25 * 3 h
  close(r.breakdown.handsOn, 2.0);                  // 6 min at 20/h
  close(r.breakdown.failureBuffer, (1 + 0.7125) * (0.1 / 0.9)); // only material + machine
  close(r.cost, 1 + 0.7125 + 2 + (1 + 0.7125) / 9);
});

test('failure allowance does not scale labour or packaging', () => {
  const a = F.computeJob(cfg, { ...job, failureRatePct: 0, packagingPerUnit: 1 });
  const b = F.computeJob(cfg, { ...job, failureRatePct: 20, packagingPerUnit: 1 });
  close(b.breakdown.handsOn, a.breakdown.handsOn);
  close(b.breakdown.packaging, a.breakdown.packaging);
  assert.ok(b.cost > a.cost);
});

test('margin pricing hits the requested margin and shows markup separately', () => {
  const r = F.computeJob(cfg, { ...job, pricing: { mode: 'margin', value: 40 } });
  close(r.marginPct, 40);
  close(r.unitPrice, r.cost / 0.6);
  close(r.markupPct, (1 / 0.6 - 1) * 100); // 66.7%, not 40
});

test('platform fees come off the margin, fixed fee per order', () => {
  const c = { ...cfg, feePct: 10, feeFixed: 0.5 };
  const r = F.computeJob(c, { ...job, pricing: { mode: 'margin', value: 30 } });
  close(r.unitPrice, (r.cost + 0.5) / (1 - 0.1 - 0.3));
  close(r.marginPct, 30);
  close(r.fees, r.revenue * 0.1 + 0.5);
});

test('an unreachable margin is flagged, not turned into nonsense', () => {
  const c = { ...cfg, feePct: 30 };
  const r = F.computeJob(c, { ...job, pricing: { mode: 'margin', value: 70 } });
  assert.strictEqual(r.reachable, false);
  assert.strictEqual(r.unitPrice, 0);
});

test('fixed price mode reports profit and margin', () => {
  const r = F.computeJob(cfg, { ...job, pricing: { mode: 'price', value: 10 } });
  close(r.revenue, 10);
  close(r.profit, 10 - r.cost);
  close(r.marginPct, ((10 - r.cost) / 10) * 100);
});

test('rounding up never lowers the price', () => {
  const r = F.computeJob({ ...cfg, roundUpTo: 0.5 }, { ...job, pricing: { mode: 'margin', value: 40 } });
  assert.strictEqual(Math.round(r.unitPrice * 100) % 50, 0);
  assert.ok(r.unitPrice >= r.cost / 0.6 - 1e-9);
  assert.ok(r.marginPct >= 40 - 1e-9);
});

test('units and plates scale labour and totals', () => {
  const r = F.computeJob(cfg, { printerId: 1, printHours: 2, plates: 3, unitsPerPlate: 4, filaments: [{ grams: 100, filamentId: 1 }], setupMinutes: 5, postMinutesPerUnit: 3, failureRatePct: 0, pricing: { mode: 'markup', value: 0 } });
  assert.strictEqual(r.units, 12);
  close(r.labourHours, (3 * 5 + 12 * 3) / 60);
  close(r.breakdown.material, 3 * 100 * 0.02);
  close(r.costPerUnit * 12, r.cost);
});

test('overhead is spread over planned farm hours, so a quiet farm costs more per hour', () => {
  const busy = { ...cfg, overheadPerMonth: 300 };                       // 500 planned hours
  const quiet = { ...busy, printers: { 1: { ...cfg.printers[1], hoursPerMonth: 100 } } };
  close(F.printerHourly(F.normaliseConfig(busy), busy.printers[1]).overhead, 0.6);
  close(F.printerHourly(F.normaliseConfig(quiet), quiet.printers[1]).overhead, 3.0);
});

test('a faster printer finishes sooner but costs the same per hour', () => {
  const c = { ...cfg, printers: { 1: { ...cfg.printers[1], speedFactor: 2 } } };
  const r = F.computeJob(c, { ...job, pricing: { mode: 'markup', value: 0 } });
  close(r.printer.hoursPerPlate, 1.5);
});

test('inactive printers are ignored by the average and the scheduler', () => {
  const c = { ...cfg, printers: { 1: cfg.printers[1], 2: { ...cfg.printers[1], price: 9999, active: false } } };
  const s = F.scheduleBatch(c, { plates: 4, printHours: 1 });
  assert.deepStrictEqual(s.lanes.map((l) => l.id), ['1']);
  assert.strictEqual(F.computeJob(c, { ...job, printerId: undefined }).printer.hourly.depreciation, 0.2);
});

test('scheduler balances a fast and a slow printer (worked by hand)', () => {
  const p = { price: 400, lifetimeHours: 2000, watts: 150, hoursPerMonth: 400 };
  const c = { ...cfg, printers: { fast: { ...p, speedFactor: 2 }, slow: { ...p, speedFactor: 1 } } };
  const s = F.scheduleBatch(c, { plates: 6, printHours: 3 });
  const by = Object.fromEntries(s.lanes.map((l) => [l.id, l]));
  assert.strictEqual(by.fast.plates, 4);
  assert.strictEqual(by.slow.plates, 2);
  close(s.makespanHours, 6);
});

test('scheduler handles zero plates and no printers', () => {
  assert.strictEqual(F.scheduleBatch(cfg, { plates: 0, printHours: 3 }).makespanHours, 0);
  assert.strictEqual(F.scheduleBatch({}, { plates: 5, printHours: 3 }).lanes.length, 0);
});

test('failure rate from history ignores cancelled prints and refuses small samples', () => {
  const stats = [
    { printer_id: 1, outcome: 'printed', quantity: 17 },
    { printer_id: 1, outcome: 'failed', quantity: 3 },
    { printer_id: 1, outcome: 'cancelled', quantity: 50 },
    { printer_id: 2, outcome: 'failed', quantity: 2 }
  ];
  close(F.failureRateFromStats(stats, 1).ratePct, 15);
  assert.strictEqual(F.failureRateFromStats(stats, 2).ratePct, null);   // 2 samples is not evidence
  close(F.failureRateFromStats(stats).ratePct, (5 / 22) * 100);
});

test('garbage config values fall back to sane ones', () => {
  const c = F.normaliseConfig({ electricityRate: 'abc', failureRatePct: 500, printers: { 1: { lifetimeHours: 0, watts: -5, hoursPerMonth: 9999 } } });
  assert.strictEqual(c.electricityRate, F.DEFAULT_CONFIG.electricityRate);
  assert.strictEqual(c.failureRatePct, 90);
  assert.strictEqual(c.printers[1].lifetimeHours, 1);
  assert.strictEqual(c.printers[1].watts, 0);
  assert.strictEqual(c.printers[1].hoursPerMonth, 744);
  assert.doesNotThrow(() => F.computeJob({}, {}));
  assert.doesNotThrow(() => F.computeJob(null, undefined));
});

test('comma decimals from European keyboards are accepted', () => {
  assert.strictEqual(F.num('0,25'), 0.25);
});

test('farm summary: payback uses contribution, not profit after depreciation', () => {
  const j = { ...job, pricing: { mode: 'margin', value: 40 } };
  const s = F.farmSummary(cfg, j);
  const r = F.computeJob(cfg, { ...j, printerId: undefined });
  const row = s.rows[0];
  close(row.paybackMonths, 400 / (500 * r.contributionPerMachineHour));
  close(row.monthlyProfit, 500 * r.contributionPerMachineHour - 0.2 * 500);
  close(s.fixedMonthly, 0.2 * 500);
});

test('sensitivity: worse assumptions cost money, better ones earn it', () => {
  const s = F.sensitivity(cfg, { ...job, pricing: { mode: 'margin', value: 40 } });
  const row = (l) => s.rows.find((r) => r.label.startsWith(l));
  assert.ok(row('Failure rate +5').deltaProfit < 0);
  assert.ok(row('Failure rate -5').deltaProfit > 0);
  assert.ok(row('Electricity +25').deltaProfit < 0);
  assert.ok(row('Filament +10').deltaProfit < 0);
});

test('formatMoney', () => {
  assert.strictEqual(F.formatMoney(1.005 * 2, '£'), '£2.01');
  assert.strictEqual(F.formatMoney(-3.5, '$'), '-$3.50');
  assert.strictEqual(F.formatMoney(NaN), '£0.00');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
