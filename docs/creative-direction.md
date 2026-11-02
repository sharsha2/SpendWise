# Moneta — Creative Direction

Moneta should feel like a private banker for one household: calm, exact, discreet.
This document explains the brand, the design system, the motion rules and the
conversion review behind the v4 redesign, so later work stays consistent.

---

## 1. Brand

**Name.** Moneta was the Roman goddess of money; the Roman mint stood in her temple,
and "money" comes from her name. The brand borrows that idea: a trusted keeper of value.

**Promise.** *Your money, beautifully in order — and it never leaves your device.*

**Personality.** Quiet confidence. Precise, never loud. Warm, never cute.
Writes like a good accountant who is also a friend: plain words, exact numbers.

**What Moneta is not.** Not a gamified budgeting app, not a bank, not a data broker.

## 2. Audience

| Who | What they want | What they fear |
|---|---|---|
| **Couples and households** who share costs (the core: two people, one budget) | Who paid what, settle up fairly, see the month at a glance | Arguments about money, losing track |
| **Spreadsheet keepers** with years of monthly Excel files | Keep their files; get dashboards and reports on top | Re-typing everything into a new app |
| **Privacy-minded professionals** | Insight without giving a third party their bank login | Data leaks, ads, subscriptions |

They are busy and competent. They value design that respects their time, and they
judge trust in seconds.

## 3. Competitors and how to outperform them

| Competitor type | Strength | Where Moneta wins |
|---|---|---|
| Subscription budgeting apps (YNAB-style) | Strong method, loyal users | No subscription, no method to learn, works with existing Excel files |
| Polished bank-linked dashboards (Monarch Money / Copilot Money style) | Beautiful, automatic | **No bank login, nothing uploaded**, works offline, data stays in the user's own files |
| Bill/subscription trackers (Rocket Money style) | Finds subscriptions | Moneta also finds subscriptions — without connecting accounts |
| Spreadsheet templates (Excel, Google Sheets, Tiller) | Full control | Same files, plus dashboards, PDF reports, couples' settle-up, statement import |

*Competitive notes reflect general market knowledge, not fresh research; check
current pricing and features before using them in marketing.*

**Positioning line:** *The elegance of a premium finance app, with the privacy and
ownership of your own spreadsheet.*

## 4. The first three seconds

The visitor should feel, in order:

1. **Calm** — generous space, ivory and onyx, one headline. Nothing blinks.
2. **Quality** — an editorial serif, a coin-mark logo, hairline gold rules.
3. **Safety** — "Stays on this device · No bank login · Works offline" is visible
   without scrolling.
4. **Clarity of the next step** — one filled button, one outline button, one link.

If any of these takes longer than three seconds to register, the first screen is too busy.

## 5. Visual identity

**Logo.** A minted coin: deep emerald field, champagne rim, a fine milled inner ring,
and a serifed **M** whose centre is a "V" (a quiet ledger tick). Built from
filled shapes so it stays crisp from 16 px to app-icon size. Files: `icon.svg`,
`icon-180.png`, `icon-512.png` (PNG icons are full-bleed; phones round them).

**Colour.** All text colours pass WCAG AA (4.5:1) on the surface they sit on.

| Role | Day (ivory) | Night (onyx) |
|---|---|---|
| Page | `#F6F3ED` | `#0B0C0E` |
| Surface | `#FFFDF9` | `#131518` |
| Ink | `#141311` / body `#2B2925` | `#F6F2EA` / body `#E9E4DA` |
| Muted | `#6E685E` | `#A39D92` |
| Brand emerald | `#0F4C3F` | `#5FC3A6` |
| Champagne (text on cards only) | `#8C6A2F` | `#CFAE6E` |
| Hairline gold (ornament only) | `#CDB78A` | `#6B5A3A` |
| Income / spend | `#047857` / `#B42318` | `#4CC38A` / `#F0877B` |

Chart colours keep the separately validated colour-blind-safe palette; luxury is
expressed through type, space and hairlines, never by weakening data colours.

**Type.** *Fraunces* (variable, self-hosted) for headlines, section titles and the
big numbers; *Inter* for everything you read or type — labels, tables, inputs.
Numbers use tabular figures so columns line up.

**Details.** 1 px hairlines instead of heavy borders; champagne rings around icons;
20 px card radius; soft, long shadows; uppercase eyebrows with wide tracking.

## 6. Page structure and scroll story

The app is one page. Read top to bottom, it tells a story:

1. **Header** — the mark, and the three places you can go (Reports, Compare, Settings).
2. **Hero (no data yet)** — the promise, then the choice: *Upload*, *Add*, or *Explore
   with sample data*. Trust row underneath.
