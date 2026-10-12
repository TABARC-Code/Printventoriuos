# Customer quote page

A simple page customers can use to get a price and send you a request. They pick something from your catalogue, choose how many, see a quote, type an email address, and it lands in **Quote requests** in the app. That is all it does, on purpose.

*TABARC-Code, 12 October 2026.*

## How a customer uses it

1. Open `http://your-server:5000/kiosk` (Server Mode). Search or browse the items you've chosen to offer.
2. Pick one, choose a quantity, press **Get my quote**.
3. See the price (or, if you've switched that off, a note that you'll email one), and enter an email address. Name and a message are optional.
4. Press **Send my request**. They get a reference number to quote if they contact you. The screen then clears itself.

The customer's device keeps nothing. No cookies, no local storage, no session. The page clears after it has been left alone for a while, and after each order, so the next person doesn't see the last one's details.

## How you run it

Open **Quote requests** (Tools menu, or the web menu; a shortcut appears under the library buttons once it's on).

- **Settings.** The switch is off until you turn it on. While it's off every address under `/kiosk` answers "not available". You can also set the page title and welcome text, whether customers see the price, how long a quote is valid, a minimum charge, how long before the screen clears, how long requests are kept, and an optional webhook.
- **Catalogue.** Only models you add here are shown to customers. For each you enter the print time and filament weight per plate, how many fit on a plate, and a filament. The dialog shows you what a customer would be quoted and what it costs you. The model's licence is shown beside it, because you need to be allowed to sell prints of it. I can't tell you whether you are.
- **Requests.** Each shows what they asked for, the quote, their email address and message, plus **your** cost and profit (customers never see those). A status you set (new, quoted, accepted, declined, done), a **Reply by email** link that opens your mail program with the quote filled in, and **Delete**.

New requests can also be sent to a webhook as JSON. A Discord or Slack webhook address works as it is. There's no built-in email sending: that would need your mail password stored in the app, and I'd rather give you the inbox and the webhook than a half-secure mailer.

## Where the price comes from

From the **Farm Cost Calculator**, using the average of your printers that are in service. The server works the price out; the customer's screen only shows it, so there's no price in the page to tamper with. The customer pays for whole plates: ask for 3 of something that prints 4 to a plate and the quote covers the plate, spread over the 3.

It refuses to quote until the calculator has real numbers: at least one printer in service with a purchase price, and at least one filament with a spool price. Otherwise it would be quoting placeholder money to a member of the public. The Settings tab tells you what's missing.

## Why it's built the way it is

- **It is not the admin interface with buttons hidden.** The admin app talks over a WebSocket that can delete files and change settings. The customer page never touches it. It has five small endpoints (`/api/kiosk/config`, `catalogue`, `thumb`, `quote`, `submit`) and a fixed list of files it will serve. If every one of them had a bug, the worst outcome is a junk quote request.
- **Public, but not on the admin's terms.** The customer routes are mounted before the access token check (customers don't have the token) and before the 50 MB request parser (they accept 8 KB). Everything else on the server still needs the token. `kiosk-server.test.js` checks both, and checks that `main.js` keeps them in that order.
- **No cost or margin leaves the server.** Quotes live in server memory under a random id; the page holds only that id. A test checks no response mentions cost, profit or margin.
- **Small abuse protection.** A request cap per device, a hidden field that bots fill in (they get a convincing reply and nothing is stored), an 8 KB limit, an email check, and single-use quotes.
- **Personal data.** The only thing stored about a customer is what they typed: an email address, optionally a name and a message. It is deleted after your retention period (default 180 days, checked at start-up and every six hours). Tell your customers what you do with it; the privacy line on the page is yours to word. This isn't legal advice.

## If you put a screen in front of customers

- Run **Server Mode** and open `/kiosk` from the customer's device. The desktop app only listens on the machine it runs on.
- **Set an access token** (`PRINTVENTORY_ACCESS_TOKEN`, see the README). With none, anyone who can reach the server can also open the admin interface. The Settings tab warns you if the token is missing.
- Use HTTPS or a trusted network. The customer's email address travels over whatever connection they use.
- Lock the device itself down with the operating system (a browser in kiosk mode, or the tablet's single-app mode). The page can't stop someone leaving the browser; that's the device's job.

## Not included

Payment, customer file uploads, customer accounts, email sending, and a page for customers to check on their order. Each turns a quote form into a more serious piece of software (card data, malware in uploaded files, passwords, mail credentials). They can be added one at a time if you decide you need them.

## Checked, and not

Tested: 21 unit tests of the quote logic and HTTP behaviour against a real in-memory database; a test of the mount order; a browser test of the whole customer flow (including that the browser is left with no cookies or storage, that an idle half-finished order is cleared, and that nothing leaves the server); a browser test of the admin side against the real handlers (including that hostile text from a customer can't inject anything); axe-core reports no violations on all four customer screens.

Not checked: the Electron desktop app (no Electron here), a real Discord or Slack webhook, a real phone or tablet, and a real library with real thumbnails.

Author: TABARC-Code
