'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */

const DUTCH_NAMES = new Set(["nederlands", "dutch"]);
const ITALIAN_NAMES = new Set(["italiano", "italiaans", "italian"]);
const VERB_TYPES = new Set(["verb", "verbo", "werkwoord"]);
const PERSON_PREFIXES = ["io", "tu", "lui", "lei", "noi", "voi", "loro"];

const TENSES = [
  { key: "present", label: "Presente" },
  { key: "past_perfect", label: "Passato prossimo" },
  { key: "imperfect", label: "Imperfetto" },
  { key: "future", label: "Futuro" },
];

const LANG_CODES = {
  "nederlands": "nl-NL", "dutch": "nl-NL",
  "italiano": "it-IT", "italiaans": "it-IT", "italian": "it-IT",
  "engels": "en-US", "english": "en-US",
  "duits": "de-DE", "deutsch": "de-DE", "german": "de-DE",
  "frans": "fr-FR", "français": "fr-FR", "french": "fr-FR",
  "spaans": "es-ES", "español": "es-ES", "spanish": "es-ES",
};

const LS_VOCAB = "gds.vocabSets";
const LS_CONJ = "gds.conjugations";
const LS_STATS = "gds.stats";
const LS_SETTINGS = "gds.settings";
const LS_THEME = "gds.theme";
const LS_BUNDLE = "gds.bundleVersion";

// Bump this number every time vocab.json changes. On the next start the
// app replaces its built-in decks with the new ones (keeping decks the
// user imported and carrying word stats over). Without this, the copy
// saved on the phone at first launch would be used forever.
const BUNDLE_VERSION = 6;

/* ============================================================
   STATE
   ============================================================ */

const state = {
  sets: [],
  conjugations: {},
  stats: {},

  currentSetId: null,
  direction: "forward",   // forward: language1 -> language2, reverse: language2 -> language1
  mode: "multiple",       // multiple | type
  conjugate: true,
  selectedTenses: TENSES.map(t => t.key),

  deck: [],
  deckPos: 0,
  cardsShown: 0,
  retryQueue: [],       // {pairIndex, dueAt} - words that were missed, due to reappear soon

  currentPair: null,
  currentPairIndex: null,
  currentPairConjugated: false,
  currentTenseKey: null,
  currentConjugations: [],
  currentRemainder: "",
  currentPerson: null,

  correctAnswers: [],
  correctCount: 0,
  wrongCount: 0,
  answered: false,

  pendingImport: { csv: null, conj: null },
};

/* ============================================================
   SMALL HELPERS
   ============================================================ */

function normalizeHeader(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/-/g, " ");
}

function getTranslations(text) {
  return String(text || "")
    .split("/")
    .map(s => s.trim())
    .filter(Boolean);
}

function getPersonPrefix(text) {
  const lower = String(text || "").trim().toLowerCase();
  for (const p of PERSON_PREFIXES) {
    if (lower === p || lower.startsWith(p + " ")) return p;
  }
  return null;
}

function stripPersonPrefix(text, person) {
  const trimmed = String(text || "").trim();
  if (!person) return trimmed;
  const re = new RegExp("^" + person + "\\s+", "i");
  return trimmed.replace(re, "").trim();
}

function expandAlternates(text) {
  return String(text || "")
    .split("/")
    .map(s => s.trim())
    .filter(Boolean);
}

