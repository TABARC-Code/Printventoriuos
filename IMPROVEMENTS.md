# PrintVentorious: improvement plan

*TABARC-Code, 12 October 2026. Written at the desk, tea going cold, window suggesting October without bothering to prove it.*

This is a fork of Printventory (MIT, original by TechJeeper Designs). The plan below came from reading the code, running the tests, and poking at the server. It is not a rewrite wishlist. I've tried to follow a simple rule: small changes, each one checked, nothing speculative. If an item here says "not verified", it means I couldn't run the Electron app in the environment I was working in, and I'd sooner say so than guess.

## What I actually did first (and checked)

| Change | Why | How I know it works |
| --- | --- | --- |
| `slicer-detect.js`: normalise backslashes before taking the file stem | A Windows path on a Linux box (server mode, synced settings) was never split, so the slicer came back `null`. The test suite was already complaining about it. | `slicer-detect.test.js` failed before, passes after. Stashed the fix to prove the runner catches it. |
| `scripts/run-unit-tests.js` and `npm run test:unit` | The `test:*` scripts are chained with `&&`, so the first failure hides the rest. | 32 of 32 test files pass. It reports every failure, then exits non-zero. |
| `.github/workflows/unit-tests.yml` | Nothing ran the plain-Node tests on push. The existing workflows need an API key or a display. | Written, **not yet run on GitHub**. First push will tell. |
| `styles.css`: `:focus-visible` ring and `prefers-reduced-motion` | Around fifteen rules set `outline: none`. Keyboard users could lose track of where they were. Only `mobile-ui.css` honoured reduced motion. | Not verified in the running app. The CSS is additive and keyboard-only, so mouse behaviour shouldn't change. Needs a human eyeball. |
| README version 2.2.9 to 2.2.25 | It had drifted three-dozen releases behind. | `package.json` says 2.2.25. |

Before the install step, 9 test files failed. Eight were just missing `fflate`, `jszip` and `better-sqlite3`. One was the real bug above. Worth knowing if you ever wonder why a fresh clone "fails".

## Function

1. **Authentication for Server Mode.** This is the big one. The HTTP server binds `0.0.0.0` in server mode, sets `Access-Control-Allow-Origin: *`, and I found no login or token check in front of the routes. The README says "for local network use", which is honest, but it isn't a control. Proposal: an optional access token (env var and settings field), checked by one middleware, with the bridge sending it. Opt-in first so nobody's existing Docker setup breaks.
2. **Tighten CORS.** The wildcard means any web page in your browser can talk to a Printventory on `localhost` or your LAN. The Chrome extension and MCP clients need a proper allow-list, not nothing. Do this with item 1, not separately, or something will quietly stop working.
3. **Static files from the app directory.** `express.static(__dirname)` serves the app folder. Worth confirming exactly what that exposes (`package.json`, source, maybe more) and moving to an explicit public list.
4. **Synchronous file calls in `main.js`.** About 67 `*Sync(` calls in a file of roughly 15,500 lines. Fine at start-up, unkind inside a scan or request handler. Profile first, then convert the hot ones. Not before.
5. **Split the monsters.** `main.js` (about 15.5k lines) and `renderer.js` (about 26.9k). The repo already has good small modules (`folder-tree-lib.js`, `slicer-detect.js`, `print-events.js`). Keep extracting along those lines, one seam per change, tests first. Not a big-bang rewrite. Those never finish.
6. **Test the two big files.** Most tests cover the extracted modules. The risky logic is still inside `main.js`. Each extraction is a chance to add a test.

## UI / UX

1. **Keyboard and screen reader pass.** `index.html` has 124 `aria-` attributes across 3,013 lines, which is a start. Audit dialogs (focus trap, Escape, focus return), the grid (can you arrow through it?), and icon-only buttons (do they have names?).
2. **Colour contrast on the cyan accent.** `#00d4ff` on dark is fine. On the light surfaces and in the translucent states, I haven't measured. Measure, don't assume.
3. **First-run experience.** Pick a folder, see thumbnails arrive, get told what's happening. A progress line with an honest "this will take a while" beats a spinner that says nothing.
4. **Empty and error states.** "Nothing matches your filters" with a one-click clear. "Thumbnail failed: file too large" with a retry. 2.2.24 and 2.2.25 started tagging these. Surface them.
5. **Undo for destructive actions.** Delete-with-database-cleanup is permanent. A soft "moved to bin, undo for ten seconds" costs little and saves a bad afternoon.
6. **Mobile and PWA.** There is a manifest and a service worker. Check offline behaviour is deliberate and not accidental.
7. **Light theme / system theme.** Follow `prefers-color-scheme`. Optional, but people ask.

## System

1. **Run the unit tests on every push.** Done in this branch, pending the first real run.
2. **Pin and review dependencies.** Run `npm audit` and read it, rather than just accepting that it exists.
3. **Don't ship test fixtures.** `.gitignore` shows `tests/printventory.db*` and `test-files.zip` being kept out. Good. Make sure the build config also leaves them out of installers.
4. **Release automation hygiene.** `scripts/` has Discord announcers and upload helpers. Check none of them rely on credentials living in a file in the working tree. `.gitignore` guards `*git_credentials*`, which tells you somebody has been bitten before.
5. **Rename housekeeping.** Repo name has a typo (`Printventoriuos`) and the fork is now called PrintVentorious. GitHub redirects old URLs after a rename, so clones keep working. The in-app strings, installer name and `appId` (`com.printventory.app`) are a separate decision. Changing `appId` will orphan existing installs' data folders, so I've left it alone on purpose.

## Ideas with no business case whatsoever

- A "print roulette" with a mood setting. Rainy day: small, low-risk prints that finish before tea. Feeling brave: the 14-hour monster with the supports.
- Estimate filament cost per model from the Spoolman data you already pull in.
- A "graveyard" view of failed prints, with a one-line cause each. Strangely therapeutic.
- Shared libraries across two machines with a conflict-aware merge. Ambitious. Probably next year's problem.

## Order of work (Kaizen: one small thing, verify, repeat)

1. Done in this branch: slicer fix, test runner, CI, focus and motion CSS, README.
2. Next, once someone has a running app to test against: Server Mode token plus CORS allow-list as a single opt-in change.
3. Then: static-file allow-list, dialog accessibility audit, soft delete.
4. Ongoing: extract one module from `main.js` per change, with a test.

Nothing here is promised. It's a list. Lists are cheap. Shipping is the dear bit.
