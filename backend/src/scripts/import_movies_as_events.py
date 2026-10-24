import csv
import json
import os
import pickle
import sys
from pathlib import Path


MOVIE_DICT_PATH = Path(os.environ.get("MOVIE_DICT_PATH", r"C:\Users\hp\Downloads\movie_dict.pkl"))
TMDB_MOVIES_CSV_PATH = Path(os.environ.get("TMDB_MOVIES_CSV_PATH", r"C:\Users\hp\Downloads\tmdb_5000_movies.csv"))


def load_movie_dict():
    with MOVIE_DICT_PATH.open("rb") as handle:
        return pickle.load(handle)


def load_movies_meta():
    out = {}
    with TMDB_MOVIES_CSV_PATH.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            movie_id = str(row.get("id") or "").strip()
            if not movie_id:
                continue

            out[movie_id] = {
                "title": str(row.get("title") or "").strip(),
                "overview": str(row.get("overview") or "").strip(),
                "releaseDate": str(row.get("release_date") or "").strip(),
                "voteAverage": safe_float(row.get("vote_average")),
                "popularity": safe_float(row.get("popularity")),
                "posterPath": str(row.get("poster_path") or "").strip(),
            }
    return out


def safe_float(value):
    try:
        return float(value)
    except Exception:
        return 0.0


def build_records(limit=0):
    movie_dict = load_movie_dict()
    meta_by_id = load_movies_meta()
    records = []

    items = list(movie_dict.get("movie_id", {}).items())
    if limit > 0:
        items = items[:limit]

    for index, raw_movie_id in items:
        movie_id = str(raw_movie_id or "").strip()
        title = str(movie_dict.get("title", {}).get(index, "") or "").strip()
        tags = str(movie_dict.get("tags", {}).get(index, "") or "").strip()
        meta = meta_by_id.get(movie_id, {})

        records.append(
            {
                "sourceMovieId": movie_id,
                "title": title or meta.get("title", ""),
                "description": meta.get("overview", ""),
                "movieMeta": {
                    "tags": tags,
                    "releaseDate": meta.get("releaseDate", ""),
                    "posterPath": meta.get("posterPath", ""),
                    "posterUrl": "",
                    "voteAverage": meta.get("voteAverage", 0.0),
                    "popularity": meta.get("popularity", 0.0),
                },
            }
        )

    return records


def main():
    limit = 0
    if len(sys.argv) > 1:
      try:
          limit = int(sys.argv[1])
      except Exception:
          limit = 0

    payload = {
        "ok": True,
        "records": build_records(limit),
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