function findFormForPerson(forms, person) {
  if (!person || !forms) return null;
  for (const f of forms) {
    if (getPersonPrefix(f) === person) return f;
  }
  return null;
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function langCodeFor(languageName) {
  return LANG_CODES[normalizeHeader(languageName)] || undefined;
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ============================================================
   PERSISTENCE
   ============================================================ */

function saveVocabSets() {
  localStorage.setItem(LS_VOCAB, JSON.stringify(state.sets));
}

function saveConjugations() {
  localStorage.setItem(LS_CONJ, JSON.stringify(state.conjugations));
}

function saveStats() {
  localStorage.setItem(LS_STATS, JSON.stringify(state.stats));
}

function saveSettings() {
  localStorage.setItem(LS_SETTINGS, JSON.stringify({
    currentSetId: state.currentSetId,
    direction: state.direction,
    mode: state.mode,
    conjugate: state.conjugate,
    selectedTenses: state.selectedTenses,
  }));
}

// Moves right/wrong counts from an old wording of a word to the new one
// (e.g. "huis||casa" -> "het huis||la casa"). Words are matched by
// position, and only when the new text still ends with the old text, so
// a changed deck can never hand one word's stats to a different word.
function migrateStats(oldSet, newSet) {
  const n = Math.min(oldSet.pairs.length, newSet.pairs.length);

  for (let i = 0; i < n; i++) {
    const o = oldSet.pairs[i];
    const f = newSet.pairs[i];

    if (o.dutch === f.dutch && o.other === f.other) continue;
    if (!f.dutch.endsWith(o.dutch) || !f.other.endsWith(o.other)) continue;

    const oldKey = `${oldSet.id}::${o.dutch}||${o.other}`;
    const entry = state.stats[oldKey];
    if (!entry) continue;

    const newKey = `${newSet.id}::${f.dutch}||${f.other}`;
    entry.dutch = f.dutch;
    entry.other = f.other;

    const existing = state.stats[newKey];
    if (existing) {
      existing.correct += entry.correct;
      existing.wrong += entry.wrong;
    } else {
      state.stats[newKey] = entry;
    }
    delete state.stats[oldKey];
  }

  saveStats();
}

// Replaces the built-in decks with the freshly bundled ones, but keeps
// decks the user imported themselves and any words they added to a
// built-in deck (those are flagged custom when imported).
function refreshBundledSets(storedSets, bundledSets) {
  const bundledIds = new Set(bundledSets.map(s => s.id));
  const result = [];

  for (const fresh of bundledSets) {
    const old = storedSets.find(s => s.id === fresh.id);

    if (old) {
      migrateStats(old, fresh);

      const have = new Set(fresh.pairs.map(p => p.dutch + "||" + p.other));
      for (const p of old.pairs) {
        if (p.custom && !have.has(p.dutch + "||" + p.other)) {
          fresh.pairs.push(p);
        }
      }
    }

    result.push(fresh);
  }

  for (const s of storedSets) {
    if (!bundledIds.has(s.id)) result.push(s);
  }

  return result;
}

async function loadInitialData() {
  const storedVocab = localStorage.getItem(LS_VOCAB);
  const storedConj = localStorage.getItem(LS_CONJ);
  const storedStats = localStorage.getItem(LS_STATS);
  const storedSettings = localStorage.getItem(LS_SETTINGS);
  const storedTheme = localStorage.getItem(LS_THEME);

  // Stats load first: refreshing the built-in decks may rename words,
  // and the stats need to follow them.
  state.stats = storedStats ? JSON.parse(storedStats) : {};

  const storedBundleVersion = Number(localStorage.getItem(LS_BUNDLE) || 0);
  let sets = storedVocab ? JSON.parse(storedVocab) : null;

  if (!sets || storedBundleVersion < BUNDLE_VERSION) {
    try {
      const res = await fetch("vocab.json");
      const data = await res.json();
      sets = sets ? refreshBundledSets(sets, data.sets) : data.sets;
      state.sets = sets;
      saveVocabSets();
      localStorage.setItem(LS_BUNDLE, String(BUNDLE_VERSION));
    } catch (e) {
      // Offline and nothing cached yet: keep what is on the phone and
      // try the refresh again next time.
      if (!sets) throw e;
      state.sets = sets;
    }
  } else {
    state.sets = sets;
  }

  if (storedConj) {
    state.conjugations = JSON.parse(storedConj);
  } else {
    const res = await fetch("conjugations.json");
    state.conjugations = await res.json();
    saveConjugations();
  }

  if (storedSettings) {
    const s = JSON.parse(storedSettings);
    Object.assign(state, s);
  }

  if (storedTheme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  }

  if (!state.currentSetId && state.sets.length) {
    state.currentSetId = state.sets[0].id;
  }
}

/* ============================================================
   CONJUGATION LOOKUP
   ============================================================ */

function splitInfinitive(phrase) {
  const words = String(phrase || "").trim().toLowerCase().split(/\s+/);
  const base = words[0] || "";
  const remainder = words.slice(1).join(" ");
  return { base, remainder };
}

function getBaseForms(base, tenseKey) {
  const entry = state.conjugations[base];
  if (!entry) return null;
  const forms = entry[tenseKey];
  if (!forms || !forms.length) return null;
  return forms;
}

function attachRemainder(form, remainder) {
  if (!form) return form;
  return remainder ? `${form} ${remainder}` : form;
}

function getConjugatedForms(infinitivePhrase, tenseKey) {
  const { base, remainder } = splitInfinitive(infinitivePhrase);
  const forms = getBaseForms(base, tenseKey);
  if (!forms) return null;
  if (!remainder) return forms;
  return forms.map(f => `${f} ${remainder}`);
}

/* ============================================================
   CURRENT SET / FIELD HELPERS
   ============================================================ */

function getCurrentSet() {
  return state.sets.find(s => s.id === state.currentSetId) || null;
}

function isItalianField(set, field) {
  const langName = field === "dutch" ? set.language1 : set.language2;
  return ITALIAN_NAMES.has(normalizeHeader(langName));
}

function questionField() {
  return state.direction === "forward" ? "dutch" : "other";
}

function answerField() {
  return state.direction === "forward" ? "other" : "dutch";
}

function isVerbPair(pair) {
  return VERB_TYPES.has(normalizeHeader(pair.type));
}

/* ============================================================
   DECK / CARD PREPARATION
   ============================================================ */

function buildDeck() {
  const set = getCurrentSet();
  const indices = set.pairs.map((_, i) => i);
  state.deck = shuffle(indices);
  state.deckPos = 0;
  state.cardsShown = 0;
  state.retryQueue = [];
}

function scheduleRetry(pairIndex) {
  // Reappear at random somewhere 5-10 cards from now.
  const delay = 5 + Math.floor(Math.random() * 6);
  state.retryQueue.push({
    pairIndex,
    dueAt: state.cardsShown + delay,
  });
}

function nextPairIndex() {
  const set = getCurrentSet();
  const upcomingCardNumber = state.cardsShown + 1;

  const dueEntries = state.retryQueue
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => entry.dueAt <= upcomingCardNumber);

  if (dueEntries.length) {
    // Prefer a due entry that isn't the pair just shown, to avoid an
    // immediate back-to-back repeat when multiple are due at once.
    let pick = dueEntries.find(d => d.entry.pairIndex !== state.currentPairIndex) || dueEntries[0];
    state.retryQueue.splice(pick.i, 1);
    state.cardsShown += 1;
    return pick.entry.pairIndex;
  }

  if (state.deckPos >= state.deck.length) {
    let reshuffled = shuffle(set.pairs.map((_, i) => i));
    // avoid immediate repeat of the very last card across a reshuffle
    const lastIdx = state.deck[state.deck.length - 1];
    if (reshuffled.length > 1 && reshuffled[0] === lastIdx) {
      [reshuffled[0], reshuffled[1]] = [reshuffled[1], reshuffled[0]];
    }
    state.deck = reshuffled;
    state.deckPos = 0;
  }
  const idx = state.deck[state.deckPos];
  state.deckPos += 1;
  state.cardsShown += 1;
  return idx;
}

function prepareCard() {
  const set = getCurrentSet();
  const idx = nextPairIndex();
  const pair = set.pairs[idx];

  state.currentPair = pair;
  state.currentPairIndex = idx;
  state.currentPairConjugated = false;
  state.currentTenseKey = null;
  state.currentConjugations = [];
  state.currentRemainder = "";
  state.currentPerson = null;

  const wantsConjugation = (
    set.isItalianVerbs &&
    state.conjugate &&
    state.selectedTenses.length > 0 &&
    isVerbPair(pair)
  );

  if (wantsConjugation) {
    const tenseKey = pickRandom(state.selectedTenses);
    const { base, remainder } = splitInfinitive(pair.other);
    const rawForms = getBaseForms(base, tenseKey);

    if (rawForms && rawForms.length) {
      state.currentPairConjugated = true;
      state.currentTenseKey = tenseKey;
      state.currentConjugations = rawForms;
      state.currentRemainder = remainder;
      state.currentPerson = getPersonPrefix(pickRandom(rawForms)) || PERSON_PREFIXES[0];
    }
  }

  computeCorrectAnswers();
}

function computeCorrectAnswers() {
  const set = getCurrentSet();
  const field = answerField();

  if (state.currentPairConjugated && isItalianField(set, field)) {
    const rawForm = findFormForPerson(state.currentConjugations, state.currentPerson);
    const strippedRaw = stripPersonPrefix(rawForm || "", state.currentPerson);
    const alternates = expandAlternates(strippedRaw);
    state.correctAnswers = alternates.map(a => attachRemainder(a, state.currentRemainder));
  } else {
    state.correctAnswers = getTranslations(state.currentPair[field]);
  }
}

function getQuestionText() {
  const set = getCurrentSet();
  const field = questionField();

  if (state.currentPairConjugated && isItalianField(set, field)) {
    const rawForm = findFormForPerson(state.currentConjugations, state.currentPerson);
    return attachRemainder(rawForm, state.currentRemainder) || state.currentPair[field];
  }

  return state.currentPair[field];
}

function answerIsConjugated() {
  const set = getCurrentSet();
  return state.currentPairConjugated && isItalianField(set, answerField());
}

/* ============================================================
   MULTIPLE CHOICE
   ============================================================ */

function buildChoices() {
  const set = getCurrentSet();
  const correctAnswer = pickRandom(state.correctAnswers);
  const wrongAnswers = [];

  if (answerIsConjugated()) {
    const candidates = shuffle(
      set.pairs.filter(p => p !== state.currentPair && isVerbPair(p))
    );

    for (const p of candidates) {
      if (wrongAnswers.length >= 3) break;

      const { base, remainder } = splitInfinitive(p.other);
      const rawForms = getBaseForms(base, state.currentTenseKey);
      if (!rawForms) continue;

      const rawForm = findFormForPerson(rawForms, state.currentPerson);
      if (!rawForm) continue;

      const strippedRaw = stripPersonPrefix(rawForm, state.currentPerson);
      const candidate = attachRemainder(expandAlternates(strippedRaw)[0], remainder);

      if (
        candidate &&
        candidate.toLowerCase() !== correctAnswer.toLowerCase() &&
        !wrongAnswers.some(w => w.toLowerCase() === candidate.toLowerCase())
      ) {
        wrongAnswers.push(candidate);
      }
    }
  } else {
    const field = answerField();
    const correctLower = state.correctAnswers.map(a => a.toLowerCase());
    const candidates = shuffle(set.pairs.filter(p => p !== state.currentPair));

    for (const p of candidates) {
      if (wrongAnswers.length >= 3) break;

      for (const alt of getTranslations(p[field])) {
        if (
          !correctLower.includes(alt.toLowerCase()) &&
          !wrongAnswers.some(w => w.toLowerCase() === alt.toLowerCase())
        ) {
          wrongAnswers.push(alt);
          break;
        }
      }
    }
  }

  return shuffle([correctAnswer, ...wrongAnswers]);
}

/* ============================================================
   STATS
   ============================================================ */

function statKey(pair) {
  return `${state.currentSetId}::${pair.dutch}||${pair.other}`;
}

function recordWordResult(isCorrect) {
  recordWordResultFor(state.currentSetId, state.currentPair, isCorrect);
}

// Same as above for any deck/word, used by the daily game which mixes decks.
function recordWordResultFor(setId, pair, isCorrect) {
  const key = `${setId}::${pair.dutch}||${pair.other}`;
  const entry = state.stats[key] || {
    correct: 0, wrong: 0,
    dutch: pair.dutch,
    other: pair.other,
    setId,
  };
  if (isCorrect) entry.correct += 1; else entry.wrong += 1;
  state.stats[key] = entry;
  saveStats();
}

/* ============================================================
   TEXT TO SPEECH
   ============================================================ */

function speak(text, languageName) {
  if (!("speechSynthesis" in window)) {
    toast("Speech isn't supported on this device");
    return;
  }
  const clean = String(text || "").replace(/\//g, " or ");
  const utter = new SpeechSynthesisUtterance(clean);
  const code = langCodeFor(languageName);
  if (code) utter.lang = code;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

/* ============================================================
   VIEW SWITCHING
   ============================================================ */

function showView(id) {
  for (const view of document.querySelectorAll(".view")) {
    view.hidden = view.id !== id;
  }
  // keep the daily card (streak, today's status) fresh on the home screen
  if (id === "view-setup" && typeof renderDailyHome === "function") {
    renderDailyHome();
  }
}

/* ============================================================
   SETUP VIEW
   ============================================================ */

function renderSetList() {
  const container = document.getElementById("set-list");
  container.innerHTML = "";

  for (const set of state.sets) {
    const btn = document.createElement("button");
    btn.className = "set-item" + (set.id === state.currentSetId ? " active" : "");
    btn.innerHTML = `
      <span>
        <span class="set-name">${escapeHtml(set.name)}</span><br>
        <span class="set-meta">${escapeHtml(set.language1)} ⇄ ${escapeHtml(set.language2)}${set.isItalianVerbs ? " · verbs" : ""}</span>
      </span>
      <span class="set-count">${set.pairs.length}</span>
    `;
    btn.addEventListener("click", () => {
      state.currentSetId = set.id;
      renderSetList();
      renderVerbOptions();
      saveSettings();
    });
    container.appendChild(btn);
  }
}

function renderDirectionLabels() {
  const set = getCurrentSet();
  if (!set) return;
  const forwardBtn = document.querySelector('#direction-segmented [data-value="forward"]');
  const reverseBtn = document.querySelector('#direction-segmented [data-value="reverse"]');
  forwardBtn.textContent = `${set.language1} → ${set.language2}`;
  reverseBtn.textContent = `${set.language2} → ${set.language1}`;
}

function renderVerbOptions() {
  const set = getCurrentSet();
  const card = document.getElementById("verb-options-card");

  if (!set || !set.isItalianVerbs) {
    card.hidden = true;
    return;
  }

  card.hidden = false;

  const grid = document.getElementById("tense-options");
  grid.innerHTML = "";

  for (const tense of TENSES) {
    const label = document.createElement("label");
    label.className = "tense-chip";
    const checked = state.selectedTenses.includes(tense.key) ? "checked" : "";
    label.innerHTML = `<input type="checkbox" data-tense="${tense.key}" ${checked}> ${tense.label}`;
    grid.appendChild(label);
  }

  grid.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.tense;
      if (cb.checked) {
        if (!state.selectedTenses.includes(key)) state.selectedTenses.push(key);
      } else {
        state.selectedTenses = state.selectedTenses.filter(k => k !== key);
      }
      saveSettings();
    });
  });

  document.getElementById("chk-conjugate").checked = state.conjugate;
  grid.style.opacity = state.conjugate ? "1" : "0.4";
  grid.style.pointerEvents = state.conjugate ? "auto" : "none";
}

