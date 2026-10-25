'use strict';

/* ============================================================
   DAILY 10

   Every day: 10 words picked from all the Italian decks.
     1. Multiple choice, Italian -> Dutch. Each word is asked twice.
        Every wrong answer adds 2 more asks of that word.
     2. Writing, Dutch -> Italian. Each word once; wrong answers add
        2 more asks, same as above.
   Finishing both parts counts the day. The streak allows one missed
   day in any 7.

   This file only uses what app.js already defines (state, speak,
   toast, showView, splitInfinitive, getBaseForms, ...), so it has to
   be loaded after app.js.
   ============================================================ */

/* ---- the numbers you may want to change ---- */
const DAILY_WORD_COUNT = 10;
const DAILY_MC_ROUNDS = 2;            // times each word is asked in multiple choice
const DAILY_WRITTEN_ROUNDS = 1;       // times each word is asked in writing
const DAILY_EXTRA_ASKS_PER_MISS = 2;  // extra asks added by every wrong answer
const DAILY_TENSES = ["present"];     // tenses used for verbs; add "past_perfect", "imperfect", "future" to widen
const DAILY_MAX_IN_QUEUE = 3;         // a word never waits in the queue more than this many times
const DAILY_FREE_MISS_WINDOW = 7;     // at most one missed day in any 7 days

const LS_DAILY_HISTORY = "gds.daily.history";
const LS_DAILY_CONJ = "gds.daily.conjugate";
const LS_DAILY_TOTAL = "gds.daily.total";
const LS_DAILY_SESSION = "gds.daily.session";

const DAILY_KIND_ORDER = { verb: 0, noun: 1, plain: 2 };
const DAILY_NOUN_ARTICLE_RE = /^(il|lo|la|i|gli|le)\s+|^l'/;

// tests replace this to pretend it is another day
let dailyClock = () => new Date();

const daily = {
  ctx: null,
  session: null,
  wired: false,
};

/* ============================================================
   DATES, HISTORY, STREAK
   ============================================================ */

function dailyDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// days since 1970 for a "YYYY-MM-DD" key (UTC maths, so daylight saving
// can never make a day 23 or 25 hours long)
function dailyDayNumber(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function dailyToday() {
  return dailyDateKey(dailyClock());
}

function dailyLoadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_DAILY_HISTORY) || "[]");
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)))].sort();
  } catch (e) {
    return [];
  }
}

function dailySaveHistory(list) {
  localStorage.setItem(LS_DAILY_HISTORY, JSON.stringify(list));
}

// Walk back from today (or yesterday if today isn't played yet). A missed
// day is forgiven unless another missed day lies within 7 days of it -
// i.e. at most one miss in any 7 days. Streak = days actually played.
function dailyComputeStreak(played, todayNumber) {
  if (!played.size) return 0;
  const first = Math.min(...played);
  let cursor = played.has(todayNumber) ? todayNumber : todayNumber - 1;
  let streak = 0;
  let lastMiss = null;

  while (cursor >= first) {
    if (played.has(cursor)) {
      streak += 1;
    } else {
      if (lastMiss !== null && lastMiss - cursor < DAILY_FREE_MISS_WINDOW) break;
      lastMiss = cursor;
    }
    cursor -= 1;
  }
  return streak;
}

function dailyComputeStats(history, todayKey) {
  const played = new Set(history.map(dailyDayNumber));
  const t = dailyDayNumber(todayKey);
  const year = todayKey.slice(0, 4);

  return {
    streak: dailyComputeStreak(played, t),
    thisYear: history.filter(k => k.startsWith(year)).length,
    last30: history.filter(k => {
      const n = dailyDayNumber(k);
      return n <= t && n > t - 30;
    }).length,
    playedToday: played.has(t),
    strip: Array.from({ length: 30 }, (_, i) => played.has(t - 29 + i)),
  };
}

/* ============================================================
   SMALL HELPERS
   ============================================================ */

