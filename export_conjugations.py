"""
Run this in the SAME folder as your CSV file(s), on your PC where
verbecc is already installed (it's the same install your desktop
flashcard app uses).

It finds every Italian verb in your CSV(s), conjugates it in all
4 tenses, and writes conjugations.json - a plain lookup table the
phone app will use instead of running verbecc live (verbecc is a
Python library and can't run in a browser).

Usage:
    py -m pip install verbecc      (only if not already installed)
    py export_conjugations.py

It will look for every *.csv file in this folder and write one
conjugations.json next to them. Upload BOTH your CSV file(s) and
conjugations.json back to Claude.
"""

import csv
import json
from pathlib import Path

from verbecc import CompleteConjugator, localization


ITALIAN_TENSES = {
    "present": "present",
    "past_perfect": "past_perfect",
    "imperfect": "imperfect",
    "future": "future",
}

WANTED_TENSE_NAMES = {
    "present": {"presente", "present"},
    "past_perfect": {
        "passatoprossimo",
        "passatocomposto",
        "pastperfect",
    },
    "imperfect": {"imperfetto", "imperfect"},
    "future": {"futuro", "futurosimple", "future"},
}


def normalize_header(text):
    return (
        str(text)
        .strip()
        .lower()
        .replace("_", " ")
        .replace("-", " ")
    )


def normalize_key(value):
    value = normalize_header(str(value))
    return value.replace(" ", "").replace("_", "")


def as_dict(value):
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    try:
        if hasattr(value, "get_data"):
            data = value.get_data()
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    try:
        if hasattr(value, "to_json"):
            data = json.loads(value.to_json())
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return value


def find_indicative(conjugation):
    try:
        mood = localization.xmood("it", "indicative")
        return conjugation[mood]
    except Exception:
        pass

    data = as_dict(conjugation)
    if not isinstance(data, dict):
        return None

    moods = data.get("moods")
    if isinstance(moods, dict):
        for key, value in moods.items():
            if normalize_key(key) in {"indicativo", "indicative"}:
                return value

    for key, value in data.items():
        if normalize_key(key) in {"indicativo", "indicative"}:
            return value

    return None


def find_tense(indicative, english_tense):
    if indicative is None:
        return None

    try:
        tense_key = localization.xtense("it", english_tense)
        try:
            return indicative[tense_key]
        except Exception:
            pass
    except Exception:
        pass

    indicative = as_dict(indicative)
    if not isinstance(indicative, dict):
        return None

    wanted = WANTED_TENSE_NAMES.get(english_tense, set())

    for key, value in indicative.items():
        if normalize_key(key) in wanted:
            return value

    return None


def extract_forms(values):
    results = []

    if values is None:
        return results

    if isinstance(values, dict):
        if "c" in values:
            conjugation = values["c"]
            if isinstance(conjugation, (list, tuple)):
                for item in conjugation:
                    text = str(item).strip()
                    if text:
                        results.append(text)
            else:
                text = str(conjugation).strip()
                if text:
                    results.append(text)
            return list(dict.fromkeys(results))

        for value in values.values():
            results.extend(extract_forms(value))
        return list(dict.fromkeys(results))

    if isinstance(values, (list, tuple)):
        for item in values:
            results.extend(extract_forms(item))
        return list(dict.fromkeys(results))

    try:
        if hasattr(values, "conjugations"):
            return extract_forms(values.conjugations)
    except Exception:
        pass

    try:
        if hasattr(values, "get_data"):
            data = values.get_data()
            if isinstance(data, dict):
                return extract_forms(data)
    except Exception:
        pass

    try:
        if hasattr(values, "to_json"):
            data = json.loads(values.to_json())
            return extract_forms(data)
    except Exception:
        pass

    text = str(values).strip()
    if text:
        return [text]
    return []


def conjugate_all_tenses(conjugator, infinitive, cache):
    infinitive = infinitive.strip().lower()

    words = infinitive.split()
    base_infinitive = words[0] if words else infinitive
    remainder = " ".join(words[1:])

    if base_infinitive in cache:
        raw_conjugation = cache[base_infinitive]
    else:
        try:
            raw_conjugation = conjugator.conjugate(base_infinitive)
        except Exception:
            cache[base_infinitive] = None
            return None
        cache[base_infinitive] = raw_conjugation

    if raw_conjugation is None:
        return None

    indicative = find_indicative(raw_conjugation)
    if indicative is None:
        return None

    result = {}

    for tense_key in ITALIAN_TENSES:
        values = find_tense(indicative, tense_key)
        forms = extract_forms(values)

        if remainder:
            forms = [f"{form} {remainder}" for form in forms]

        if forms:
            result[tense_key] = forms

    return result or None


def load_verb_infinitives(csv_path):
    infinitives = set()

    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader, None)

        if not headers:
            return infinitives

        headers = [h.strip() for h in headers]
        normalized = [normalize_header(h) for h in headers]

        type_index = None
        for i, header in enumerate(normalized):
            if header == "type":
                type_index = i

        # Italian column: not "nederlands"/"dutch", not metadata.
        dutch_names = {"nederlands", "dutch"}
        metadata_names = {
            "type", "auxiliary", "aux", "gender", "article", "notes"
        }

        italian_index = None
        for i, header in enumerate(normalized):
            if header not in dutch_names and header not in metadata_names:
                italian_index = i
                break

        if italian_index is None or type_index is None:
            return infinitives

        for row in reader:
            if len(row) <= max(italian_index, type_index):
                continue

            row_type = normalize_header(row[type_index])
            if row_type not in {"verb", "verbo", "werkwoord"}:
                continue

            word = row[italian_index].strip()
            if word:
                infinitives.add(word)

    return infinitives


def main():
    folder = Path(__file__).parent
    csv_files = sorted(folder.glob("*.csv"))

    if not csv_files:
        print("No CSV files found in this folder.")
        return

    infinitives = set()
    for csv_file in csv_files:
        infinitives |= load_verb_infinitives(csv_file)

    print(f"Found {len(infinitives)} verb entries across {len(csv_files)} CSV file(s).")

    conjugator = CompleteConjugator("it")
    cache = {}

    output = {}
    failed = []

    for i, infinitive in enumerate(sorted(infinitives), start=1):
        print(f"  [{i}/{len(infinitives)}] {infinitive}")
        forms = conjugate_all_tenses(conjugator, infinitive, cache)
        if forms:
            output[infinitive] = forms
        else:
            failed.append(infinitive)

    out_path = folder / "conjugations.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nWrote {out_path} with {len(output)} verbs.")

    if failed:
        print(f"\nCould not conjugate {len(failed)} entries (upload the CSV anyway, these just won't quiz in verb mode):")
        for word in failed:
            print(f"  - {word}")


if __name__ == "__main__":
    main()