function setupSegmented(id, onChange) {
  const el = document.getElementById(id);
  el.querySelectorAll(".segmented-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      el.querySelectorAll(".segmented-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(btn.dataset.value);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str == null ? "" : str);
  return div.innerHTML;
}

/* ============================================================
   QUIZ VIEW RENDERING
   ============================================================ */

function updateScoreDisplay() {
  document.getElementById("score-correct").textContent = state.correctCount;
  document.getElementById("score-wrong").textContent = state.wrongCount;
}

function renderCard() {
  state.answered = false;

  const set = getCurrentSet();

  document.getElementById("feedback-text").textContent = "";
  document.getElementById("feedback-text").className = "feedback-text";
  document.getElementById("btn-next").hidden = true;

  const pill = document.getElementById("tense-pill");
  if (state.currentPairConjugated) {
    const tense = TENSES.find(t => t.key === state.currentTenseKey);
    pill.textContent = tense ? tense.label : "";
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }

  document.getElementById("question-text").textContent = getQuestionText();

  const qField = questionField();
  const aField = answerField();
  const qLang = qField === "dutch" ? set.language1 : set.language2;
  const aLang = aField === "dutch" ? set.language1 : set.language2;

  document.getElementById("btn-speak-question").hidden = false;
  document.getElementById("btn-speak-question").onclick = () =>
    speak(getQuestionText(), qLang);

  document.getElementById("btn-speak-answer").hidden = true;
  document.getElementById("btn-speak-answer").dataset.lang = aLang;

  if (state.mode === "multiple") {
    document.getElementById("choice-area").hidden = false;
    document.getElementById("type-area").hidden = true;
    renderChoices();
  } else {
    document.getElementById("choice-area").hidden = true;
    document.getElementById("type-area").hidden = false;
    renderTypeInput();
  }
}

