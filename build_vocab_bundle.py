import csv
import json
from pathlib import Path


def normalize_header(text):
    return (
        str(text)
        .strip()
        .lower()
        .replace("_", " ")
        .replace("-", " ")
    )


def load_vocab(filepath):
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader, None)

        if not headers or len(headers) < 2:
            raise ValueError(f"{filepath}: needs at least two columns.")

        headers = [h.strip() for h in headers]
        normalized_headers = [normalize_header(h) for h in headers]

        dutch_names = {"nederlands", "dutch"}
        dutch_index = None
        for i, header in enumerate(normalized_headers):
            if header in dutch_names:
                dutch_index = i
                break

        if dutch_index is None:
            raise ValueError(f"{filepath}: no Nederlands/Dutch column.")

        metadata_names = {
            "type", "auxiliary", "aux", "gender", "article", "notes"
        }

        language_indices = [
            i for i in range(len(headers))
            if i != dutch_index and normalized_headers[i] not in metadata_names
        ]

        if not language_indices:
            raise ValueError(f"{filepath}: no language column found.")

        other_index = language_indices[0]

        language1 = headers[dutch_index]
        language2 = headers[other_index]

        type_index = None
        auxiliary_index = None
        for i, header in enumerate(normalized_headers):
            if header == "type":
                type_index = i
            elif header in {"auxiliary", "aux"}:
                auxiliary_index = i

        pairs = []

        for row in reader:
            required_index = max(dutch_index, other_index)
            if len(row) <= required_index:
                continue

            dutch_word = row[dutch_index].strip()
            other_word = row[other_index].strip()

            if not dutch_word or not other_word:
                continue

            row_type = ""
            if type_index is not None and len(row) > type_index:
                row_type = row[type_index].strip()

            auxiliary = ""
            if auxiliary_index is not None and len(row) > auxiliary_index:
                auxiliary = row[auxiliary_index].strip()

            pairs.append({
                "dutch": dutch_word,
                "other": other_word,
                "type": row_type,
                "auxiliary": auxiliary,
            })

    if not pairs:
        raise ValueError(f"{filepath}: no vocabulary rows.")

    filename = filepath.name.lower()
    italian_filename = (
        "italian" in filename
        or "italiano" in filename
        or "italiaans" in filename
    )

    verb_rows = [
        p for p in pairs
        if normalize_header(p["type"]) in {"verb", "verbo", "werkwoord"}
    ]

    contains_verbs = bool(verb_rows)

    is_italian_verbs = contains_verbs and (
        italian_filename
        or normalize_header(language2) in {"italiano", "italiaans", "italian"}
    )

    return {
        "id": filepath.stem,
        "name": filepath.stem.replace("_", " "),
        "language1": language1,
        "language2": language2,
        "isItalianVerbs": is_italian_verbs,
        "pairs": pairs,
    }


def main():
    folder = Path(__file__).parent
    csv_files = sorted(folder.glob("*.csv"))

    sets = []
    for csv_file in csv_files:
        try:
            sets.append(load_vocab(csv_file))
            print(f"OK  {csv_file.name}: {len(sets[-1]['pairs'])} pairs, "
                  f"verbs={sets[-1]['isItalianVerbs']}")
        except Exception as e:
            print(f"SKIP {csv_file.name}: {e}")

    out_path = folder / "vocab.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"sets": sets}, f, ensure_ascii=False, indent=2)

    print(f"\nWrote {out_path} with {len(sets)} set(s).")


if __name__ == "__main__":
    main()
