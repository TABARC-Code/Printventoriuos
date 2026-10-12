# PrintVentorious: improvement plan

*TABARC-Code, 12 October 2026. Written at the desk, tea going cold, window suggesting October without bothering to prove it.*

This is a fork of Printventory (MIT, original by TechJeeper Designs). The plan below came from reading the code, running the tests, and poking at the server. It is not a rewrite wishlist. I've tried to follow a simple rule: small changes, each one checked, nothing speculative. If an item here says "not verified", it means I couldn't run the Electron app in the environment I was working in, and I'd sooner say so than guess.

## Done in this branch (and how it was checked)

| Change | Why | How I know it works |
| --- | --- | --- |
| `slicer-detect.js`: normalise backslashes before taking the file stem | A Windows path on a Linux box (server mode, synced settings) was never split, so the slicer came back `null`. The test suite was already complaining about it. | `slicer-detect.test.js` failed before, passes after. Stashed the fix to prove the runner catches it. |
| `scripts/run-unit-tests.js` and `npm run test:unit` | The `test:*` scripts are chained with `&&`, so the first failure hides the rest. | 32 of 32 test files pass. It reports every failure, then exits non-zero. |
| `.github/workflows/unit-tests.yml` | Nothing ran the plain-Node tests on push. The existing workflows need an API key or a display. | Written, **not yet run on GitHub**. First push will tell. |
| `styles.css`: `:focus-visible` ring and `prefers-reduced-motion` | Around fifteen rules set `outline: none`. Keyboard users could lose track of where they were. Only `mobile-ui.css` honoured reduced motion. | Not verified in the running app. The CSS is additive and keyboard-only, so mouse behaviour shouldn't change. Needs a human eyeball. |
| README version 2.2.9 to 2.2.25 | It had drifted three-dozen releases behind. | `package.json` says 2.2.25. |
| `server-security.js` wired into `startHttpServer` | The WebSocket carrying every app call accepted any origin, and browsers don't apply CORS to WebSockets, so a web page in the same browser could drive a local Printventory. CORS was `*`. | `server-security.test.js`: 12 tests against a real express server and real WebSockets. With the origin check disabled, 3 of them fail. |
| Optional `PRINTVENTORY_ACCESS_TOKEN` | Server Mode had no login. Opt-in so existing setups keep working. Bearer header or `?token=` then an HttpOnly cookie; applies to HTTP, MCP and the WebSocket. Tokens under 16 characters are refused at start-up. | Same test file: wrong token 401, Bearer works, cookie works for the WebSocket too. |
| Static-file blocklist | `express.static` served the whole app folder, `package-lock.json`, Dockerfiles, `scripts/` and `tests/` included. | Tested, including that `/api/helper/bundle` (which contains `helper/`) still passes through. |
| Packaging lists | A new file that isn't listed in `package.json` `build.files`, the Dockerfile and the distribution scripts would crash the built app on `require`. Added to all four places. | Checked by search. **Not built**: I couldn't run electron-builder or Docker here. |
| `aria-label` on 12 icon-only `+` buttons | Screen readers announced "plus". | Searched the markup. Not tested with a screen reader. |

Before the install step, 9 test files failed. Eight were just missing `fflate`, `jszip` and `better-sqlite3`. One was the real bug above. Worth knowing if you ever wonder why a fresh clone "fails".

## Function

1. ~~**Authentication for Server Mode.**~~ **Done, opt-in** (see above). The rest of this item stays true: it is off by default, so the default is still an open server on your network. Making it on by default would break every existing Docker setup in one go; that's a release-notes decision, not a quiet one. Original note: This is the big one. The HTTP server binds `0.0.0.0` in server mode, sets `Access-Control-Allow-Origin: *`, and I found no login or token check in front of the routes. The README says "for local network use", which is honest, but it isn't a control. Proposal: an optional access token (env var and settings field), checked by one middleware, with the bridge sending it. Opt-in first so nobody's existing Docker setup breaks.
2. ~~**Tighten CORS.**~~ **Done.** Reflects permitted origins only. Behind a proxy that rewrites `Host`, the public origin must go in `PRINTVENTORY_ALLOWED_ORIGINS`; I couldn't test a real proxy, so treat that as the likeliest thing to bite. Original note: The wildcard means any web page in your browser can talk to a Printventory on `localhost` or your LAN. The Chrome extension and MCP clients need a proper allow-list, not nothing. Do this with item 1, not separately, or something will quietly stop working.
3. ~~**Static files from the app directory.**~~ **Done as a blocklist.** An allow-list would be tighter but needs the full list of what the browser loads, and I'd rather not guess. Original note: `express.static(__dirname)` serves the app folder. Worth confirming exactly what that exposes (`package.json`, source, maybe more) and moving to an explicit public list.
4. **Synchronous file calls in `main.js`.** About 67 `*Sync(` calls in a file of roughly 15,500 lines. Fine at start-up, unkind inside a scan or request handler. Profile first, then convert the hot ones. Not before.
5. **Split the monsters.** `main.js` (about 15.5k lines) and `renderer.js` (about 26.9k). The repo already has good small modules (`folder-tree-lib.js`, `slicer-detect.js`, `print-events.js`). Keep extracting along those lines, one seam per change, tests first. Not a big-bang rewrite. Those never finish.
6. **Test the two big files.** Most tests cover the extracted modules. The risky logic is still inside `main.js`. Each extraction is a chance to add a test.

## UI / UX

1. **Keyboard and screen reader pass.** Partly done. Correction to my own first draft: the dialogs are native `<dialog>` elements, so they already get modal behaviour, Escape and the dialog role. I'd wrongly looked for `role="dialog"`. Icon-only `+` buttons now have names. Still open: arrow-key movement through the grid, two empty-looking Save buttons whose text is set by script, and `id="progress-bar"` appearing twice in `index.html`, which is invalid and makes `getElementById` pick the first.
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

1. Done in this branch: slicer fix, test runner, CI, focus and motion CSS, README, Server Mode origin policy, optional token, static blocklist, button names.
2. Next, needs a running app and a human: launch it, check the browser UI still connects with and without a token, and with a reverse proxy; build the installer and the Docker image to confirm the new file is packaged.
3. Then: duplicate `progress-bar` id, grid keyboard navigation, soft delete with undo (touches the delete path, wants careful tests), then the sync-I/O profile.
4. Ongoing: extract one module from `main.js` per change, with a test.

Nothing here is promised. It's a list. Lists are cheap. Shipping is the dear bit.
