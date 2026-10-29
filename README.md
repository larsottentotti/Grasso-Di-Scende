# Grasso di scende — mobile flashcard app

A phone-friendly version of your Nederlands ⇄ Italiano flashcard app.
Multiple Choice, Type Answer, Italian verb conjugation, text-to-speech,
and word stats — all working offline once installed.

## 1. Get it online (one-time step)

Phones need to load the app from a real web address at least once
before "Add to Home Screen" and offline mode work (this is a browser
security rule for service workers — `file://` doesn't qualify).
Easiest free option, no account needed for the app itself:

**GitHub Pages**
1. Create a new GitHub repository (public).
2. Upload every file in this folder (`index.html`, `style.css`,
   `app.js`, `sw.js`, `manifest.json`, `vocab.json`,
   `conjugations.json`, the three `icon-v2-*.png` files) to the
   repository root.
3. In the repo, go to **Settings → Pages**, set Source to
   "Deploy from branch", branch `main`, folder `/ (root)`. Save.
4. After a minute, your app is live at
   `https://<your-username>.github.io/<repo-name>/`.

Any other static host works too (Netlify, Vercel, Cloudflare Pages,
your own web server) — there's no build step, it's just static files.

## 2. Install it on your phone

1. Open the URL from step 1 in **Chrome** on your Android phone.
2. Tap the **⋮** menu → **Add to Home screen**.
3. Open it from your home screen from then on — it runs full-screen,
   works with no signal/wifi, and your progress stays on the phone.

## 3. Adding more vocab or verbs later

- **New plain vocab (any language)**: on your phone, open the app →
  **+ Import vocab or verbs** → pick the CSV. Done, no PC needed.
- **New Italian verbs**: add the rows to a CSV on your PC, run
  `export_conjugations.py` again (in the same folder as your CSVs,
  where verbecc is installed) to regenerate `conjugations.json`,
  then import *both* the CSV and the new `conjugations.json` on your
  phone the same way.
- CSV format is the same as your desktop app: a `Nederlands`/`Dutch`
  column, a second language column, and optional `Type`/`Auxiliary`
  columns. Only rows with `Type = verb` get conjugation-quizzed, and
  only if that CSV/column is Italian.

## 4. Changing the built-in vocab (vocab.json)

The phone keeps its own saved copy of the decks, so editing
`vocab.json` alone changes nothing on a phone that has already run
the app. After you change `vocab.json`, also raise `BUNDLE_VERSION`
(near the top of `app.js`) by 1 and raise the number in
`CACHE_NAME` in `sw.js` by 1. On the next start the phone swaps in the
new built-in decks, keeps the decks and words you imported yourself,
and carries your word stats over to reworded words.

## What's different from the desktop app

- No Flashcards mode (you said you only use Multiple Choice / Type
  Answer, so I left it out — happy to add it back if you want it).
- No live verb conjugation — it looks up pre-computed forms from
  `conjugations.json` instead of running verbecc (verbecc is Python
  and can't run in a phone browser).
- Text-to-speech uses your phone's built-in voices instead of
  pyttsx3.
- Word stats are scoped per-deck, same as the desktop app's
  per-CSV stats file, but stored in the browser instead of a
  `.stats.json` file.
- Progress/stats live in *this browser on this phone* — they won't
  show up on your PC or if you switch browsers.

## Files in this folder

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | The app itself |
| `sw.js` | Offline caching |
| `manifest.json` | Makes "Add to Home Screen" work like an app |
| `vocab.json` | Your bundled CSV data |
| `conjugations.json` | Pre-computed Italian verb conjugations |
| `icon-v2-*.png` | App icon |
| `export_conjugations.py` | Run on your PC to regenerate conjugations.json when you add verbs |
| `build_vocab_bundle.py` | The script I used to build vocab.json from your CSVs (reference only, not needed for the app to run) |

## Daily 10

A daily game on the home screen. Each day it picks 10 words from all Italian decks (same 10 all day, new ones tomorrow).

- **Part 1, multiple choice (Italian → Dutch):** every word is asked twice, in a random form: a verb in the present tense (any person), a noun singular or plural (always with the article). Every wrong answer makes that word come back 2 more times: the first after one other question, the second at the end of the queue. A word never waits in the queue more than 3 times (`DAILY_MAX_IN_QUEUE`).
- **Part 2, writing (Dutch → Italian):** every word once, same +2 rule on a miss.
- **Counters:** streak, done this year, done in the last 30 days (plus a 30-day strip). A day counts when both parts are finished.
- **Streak rule:** one missed day in any 7 days is forgiven. Two misses within 7 days break the streak.
- **Get 10 new words** (shown on the home card at all times) gives a fresh set of 10. Finishing it counts for the streak if you haven't finished a game yet today. The streak counts at most once per day.
- **Total games finished** counts every finished game, extra sets included.
- An unfinished game is saved; closing the app and reopening continues where you stopped.
- Tunable numbers sit at the top of `daily.js`.
- Plurals come from the `dutchPl`/`otherPl` fields in `vocab.json`. Imported decks are asked in the singular only.
- Whenever you change `vocab.json`, raise `BUNDLE_VERSION` in `app.js` and `CACHE_NAME` in `sw.js`.
- **Conjugate verbs** checkbox on the Daily card (saved on the phone). Off = verbs are asked as plain infinitives (parlare / praten). It applies to questions asked from then on.

## Backup

The Backup card on the home screen saves everything stored on the phone (decks, stats, streak, settings) to a `.json` file and restores it again. Use it before clearing site data or reinstalling.

## Recap

A second game under the Daily card, with its own streak, year/30-day counters, total, saved game, "Get 10 new words" button and "Conjugate verbs" checkbox. Same two parts as the Daily 10 (multiple choice twice, then writing, +2 repeats on a miss, max 3 waiting).

**Which words?** Only words that have already been asked in the Daily 10 (its "new words" games count too). The app keeps a record of every such word: how often it was asked and how often it was wrong (`gds.daily.seen`). Recap answers update that record but never add words to it.

**How are the 10 chosen?** Every word gets a score `1 + 4 x (wrong answers / times asked)`, so between 1 (never wrong) and 5 (always wrong); half wrong = 3. The 10 words are drawn one at a time: in each draw a word's chance is its score divided by the total score of the words still left. Hard words come up more often, easy words can still be picked, and a word is never picked twice in one game. The numbers sit at the top of `daily.js` (`RECAP_MIN_WORDS`, `RECAP_STRUGGLE_WEIGHT`).

The Recap unlocks once at least 10 different words have been in the Daily 10. Words whose entry was changed in a deck update are no longer recognised and drop out of the record.

## Backup

The record of met words and the recap streak are included in the backup file as well.