function renderChoices() {
  const area = document.getElementById("choice-area");
  area.innerHTML = "";
  const choices = buildChoices();

  for (const choice of choices) {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.textContent = choice;
    btn.addEventListener("click", () => handleChoiceSelected(choice, btn));
    area.appendChild(btn);
  }
}

function renderTypeInput() {
  const personLabel = document.getElementById("person-label");
  const input = document.getElementById("type-input");

  input.value = "";
  input.disabled = false;
  input.className = "";

  if (answerIsConjugated()) {
    personLabel.textContent = state.currentPerson;
    personLabel.hidden = false;
  } else {
    personLabel.hidden = true;
  }

  setTimeout(() => input.focus(), 50);
}

/* ============================================================
   ANSWER HANDLING
   ============================================================ */

function finishCard(isCorrect, displayCorrectAnswer) {
  state.answered = true;

  if (isCorrect) {
    state.correctCount += 1;
  } else {
    state.wrongCount += 1;
    scheduleRetry(state.currentPairIndex);
  }

  recordWordResult(isCorrect);
  updateScoreDisplay();

  const feedback = document.getElementById("feedback-text");
  feedback.textContent = isCorrect
    ? "Correct!"
    : `Not quite — ${displayCorrectAnswer}`;
  feedback.className = "feedback-text " + (isCorrect ? "correct" : "wrong");

  const set = getCurrentSet();
  const aField = answerField();
  const aLang = aField === "dutch" ? set.language1 : set.language2;
  const speakBtn = document.getElementById("btn-speak-answer");
  speakBtn.hidden = false;
  speakBtn.onclick = () => speak(displayCorrectAnswer, aLang);

  document.getElementById("btn-next").hidden = false;
}

