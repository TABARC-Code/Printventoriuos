# Farm Cost Calculator: what I looked at and what I took

*TABARC-Code, 12 October 2026. Written the evening I should have been doing something else.*

I wanted to know what a 3D print cost calculator ought to do before building one into Printventory, so I read what already exists. This is the honest version of that reading: what I actually opened, what I only saw in a search snippet, and what I left alone. Where I couldn't verify something, it says so.

## What I read properly

| Source | What it does | Useful ideas |
| --- | --- | --- |
| [PrintCost](https://github.com/8bits1beard-io/PrintCost) (open source, browser, local storage only) | Printer, filament, electricity, consumables, labour, failure buffer, markup, profit/loss, print history, JSON import and export, multi-filament and AMS support | Failure buffer as `subtotal x f / (1 - f)`. Consumables as price over lifetime hours. Profit and loss from a given selling price. JSON backup. Multiple printer and filament profiles |
| [PrintPal calculator](https://printpal.io/tools/3d-print-cost-calculator) | Spool price and weight, print weight, time, power draw, electricity rate, optional machine wear and failure rate | Quotes typical ranges: desktop printers 100-150 W, enclosed or heated chamber 200-400 W, lifetimes 3,000-10,000 hours. Formulas aren't published, so I couldn't compare them |
| [Siraya: How to Price 3D Prints](https://siraya.tech/blogs/news/how-to-price-3d-prints) | A pricing guide | `Price = (Material + Machine + Labour + Overhead) / (1 - margin)`. Platform fees of 5-15% plus a fixed payment fee. Failure buffer 5-15%. Spread monthly overhead across expected units. Unattended machine time billed at a lower rate than hands-on work |
| [Daedalus](https://pkg.go.dev/github.com/philjestin/daedalus) (open source, self-hosted, small project) | Multi-printer manager (OctoPrint, Bambu, Klipper) with expenses, products and profit tracking | Expense categories (filament, parts, tools, shipping, marketplace fees, subscriptions, advertising). Per-product cost rollups. Profit per hour in sales analytics. Printer job outcomes and retries. The page didn't say how costs are allocated, so I can't say how it does the sums |

## What I only saw in search results

- **Printago** describes tracking material use and profitability against real costs. That's from search snippets and a marketing page; its material-management page returned a 404 when I fetched it, and the site shows an alpha early-access sign-up. Treat it as a vendor claim I haven't verified.
- **Prusa's calculator, Omni Calculator, MakerShop** turned up in a comparison article of mixed quality. Read as: energy, labour and maintenance (Prusa), a three-part material/labour/price layout (Omni), wear, bed adhesion and markup (MakerShop). I did not open them.
- **OctoFarm and Obico**: nothing useful on cost tracking. The only OctoFarm comparison I found was written by a competitor.
- Several other results were obviously rewritten filler. I ignored them and I'd suggest you do too.

## The gap

Nearly all of the calculators above price *one print on one printer*. A farm isn't that. It has different machines with different prices, power draw, speed and lifespans; overhead that is shared; real failure history; and a constant question of which printer should take which plate. The management tools (Daedalus, Printago) know about farms but, from what I could see, don't make the pricing maths easy to inspect.

Printventory already has your printers, your filaments, and a log of printed, failed and cancelled jobs. So the calculator uses those.

## What I built, and what I deliberately did differently

1. **Per-printer cost profile.** Price, resale value, lifetime hours, watts, upkeep per hour, planned hours per month, and a speed factor. The same plate costs different amounts on different printers.
2. **Overhead spread over planned farm hours**, so a half-empty farm shows its real hourly cost (Siraya's advice, applied to machine hours instead of units).
3. **Failure allowance only on what a failure wastes.** Material, machine time and monitoring. PrintCost applies it to the whole subtotal, which overstates it when labour is large. A failed print doesn't un-wrap a parcel.
4. **Your own failure rate.** From logged prints, quantity-weighted, cancelled prints excluded, and it refuses to give a number below 10 prints. This needed one new query (`get-print-outcome-stats`).
5. **Pricing on margin of the selling price, after fees**, with markup mode alongside and both always shown. A 50% markup is only a 33% margin, and mixing them up is the commonest pricing error I came across.
6. **Profit per machine hour** as a headline number, because on a farm the scarce thing is printer time, not material.
7. **Batch planner.** Give it N plates and it hands each to the printer that would finish it soonest (ties go to the cheaper one), then reports when the whole batch is done and what the machine time cost. Greedy, not optimal, and easy to explain.
8. **What-if table.** Failure rate, electricity and filament price nudged up and down with the price held, so you can see how fragile a margin is.
9. **Payback per printer** from a typical job. Only as good as that job.
10. **Settings export and import** as JSON, like PrintCost.

## What I left out, on purpose

- **Electricity rates by region.** PrintCost ships a table. I couldn't verify one, so you enter your own rate. The default (25p) is a placeholder and the page warns you until you've saved your own numbers.
- **Brand printer presets** with wattage and lifetime. I didn't want to hand you invented specifications.
- **Time-of-use tariffs**, **expense tracking** (Daedalus), **marketplace order intake** (Printago) and **pulling grams and print time from 3MF files automatically.** All good ideas; none of them today's job.

## Limits

- Slicer estimates are estimates. Real prints run over.
- Lifetime hours and failure rates are assumptions, and the maths is only as honest as they are.
- Money is held as plain numbers and rounded for display. It's a quoting tool, not accounts.
- Tax isn't modelled. Sales tax is collected on someone else's behalf and isn't profit.

Author: TABARC-Code