function dailyNorm(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[’‘ʼ`´]/g, "'")
    .replace(/'\s+/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function dailyTokens(s) {
  return String(s || "").split("/").map(t => t.trim()).filter(Boolean);
}

function dailyShuffle(array, rng = Math.random) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dailySeededRng(text) {
  // xmur3 hash -> mulberry32
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^ (h >>> 16)) >>> 0;

  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dailyEntryKey(setId, pair) {
  return `${setId}::${pair.dutch}||${pair.other}`;
}

function dailyMapAdd(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

/* ============================================================
   THE WORD POOL
   ============================================================ */

function dailyMakeEntry(set, pair) {
  const type = normalizeHeader(pair.type);
  let kind = "plain";
  let lemma = dailyNorm(pair.other);

  if (VERB_TYPES.has(type)) {
    const { base } = splitInfinitive(pair.other);
    if (state.conjugations[base]) kind = "verb";
  } else if (type === "noun") {
    kind = "noun";
    lemma = lemma.replace(DAILY_NOUN_ARTICLE_RE, "");
  }

  return {
    key: dailyEntryKey(set.id, pair),
    setId: set.id,
    pair,
    kind,
    lemma,
    hasPlural: kind === "noun" && !!pair.otherPl && !!pair.dutchPl,
  };
}

function dailyBuildContext() {
  const entries = [];

  for (const set of state.sets) {
    // only decks whose second column is Italian
    if (!ITALIAN_NAMES.has(normalizeHeader(set.language2))) continue;
    for (const pair of set.pairs) entries.push(dailyMakeEntry(set, pair));
  }

  const byKey = new Map(entries.map(e => [e.key, e]));

  // What counts as correct. Several words can share a translation
  // (het dorp / het land -> il paese), so every answer is looked up
  // across ALL words, not just the one that was picked.
  const itToNl = new Map();         // italian text -> dutch texts
  const nlToIt = new Map();         // dutch text   -> italian texts
  const verbItToNl = new Map();     // infinitive   -> dutch infinitives
  const verbNlToEntries = new Map();
  const pools = new Map();          // where wrong options come from

  const addVariant = (it, nl) => {
    dailyMapAdd(itToNl, dailyNorm(it), nl);
    for (const tok of dailyTokens(it)) dailyMapAdd(itToNl, dailyNorm(tok), nl);
    dailyMapAdd(nlToIt, dailyNorm(nl), it);
  };

  for (const e of entries) {
    const p = e.pair;

    if (e.kind === "verb") {
      dailyMapAdd(verbItToNl, dailyNorm(p.other), p.dutch);
      dailyMapAdd(verbNlToEntries, dailyNorm(p.dutch), e);
    } else {
      addVariant(p.other, p.dutch);
      if (e.hasPlural) addVariant(p.otherPl, p.dutchPl);
    }

    const poolKey = e.kind === "plain" ? "plain:" + e.setId : e.kind;
    if (!pools.has(poolKey)) pools.set(poolKey, []);
    pools.get(poolKey).push(e);
  }

  return { entries, byKey, itToNl, nlToIt, verbItToNl, verbNlToEntries, pools };
}

// Picks the day's words. Each deck is equally likely (so a 988-word list
// can't crowd out the verbs and nouns), and no word appears twice even
// if two decks both contain it (the richer noun/verb entry wins).
function dailyPickWords(entries, rng, count) {
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => DAILY_KIND_ORDER[a.e.kind] - DAILY_KIND_ORDER[b.e.kind] || a.i - b.i)
    .map(x => x.e);

  const seen = new Set();
  const bySet = new Map();
  for (const e of ordered) {
    if (seen.has(e.lemma)) continue;
    seen.add(e.lemma);
    if (!bySet.has(e.setId)) bySet.set(e.setId, []);
    bySet.get(e.setId).push(e);
  }

  const setIds = [...bySet.keys()].sort();
  const picked = [];

  while (picked.length < count && setIds.length) {
    const si = Math.floor(rng() * setIds.length);
    const list = bySet.get(setIds[si]);
    const ei = Math.floor(rng() * list.length);
    picked.push(list.splice(ei, 1)[0]);
    if (!list.length) setIds.splice(si, 1);
  }
  return picked;
}

/* ============================================================
   FORMS: which verb form / singular or plural gets asked
   ============================================================ */

function dailyFlattenTokens(strings) {
  const seen = new Set();
  const out = [];
  for (const s of strings) {
    for (const tok of dailyTokens(s)) {
      const key = dailyNorm(tok);
      if (!seen.has(key)) { seen.add(key); out.push(tok); }
    }
  }
  return out;
}

function dailyExpandAnswers(strings) {
  const out = new Set();
  for (const s of strings) {
    out.add(s);
    for (const tok of dailyTokens(s)) out.add(tok);
  }
  return [...out];
}

// every accepted way to write one tense + person of one verb
function dailyVerbAnswers(pair, tenseKey, person) {
  const { base, remainder } = splitInfinitive(pair.other);
  const raw = getBaseForms(base, tenseKey);
  if (!raw) return [];

  const out = [];
  for (const form of raw) {
    if (getPersonPrefix(form) !== person) continue;
    for (const alt of expandAlternates(stripPersonPrefix(form, person))) {
      out.push(attachRemainder(alt, remainder));
    }
  }
  return out;
}

function dailyBasicForm(entry, ctx, wi, it, nl, plural) {
  const nlOptions = dailyFlattenTokens([...(ctx.itToNl.get(dailyNorm(it)) || []), nl]);
  const itAnswers = dailyExpandAnswers([...(ctx.nlToIt.get(dailyNorm(nl)) || []), it]);

  return {
    wi,
    kind: entry.kind,
    tenseKey: null,
    person: null,
    plural,
    itQuestion: it,
    nlPrompt: nl,
    itAnswers,
    nlOptions,
    correct: null,
    choices: null,
  };
}

function dailyVerbForm(entry, ctx, wi) {
  const pair = entry.pair;
  const { base } = splitInfinitive(pair.other);

  let tenseKey = null;
  let raw = null;
  for (const t of dailyShuffle(TENSES.map(x => x.key).filter(k => DAILY_TENSES.includes(k)))) {
    const forms = getBaseForms(base, t);
    if (forms && forms.length) { tenseKey = t; raw = forms; break; }
  }

  const persons = raw ? [...new Set(raw.map(getPersonPrefix).filter(Boolean))] : [];
  if (!persons.length) return dailyBasicForm(entry, ctx, wi, pair.other, pair.dutch, false);

  const person = pickRandom(persons);
  const own = dailyVerbAnswers(pair, tenseKey, person);

  // other verbs with the same Dutch meaning are accepted too
  const answers = new Set(own);
  for (const other of ctx.verbNlToEntries.get(dailyNorm(pair.dutch)) || []) {
    for (const a of dailyVerbAnswers(other.pair, tenseKey, person)) answers.add(a);
  }

  const nlOptions = dailyFlattenTokens([
    pair.dutch,
    ...(ctx.verbItToNl.get(dailyNorm(pair.other)) || []),
  ]);

  return {
    wi,
    kind: "verb",
    tenseKey,
    person,
    plural: false,
    itQuestion: `${person} ${own[0]}`,
    nlPrompt: pair.dutch,
    itAnswers: [...answers],
    nlOptions,
    correct: null,
    choices: null,
  };
}

// "Conjugate verbs" checkbox on the home card (default on). Off = verbs are
// asked as plain infinitives. Applies to questions made from now on.
function dailyConjugateOn() {
  try { return localStorage.getItem(LS_DAILY_CONJ) !== "0"; } catch (e) { return true; }
}

function dailyMakeForm(entry, ctx, wi) {
  if (entry.kind === "verb" && dailyConjugateOn()) return dailyVerbForm(entry, ctx, wi);

  if (entry.kind === "noun") {
    const usePlural = entry.hasPlural && Math.random() < 0.5;
    const p = entry.pair;
    return dailyBasicForm(
      entry, ctx, wi,
      usePlural ? p.otherPl : p.other,
      usePlural ? p.dutchPl : p.dutch,
      usePlural
    );
  }

  return dailyBasicForm(entry, ctx, wi, entry.pair.other, entry.pair.dutch, false);
}

/* ============================================================
   MULTIPLE CHOICE OPTIONS (Italian -> Dutch)
   ============================================================ */

function dailyBuildChoices(entry, form, ctx) {
  const wantPlural = entry.kind === "noun" && form.plural;
  const poolKey = entry.kind === "plain" ? "plain:" + entry.setId : entry.kind;

  const taken = new Set(form.nlOptions.map(dailyNorm));
  const wrong = [];

  const dutchFor = (cand) => {
    if (cand.kind === "noun" && wantPlural) {
      return cand.hasPlural ? cand.pair.dutchPl : null;
    }
    return cand.pair.dutch;
  };

  const take = (candidates) => {
    for (const cand of dailyShuffle(candidates)) {
      if (wrong.length >= 3) break;
      if (cand === entry) continue;

      const text = dutchFor(cand);
      if (!text) continue;

      // a word whose meaning overlaps the right answer would be unfair
      const toks = dailyTokens(text);
      if (!toks.length || toks.some(t => taken.has(dailyNorm(t)))) continue;

      wrong.push(pickRandom(toks));
      toks.forEach(t => taken.add(dailyNorm(t)));
    }
  };

  take(ctx.pools.get(poolKey) || []);
  if (wrong.length < 3) take(ctx.entries);

  const correct = pickRandom(form.nlOptions);
  form.correct = correct;
  return dailyShuffle([correct, ...wrong]);
}

/* ============================================================
   THE QUEUE
   ============================================================ */

// `rounds` passes over all words, each pass in a fresh random order
function dailyBuildQueue(wordCount, rounds, rng = Math.random) {
  const queue = [];
  for (let r = 0; r < rounds; r++) {
    const order = dailyShuffle(Array.from({ length: wordCount }, (_, i) => i), rng);
    if (queue.length && wordCount > 1 && order[0] === queue[queue.length - 1]) {
      [order[0], order[1]] = [order[1], order[0]];
    }
    queue.push(...order);
  }
  return queue;
}

// A wrong answer adds up to DAILY_EXTRA_ASKS_PER_MISS copies of the word,
// but a word never has more than DAILY_MAX_IN_QUEUE copies waiting.
// The first new copy comes after exactly one other question; the second
// goes to the very end of the queue. (Call after the asked word is removed.)
function dailyInsertRetries(queue, wi) {
  const waiting = queue.filter(x => x === wi).length;
  const toAdd = Math.max(0, Math.min(DAILY_EXTRA_ASKS_PER_MISS, DAILY_MAX_IN_QUEUE - waiting));
  for (let k = 0; k < toAdd; k++) {
    if (k === 0) {
      let pos = Math.min(1, queue.length);
      while (pos < queue.length && (queue[pos] === wi || queue[pos - 1] === wi)) pos++;
      queue.splice(pos, 0, wi);
    } else {
      queue.push(wi);
    }
  }
}

/* ============================================================
   SESSION (saved after every answer so the app can be closed)
   ============================================================ */

function dailySaveSession() {
  const s = daily.session;
  if (!s || s.practice) return;
  try {
    localStorage.setItem(LS_DAILY_SESSION, JSON.stringify(s));
  } catch (e) { /* storage full or blocked: the game still works */ }
}

function dailyClearSession() {
  try { localStorage.removeItem(LS_DAILY_SESSION); } catch (e) { /* ignore */ }
}

// returns today's saved game, or null (and tidies up an old one)
function dailyLoadSession(today) {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_DAILY_SESSION) || "null"); } catch (e) { s = null; }
  if (!s || s.date !== today || s.practice) {
    if (s) dailyClearSession();
    return null;
  }
  return s;
}

function dailyValidSession(s, ctx) {
  if (!s || !Array.isArray(s.words) || !s.words.length) return false;
  if (s.phase !== "mc" && s.phase !== "written") return false;
  if (!Array.isArray(s.queue) || !Array.isArray(s.wrong)) return false;
  if (!s.words.every(w => ctx.byKey.has(dailyEntryKey(w.setId, w)))) return false;
  return s.queue.every(i => Number.isInteger(i) && i >= 0 && i < s.words.length);
}

function dailyWordEntry(wi) {
  const w = daily.session.words[wi];
  return daily.ctx.byKey.get(dailyEntryKey(w.setId, w));
}

/* ============================================================
   GAME FLOW  (no screen code in here)
   ============================================================ */

function dailyStart({ practice = false } = {}) {
  daily.ctx = dailyBuildContext();

  const today = dailyToday();
  const seed = practice ? `${today}:${Date.now()}` : today;
  const picked = dailyPickWords(daily.ctx.entries, dailySeededRng("gds-daily:" + seed), DAILY_WORD_COUNT);

  if (!picked.length) {
    toast("No Italian words to practise yet");
    return;
  }

  daily.session = {
    date: today,
    practice,
    words: picked.map(e => ({ setId: e.setId, dutch: e.pair.dutch, other: e.pair.other })),
    phase: "mc",
    queue: dailyBuildQueue(picked.length, DAILY_MC_ROUNDS),
    form: null,
    answered: false,
    intro: false,
    wrong: picked.map(() => 0),
    totals: { mcAsked: 0, mcWrong: 0, wAsked: 0, wWrong: 0 },
  };

  dailySaveSession();
  showView("view-daily");
  dailyAdvance();
}

function dailyResume(saved) {
  daily.ctx = dailyBuildContext();

  if (!dailyValidSession(saved, daily.ctx)) {
    // the decks changed under a half-finished game: start today's again
    dailyClearSession();
    dailyStart();
    return;
  }

  daily.session = saved;
  showView("view-daily");

  if (saved.intro) dailyRenderIntro();
  else if (saved.form && !saved.answered) dailyRenderQuestion();
  else dailyAdvance();
}

// moves on to the next question, or to the next part, or finishes
function dailyAdvance() {
  const s = daily.session;

  if (!s.queue.length) {
    if (s.phase === "mc") dailyStartWritten();
    else dailyFinish();
    return;
  }

  const wi = s.queue[0];
  const entry = dailyWordEntry(wi);
  const form = dailyMakeForm(entry, daily.ctx, wi);
  if (s.phase === "mc") form.choices = dailyBuildChoices(entry, form, daily.ctx);

  s.form = form;
  s.answered = false;
  dailySaveSession();
  dailyRenderQuestion();
}

function dailyStartWritten() {
  const s = daily.session;
  s.phase = "written";
  s.queue = dailyBuildQueue(s.words.length, DAILY_WRITTEN_ROUNDS);
  s.form = null;
  s.answered = false;
  s.intro = true;
  dailySaveSession();
  dailyRenderIntro();
}

function dailyBeginWritten() {
  daily.session.intro = false;
  dailyAdvance();
}

// Records one answer: stats, retries, totals. Returns true if it was right.
function dailyCommit(ok) {
  const s = daily.session;
  const wi = s.queue.shift();
  const entry = dailyWordEntry(wi);

  recordWordResultFor(entry.setId, entry.pair, ok);

  const prefix = s.phase === "mc" ? "mc" : "w";
  s.totals[prefix + "Asked"] += 1;

  if (!ok) {
    s.totals[prefix + "Wrong"] += 1;
    s.wrong[wi] += 1;
    dailyInsertRetries(s.queue, wi);
  }

  s.answered = true;
  dailySaveSession();
  return ok;
}

function dailyAnswerChoice(choice) {
  const s = daily.session;
  if (!s || s.answered || s.phase !== "mc") return;

  const valid = new Set(s.form.nlOptions.map(dailyNorm));
  const ok = valid.has(dailyNorm(choice));
  dailyCommit(ok);
  dailyRenderAnswer(ok, choice);
}

function dailyAnswerTyped(text) {
  const s = daily.session;
  if (!s || s.answered || s.phase !== "written") return;

  let typed = dailyNorm(text);
  if (!typed) return;

  // typing the pronoun as well ("io parlo") is fine too
  const f = s.form;
  if (f.person && typed.startsWith(f.person + " ")) typed = typed.slice(f.person.length + 1);

  const ok = f.itAnswers.some(a => dailyNorm(a) === typed);
  dailyCommit(ok);
  dailyRenderAnswer(ok, text);
}

// Total number of finished games (every finished game counts, extra sets too).
// Days played before this counter existed are used as the starting value.
function dailyLoadTotal() {
  let stored = 0;
  try { stored = parseInt(localStorage.getItem(LS_DAILY_TOTAL), 10) || 0; } catch (e) {}
  return Math.max(stored, dailyLoadHistory().length);
}
function dailySaveTotal(n) {
  try { localStorage.setItem(LS_DAILY_TOTAL, String(n)); } catch (e) {}
}

function dailyFinish() {
  const s = daily.session;
  s.phase = "done";

  // Any finished game counts for the streak, but only once per day.
  const newTotal = dailyLoadTotal() + 1;   // read before the history changes
  const history = dailyLoadHistory();
  s.alreadyCounted = history.includes(s.date);
  if (!s.alreadyCounted) {
    history.push(s.date);
    history.sort();
    dailySaveHistory(history);
  }
  dailySaveTotal(newTotal);

  dailyClearSession();
  dailyRenderDone();
  showView("view-daily-done");
}

/* ============================================================
   SCREENS
   ============================================================ */

function dEl(id) {
  return document.getElementById(id);
}

function dailyRenderStats(prefix, stats) {
  dEl(prefix + "-streak").textContent = stats.streak;
  dEl(prefix + "-year").textContent = stats.thisYear;
  dEl(prefix + "-30").textContent = stats.last30;
  dEl(prefix + "-total").textContent = dailyLoadTotal();

  const strip = dEl(prefix + "-strip");
  strip.innerHTML = "";
  stats.strip.forEach((on, i) => {
    const cell = document.createElement("span");
    cell.className = (on ? "on" : "") + (i === stats.strip.length - 1 ? " today" : "");
    strip.appendChild(cell);
  });
}

function renderDailyHome() {
  if (!daily.wired) return;

  const today = dailyToday();
  const stats = dailyComputeStats(dailyLoadHistory(), today);
  dailyRenderStats("dh", stats);

  const saved = dailyLoadSession(today);
  const status = dEl("dh-status");
  const start = dEl("dh-start");
  const practice = dEl("dh-practice");
  practice.textContent = "Get 10 new words";

  status.className = "daily-status";

  if (stats.playedToday) {
    status.textContent = "Done for today ✓";
    status.className = "daily-status done";
    start.hidden = true;
    practice.hidden = false;
  } else if (saved) {
    status.textContent = `${saved.queue.length} to go`;
    start.textContent = "Continue today's 10";
    start.hidden = false;
    practice.hidden = false;
  } else {
    status.textContent = stats.streak > 0 ? "Play today to keep your streak" : "";
    start.textContent = "Play today's 10";
    start.hidden = false;
    practice.hidden = false;
  }
}

function dailyShowPanel(name) {
  dEl("d-intro").hidden = name !== "intro";
  dEl("d-play").hidden = name !== "play";
}

function dailyRenderHeader() {
  const s = daily.session;
  dEl("d-phase").textContent = s.phase === "mc"
    ? "Multiple choice · Italian → Dutch"
    : "Write it · Dutch → Italian";
  dEl("d-left").textContent = s.practice
    ? `Practice · ${s.queue.length} to go`
    : `${s.queue.length} to go`;
}

function dailyRenderIntro() {
  const s = daily.session;
  dailyShowPanel("intro");
  dailyRenderHeader();

  const t = s.totals;
  dEl("d-intro-text").textContent =
    `${t.mcAsked} questions answered, ${t.mcWrong} wrong. ` +
    `Now write each word in Italian — Dutch is shown, you type the Italian` +
    (s.words.some((w, i) => dailyWordEntry(i).kind === "noun") ? ", with the article." : ".");
}

function dailyRenderQuestion() {
  const s = daily.session;
  const f = s.form;
  const isMc = s.phase === "mc";

  dailyShowPanel("play");
  dailyRenderHeader();

  const pill = dEl("d-pill");
  if (f.kind === "verb" && f.tenseKey) {
    const tense = TENSES.find(t => t.key === f.tenseKey);
    pill.textContent = tense ? tense.label : "";
    pill.hidden = !tense;
  } else {
    pill.hidden = true;
  }

  dEl("d-question").textContent = isMc ? f.itQuestion : f.nlPrompt;
  dEl("d-feedback").textContent = "";
  dEl("d-feedback").className = "feedback-text";
  dEl("d-next").hidden = true;
  dEl("d-speak-q").hidden = !isMc;
  dEl("d-speak-a").hidden = true;

  const choices = dEl("d-choices");
  const typeArea = dEl("d-type");
  choices.hidden = !isMc;
  typeArea.hidden = isMc;

  if (isMc) {
    choices.innerHTML = "";
    for (const text of f.choices) {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.textContent = text;
      btn.addEventListener("click", () => dailyAnswerChoice(text));
      choices.appendChild(btn);
    }
  } else {
    const person = dEl("d-person");
    person.textContent = f.person || "";
    person.hidden = !f.person;

    const input = dEl("d-input");
    input.value = "";
    input.disabled = false;
    input.className = "";
    dEl("d-check").disabled = false;
    setTimeout(() => input.focus(), 50);
  }
}

function dailyRenderAnswer(ok, given) {
  const s = daily.session;
  const f = s.form;
  const isMc = s.phase === "mc";
  const left = s.queue.length;

  const feedback = dEl("d-feedback");
  let message;

  if (ok) {
    message = "Correct!";
  } else {
    const answer = isMc
      ? f.nlOptions.join(" / ")
      : (f.person ? `${f.person} ${f.itAnswers[0]}` : f.itAnswers[0]);
    const n = DAILY_EXTRA_ASKS_PER_MISS;
    message = `Not quite — ${answer}\nComing back ${n} more time${n === 1 ? "" : "s"}.`;
  }
  feedback.textContent = message;
  feedback.className = "feedback-text " + (ok ? "correct" : "wrong");

  if (isMc) {
    const valid = new Set(f.nlOptions.map(dailyNorm));
    for (const btn of dEl("d-choices").children) {
      btn.disabled = true;
      if (valid.has(dailyNorm(btn.textContent))) btn.classList.add("correct");
      else if (btn.textContent === given) btn.classList.add("wrong");
    }
  } else {
    const input = dEl("d-input");
    input.disabled = true;
    input.className = ok ? "correct" : "wrong";
    dEl("d-check").disabled = true;

    // let the Italian be heard once it is known
    dEl("d-speak-a").hidden = false;
  }

  dailyRenderHeader();

  const next = dEl("d-next");
  next.textContent = left
    ? "Next →"
    : (s.phase === "mc" ? "Continue to writing →" : "Finish ✓");
  next.hidden = false;
}

function dailyRenderDone() {
  const s = daily.session;
  const stats = dailyComputeStats(dailyLoadHistory(), dailyToday());

  dEl("dd-title").textContent = "Done for today";
  dEl("dd-sub").textContent = s.alreadyCounted
    ? "Extra set finished. Your streak already counted today."
    : "Counted for your streak. Come back tomorrow for 10 new words.";

  dailyRenderStats("dd", stats);

  const t = s.totals;
  dEl("dd-summary").textContent =
    `Multiple choice: ${t.mcAsked - t.mcWrong}/${t.mcAsked} right · ` +
    `Writing: ${t.wAsked - t.wWrong}/${t.wAsked} right`;

  const list = dEl("dd-words");
  list.innerHTML = "";

  const rows = s.words
    .map((w, i) => ({ w, misses: s.wrong[i] }))
    .sort((a, b) => b.misses - a.misses);

  for (const { w, misses } of rows) {
    const row = document.createElement("div");
    row.className = "stats-row";

    const word = document.createElement("span");
    word.className = "stats-word";
    word.textContent = `${w.other} — ${w.dutch}`;

    const mark = document.createElement("span");
    mark.className = "stats-num " + (misses ? "wrong" : "correct");
    mark.textContent = misses ? `×${misses}` : "✓";

    row.appendChild(word);
    row.appendChild(mark);
    list.appendChild(row);
  }
}

/* ============================================================
   WIRING
   ============================================================ */

function dailyCheckTypedFromInput() {
  const s = daily.session;
  if (!s || s.answered) return;
  dailyAnswerTyped(dEl("d-input").value);
}

function initDaily() {

  if (daily.wired) return;
  daily.wired = true;

  const conj = dEl("dh-conj");
  conj.checked = dailyConjugateOn();
  conj.addEventListener("change", () => {
    try { localStorage.setItem(LS_DAILY_CONJ, conj.checked ? "1" : "0"); } catch (e) {}
  });

  dEl("dh-start").addEventListener("click", () => {
    const saved = dailyLoadSession(dailyToday());
    if (saved) dailyResume(saved);
    else dailyStart();
  });

  dEl("dh-practice").addEventListener("click", () => dailyStart({ practice: true }));

  dEl("d-back").addEventListener("click", () => showView("view-setup"));
  dEl("dd-back").addEventListener("click", () => showView("view-setup"));

  dEl("d-next").addEventListener("click", dailyAdvance);
  dEl("d-intro-btn").addEventListener("click", dailyBeginWritten);
  dEl("d-check").addEventListener("click", dailyCheckTypedFromInput);

  dEl("d-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (daily.session && daily.session.answered) dailyAdvance();
    else dailyCheckTypedFromInput();
  });

  dEl("d-speak-q").addEventListener("click", () => {
    if (daily.session && daily.session.form) speak(daily.session.form.itQuestion, "Italian");
  });

  dEl("d-speak-a").addEventListener("click", () => {
    const f = daily.session && daily.session.form;
    if (!f) return;
    speak(f.person ? `${f.person} ${f.itAnswers[0]}` : f.itAnswers[0], "Italian");
  });

  renderDailyHome();
}