function handleChoiceSelected(choice, btn) {
  if (state.answered) return;

  const isCorrect = state.correctAnswers
    .map(a => a.toLowerCase())
    .includes(choice.toLowerCase());

  document.querySelectorAll(".choice-btn").forEach(b => {
    b.disabled = true;
    const bIsCorrect = state.correctAnswers
      .map(a => a.toLowerCase())
      .includes(b.textContent.toLowerCase());
    if (bIsCorrect) b.classList.add("correct");
    else if (b === btn) b.classList.add("wrong");
  });

  finishCard(isCorrect, pickRandom(state.correctAnswers));
}

function handleCheckTyped() {
  if (state.answered) return;

  const input = document.getElementById("type-input");
  const userAnswer = input.value.trim().toLowerCase();
  const isCorrect = state.correctAnswers
    .map(a => a.toLowerCase())
    .includes(userAnswer);

  input.disabled = true;
  input.className = isCorrect ? "correct" : "wrong";

  finishCard(isCorrect, state.correctAnswers[0]);
}

/* ============================================================
   STATS VIEW
   ============================================================ */

function renderStatsView() {
  const set = getCurrentSet();
  document.getElementById("stats-set-name").textContent = set ? set.name : "";

  const rows = Object.values(state.stats).filter(
    e => e.setId === state.currentSetId
  );

  rows.sort((a, b) => {
    if (b.wrong !== a.wrong) return b.wrong - a.wrong;
    const totalA = a.correct + a.wrong;
    const totalB = b.correct + b.wrong;
    if (totalB !== totalA) return totalB - totalA;
    return a.dutch.localeCompare(b.dutch);
  });

  const container = document.getElementById("stats-list");
  container.innerHTML = "";

  if (!rows.length) {
    container.innerHTML = `<p class="stats-empty">No answers recorded yet for this deck.<br>Play a round in Multiple Choice or Type Answer to build up stats.</p>`;
    return;
  }

  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "stats-row";
    el.innerHTML = `
      <span class="stats-word">${escapeHtml(row.dutch)} — ${escapeHtml(row.other)}</span>
      <span class="stats-num wrong">${row.wrong}</span>
      <span class="stats-num correct">${row.correct}</span>
    `;
    container.appendChild(el);
  }
}