3. **Overview (with data)** — reminders first (what needs you), then four numbers
   (spent, income, net, savings rate), then *why* (categories, pace, trend, stores),
   then *people* (goals, settle up), then *plans* (budgets).
4. **Add a transaction** — the one form you use daily.
5. **Transactions** — the ledger, grouped by day, with Save and Upload at the top.
6. **Footer** — the privacy promise, repeated where people finish reading.

The story moves from *how am I doing* → *why* → *what do I do next*.

## 7. Motion system

One vocabulary, defined as CSS custom properties:

| Token | Value | Used for |
|---|---|---|
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | Arrivals: fast start, soft landing |
| `--ease-std` | `cubic-bezier(.2,0,0,1)` | State changes |
| `--dur-1` | 140 ms | Hover, press |
| `--dur-2` | 240 ms | Menus, toggles |
| `--dur-3` | 420 ms | Dialogs, sheets, toasts |
| `--dur-hero` | 900 ms | First impression only |
| `--stagger` | 70 ms | Sequenced arrivals |

**Entry (once per visit).** Header fades in; the hero arrives as a sequence —
eyebrow, headline, sentence, buttons, link, trust row — each rising 14 px, 70 ms apart.
It plays once per browser session, never on later reloads.

**Reveal (when new data arrives).** Uploading a file, opening sample data or restoring
unsaved work: KPI tiles then panels settle in, 55 ms apart. It happens because
something new arrived — not on every update.

**Page transitions.** Dialogs rise 10 px from 98.5 % scale while the backdrop fades.
The phone add form slides up as a sheet. Switching month crossfades the overview.
Switching theme spreads the new theme in a circle from the button you pressed
(View Transitions API; instant where unsupported).

**Motion with meaning.**
- Totals *count* to their new value when they change, so you see the direction of change.
- Budget bars *fill* to their level.
- A toast *rises* to confirm an action and offer Undo.

**Never moves.** Table rows, form fields, filters, search results and chart data while
you work; nothing animates while you type. Dashboard charts redraw instantly.

**Removed because it slowed people down.** Hover "lift" on cards and pills, page-load
fades on every section, bouncy toasts, and long chart animations on the dashboard.

**Reduced motion.** With *Reduce motion* turned on in the OS, every animation and
transition above is switched off.

## 8. Technology

Plain HTML, CSS custom properties and vanilla JavaScript — no framework, no build step,
no third-party requests. Fonts, icons, charts (Chart.js), Excel (SheetJS) and PDF
reading (pdf.js) are self-hosted in `vendor/` with integrity-checked copies.
Motion uses CSS animations, the View Transitions API (progressive enhancement) and
`requestAnimationFrame` for number counting. A network-first service worker makes the
app work offline. A strict Content-Security-Policy allows only the app's own files.

## 9. Conversion review (CRO)

Moneta has no sign-up, so "conversion" means **activation**: a first-time visitor
reaches their own numbers. Funnel: *land → understand → choose a start → see insight
→ save*.

### Findings and changes made

| # | Finding | Change |
|---|---|---|
| 1 | The first screen asked for a file before showing any value — the biggest drop-off risk | **Explore with sample data**: the full app with realistic data in one click, clearly labelled and never saved |
| 2 | Three equal cards gave no clear first step | One **primary** action (Upload Excel or bank PDF), one secondary (Add a transaction), one low-commitment link (sample data) |
| 3 | The headline described features, not the benefit | Benefit headline *"Your money, beautifully in order."* plus one sentence answering *what, who, from what* |
| 4 | Privacy — the key differentiator — was a small line at the bottom | Trust row under the buttons, repeated in the footer |
| 5 | "Upload" next to "nothing is uploaded" read as a contradiction | Copy now says files are *read on this device* |
| 6 | Filters and an empty table competed with the first step | Hidden until there is data |
| 7 | Mobile: buttons side by side and small | Full-width stacked buttons, 54 px tall |
| 8 | Brand looked generic (teal gradient, wallet icon) | New coin-mark logo and identity built for trust |

### Recommended next

1. **Sample → own data nudge**: after two minutes in sample mode, a gentle card
   *"Like what you see? Upload your own file"* (the banner already offers it).
2. **First-save moment**: after the first Save, a one-time tip about keeping files in
   iCloud Drive / Google Drive for use on phone and Mac.
3. **Landing page for sharing** (if Moneta is offered to others): the same hero, three
   screenshots (overview, PDF report, settle-up), and a short FAQ on privacy.

### Measuring without tracking

Moneta deliberately has no analytics. Measure with five-person usability sessions:
time to first insight (target under 60 s with sample data), share of people who find
the primary button without help, and whether they can explain the privacy promise
after one look.
