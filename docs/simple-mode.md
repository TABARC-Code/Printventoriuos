# Simple mode

An optional view for people who find the full library manager a lot to take in. It is **off by default**. Nothing is removed, nothing is deleted, and switching it off puts the full interface back exactly as it was.

## Turning it on and off

- **On:** Display and accessibility (the "Aa" button) > Simple mode, or Tools > Simple Mode in the desktop menu or the web menu.
- **Off:** press **Show everything** in the panel at the top of the sidebar, or use any of the routes above again.
- It is remembered on this device only (the same place as the other Display and accessibility choices, `printventory.displayPrefs`), so people sharing one library in Server Mode each keep their own.
- "Reset to standard" in the Display dialog deliberately leaves Simple mode as it is. It resets how things look, and quietly switching you out of Simple mode would be a nasty surprise.

## What stays, and why

The list is short on purpose. The test was: does it serve one of the four everyday jobs (find a model, open it, say whether it has been printed, price a job)?

| Stays | Why |
| --- | --- |
| Model counts, Scan Directory, View Entire Library, scan progress and Stop | An empty library is no use, and you need to see that a scan is running |
| Search, Sort, Folders | Finding a model |
| Print Status filter | "Show me what I want to print" is the filter people ask for most; the rest of "More filters" stays folded away |
| Detailed, Preview and List view buttons | Browsing |
| Model details: name, Print status, Log a print | The "mark print status" job |
| Print Farm Cost Calculator, with its name written on the button | One of the core jobs. In the full layout it is an unlabelled icon |
| Aa (Display and accessibility) and **Show everything** | Always a way to change the look, and always a way back |
| Menus: Tools (Scan Directory, View Entire Library, Farm Cost Calculator, Display and Accessibility, Simple Mode) and Help (Quick Start Guide, Keyboard Shortcuts, About) | The web menu bar and the phone "More" sheet |

Hidden until you press Show everything: De-Dup, Tag, Filament and Printer managers, Print Roulette, Organize Library, the Settings menu, every filter except print status, Invert Filters, Multi-Edit Mode, the boolean search toolbar, "Include Notes", the folder tree, tile size and column pickers, and in the details panel: path, source, designer, parent model, license, tags, filament, notes and print history.

## How it hides things, and what that does and does not mean

- Hidden items use `display: none`, never opacity or off-screen positioning. That removes them from the tab order and the accessibility tree, so a keyboard or screen reader user cannot land on something they cannot see. `simple-mode.test.js` fails if the stylesheet starts hiding any other way.
- It is presentation only. No feature is removed, no IPC channel is changed (one new one-way channel, `toggle-simple-mode`, lets the native Tools menu flip the switch), and nothing in the database is touched.
- **Not hidden:** keyboard shortcuts, the right-click menu on a model card, and Shift-click on a status badge still work exactly as before. Hidden is not locked. If something in Simple mode needs the whole app, press Show everything.
- Simple mode does not change text size or font. Use Text size in the Display dialog for that; they combine.
- The phone/tablet layout hides the tool grid and filters the "More" sheet the same way. That code path is the least tested (see below).

## Changing it

- Sidebar and details rules: `simple-mode.css`. Menu keep-lists: `SIMPLE_MENUS` and `SIMPLE_MENU_ITEMS` in `ui-prefs-lib.js`.
- `simple-mode.css` is read by `scripts/gen-ui-prefs-css.js`, so after changing a font size in it run `node scripts/gen-ui-prefs-css.js` (the staleness test in `ui-prefs-css.test.js` will tell you if you forget).

## What has and has not been checked

Checked:
- `ui-prefs-lib.test.js` and `simple-mode.test.js` (run by `npm run test:unit`): normalising the new choice, old saved prefs still loading, the menu lists matching menus that exist, the stylesheet hiding only by `display: none` and never hiding the core controls, packaging lists, and the switch script against a fake page.
- `simple-mode.smoke.cjs` (Playwright, Chromium, stubbed `window.electron`, no real models): off by default and unchanged; the switch from the Display dialog; what is and is not visible; hidden items absent from Playwright's accessibility snapshot and from the Tab order; the calculator still opens; persistence across reload; Show everything and where focus lands; the web menu filtering. axe-core on the Simple mode screen reported one violation, `region` on `#sidebar-resize-handle`, which already exists in the normal layout and is not part of this change.
- The existing Display and accessibility, UI polish and Farm Cost smoke tests still pass.

Not checked:
- The Electron shell itself: the native Tools menu item and the new IPC channel have not been run in real Electron. They follow the pattern of the existing menu items.
- A real library. The smoke test has no models, so the details panel was checked by un-hiding it, not by opening a card.
- Screen readers (NVDA, VoiceOver, Orca). Only the accessibility tree and Tab order were examined, and the polite announcement text was checked for being set, not for being spoken.
- The phone layout and the "More" sheet filtering.
- Whether these are the right four jobs for the people it is meant for. That needs asking them, not guessing.