/* ============================================================
   IMPORT
   ============================================================ */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter(r => r.some(cell => cell.trim() !== ""));
}

function buildSetFromCsv(filename, rows) {
  if (rows.length < 2) throw new Error("Needs a header row plus at least one data row.");

  const headers = rows[0].map(h => h.trim());
  const normalized = headers.map(normalizeHeader);

  const dutchIndex = normalized.findIndex(h => DUTCH_NAMES.has(h));
  if (dutchIndex === -1) throw new Error("No Nederlands/Dutch column found.");

  const metaNames = new Set(["type", "auxiliary", "aux", "gender", "article", "notes"]);
  const otherIndex = normalized.findIndex((h, i) => i !== dutchIndex && !metaNames.has(h));
  if (otherIndex === -1) throw new Error("No language column found.");

  const typeIndex = normalized.findIndex(h => h === "type");
  const auxIndex = normalized.findIndex(h => h === "auxiliary" || h === "aux");

  const pairs = [];
  for (const row of rows.slice(1)) {
    const dutch = (row[dutchIndex] || "").trim();
    const other = (row[otherIndex] || "").trim();
    if (!dutch || !other) continue;
    pairs.push({
      dutch, other,
      type: typeIndex >= 0 ? (row[typeIndex] || "").trim() : "",
      auxiliary: auxIndex >= 0 ? (row[auxIndex] || "").trim() : "",
    });
  }
  if (!pairs.length) throw new Error("No usable vocabulary rows.");

  const language1 = headers[dutchIndex];
  const language2 = headers[otherIndex];
  const lowerName = filename.toLowerCase();
  const italianFilename = ["italian", "italiano", "italiaans"].some(w => lowerName.includes(w));
  const verbRows = pairs.filter(p => VERB_TYPES.has(normalizeHeader(p.type)));
  const isItalianVerbs = verbRows.length > 0 && (italianFilename || ITALIAN_NAMES.has(normalizeHeader(language2)));

  const id = filename.replace(/\.csv$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return {
    id: id || `set-${Date.now()}`,
    name: filename.replace(/\.csv$/i, "").replace(/_/g, " "),
    language1, language2, isItalianVerbs, pairs,
  };
}

function wireImportView() {
  const csvInput = document.getElementById("file-csv");
  const conjInput = document.getElementById("file-conj");
  const csvPreview = document.getElementById("csv-preview");
  const conjPreview = document.getElementById("conj-preview");
  const saveBtn = document.getElementById("btn-import-save");

  csvInput.addEventListener("change", () => {
    const file = csvInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCsv(reader.result);
        const set = buildSetFromCsv(file.name, rows);
        state.pendingImport.csv = set;
        csvPreview.textContent =
          `Parsed ${set.pairs.length} pairs — ${set.language1} ⇄ ${set.language2}` +
          (set.isItalianVerbs ? " (contains verbs)" : "");
        saveBtn.disabled = false;
      } catch (e) {
        state.pendingImport.csv = null;
        csvPreview.textContent = "Couldn't read that file: " + e.message;
      }
    };
    reader.readAsText(file, "utf-8");
  });

  conjInput.addEventListener("change", () => {
    const file = conjInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const count = Object.keys(data).length;
        state.pendingImport.conj = data;
        conjPreview.textContent = `Parsed conjugations for ${count} verb(s).`;
        saveBtn.disabled = false;
      } catch (e) {
        state.pendingImport.conj = null;
        conjPreview.textContent = "Couldn't read that file: " + e.message;
      }
    };
    reader.readAsText(file, "utf-8");
  });

  saveBtn.addEventListener("click", () => {
    let did = false;

    if (state.pendingImport.csv) {
      const incoming = state.pendingImport.csv;
      const existingIdx = state.sets.findIndex(s => s.id === incoming.id);
      if (existingIdx >= 0) {
        const existing = state.sets[existingIdx];
        const seen = new Set(existing.pairs.map(p => p.dutch + "||" + p.other));
        for (const p of incoming.pairs) {
          const key = p.dutch + "||" + p.other;
          if (!seen.has(key)) { existing.pairs.push({ ...p, custom: true }); seen.add(key); }
        }
        existing.isItalianVerbs = existing.isItalianVerbs || incoming.isItalianVerbs;
      } else {
        state.sets.push(incoming);
      }
      saveVocabSets();
      did = true;
    }

    if (state.pendingImport.conj) {
      Object.assign(state.conjugations, state.pendingImport.conj);
      saveConjugations();
      did = true;
    }

    if (did) {
      toast("Added to your app");
      state.pendingImport = { csv: null, conj: null };
      csvInput.value = ""; conjInput.value = "";
      csvPreview.textContent = ""; conjPreview.textContent = "";
      saveBtn.disabled = true;
      if (!state.currentSetId) state.currentSetId = state.sets[0].id;
      renderSetList();
      renderVerbOptions();
      renderDirectionLabels();
      showView("view-setup");
    }
  });
}

/* ============================================================
   WIRING
   ============================================================ */

function wireSetupView() {
  setupSegmented("direction-segmented", (value) => {
    state.direction = value;
    saveSettings();
  });

  setupSegmented("mode-segmented", (value) => {
    state.mode = value;
    saveSettings();
  });

  document.getElementById("chk-conjugate").addEventListener("change", (e) => {
    state.conjugate = e.target.checked;
    renderVerbOptions();
    saveSettings();
  });

  document.getElementById("btn-start").addEventListener("click", () => {
    const set = getCurrentSet();
    if (!set) { toast("Pick a deck first"); return; }
    state.correctCount = 0;
    state.wrongCount = 0;
    buildDeck();
    updateScoreDisplay();
    showView("view-quiz");
    prepareCard();
    renderCard();
  });

  document.getElementById("btn-import").addEventListener("click", () => {
    showView("view-import");
  });

  document.getElementById("btn-dark-toggle").addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    if (isDark) {
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem(LS_THEME, "light");
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem(LS_THEME, "dark");
    }
  });
}

function wireQuizView() {
  document.getElementById("btn-check").addEventListener("click", handleCheckTyped);

  document.getElementById("type-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (!state.answered) handleCheckTyped();
      else goToNextCard();
    }
  });

  document.getElementById("btn-next").addEventListener("click", goToNextCard);

  document.getElementById("btn-restart").addEventListener("click", () => {
    state.correctCount = 0;
    state.wrongCount = 0;
    buildDeck();
    updateScoreDisplay();
    prepareCard();
    renderCard();
  });

  document.getElementById("btn-settings").addEventListener("click", () => {
    showView("view-setup");
  });

  document.getElementById("btn-quiz-back").addEventListener("click", () => {
    showView("view-setup");
  });

  document.getElementById("btn-quiz-stats").addEventListener("click", () => {
    renderStatsView();
    showView("view-stats");
  });
}

function goToNextCard() {
  prepareCard();
  renderCard();
}

function wireStatsView() {
  document.getElementById("btn-stats-back").addEventListener("click", () => {
    showView("view-quiz");
  });
}

function wireImportBack() {
  document.getElementById("btn-import-back").addEventListener("click", () => {
    showView("view-setup");
  });
}

/* ============================================================
   INIT
   ============================================================ */

async function init() {
  try {
    await loadInitialData();
  } catch (e) {
    toast("Couldn't load vocab data");
    console.error(e);
    return;
  }

  renderSetList();
  renderDirectionLabels();
  renderVerbOptions();

  document.querySelector(`#direction-segmented [data-value="${state.direction}"]`)
    ?.classList.add("active");
  document.querySelector(`#direction-segmented [data-value="${state.direction === "forward" ? "reverse" : "forward"}"]`)
    ?.classList.remove("active");

  document.querySelector(`#mode-segmented [data-value="${state.mode}"]`)
    ?.classList.add("active");
  document.querySelector(`#mode-segmented [data-value="${state.mode === "multiple" ? "type" : "multiple"}"]`)
    ?.classList.remove("active");

  wireSetupView();
  wireQuizView();
  wireStatsView();
  wireImportView();
  wireImportBack();

  if (typeof initDaily === "function") initDaily();

  showView("view-setup");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", init);
