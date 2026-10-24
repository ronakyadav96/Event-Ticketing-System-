import csv
import json
import os
import pickle
from pathlib import Path

import numpy as np


BASE_DIR = Path(__file__).resolve().parents[1]
MOVIE_DICT_PATH = Path(os.environ.get("MOVIE_DICT_PATH", BASE_DIR / "data" / "movie-recommender" / "movie_dict.pkl"))
SIMILARITY_PATH = Path(os.environ.get("SIMILARITY_PATH", BASE_DIR / "data" / "movie-recommender" / "similarity.pkl"))
TMDB_MOVIES_CSV_PATH = Path(os.environ.get("TMDB_MOVIES_CSV_PATH", BASE_DIR / "data" / "movie-recommender" / "tmdb_5000_movies.csv"))
OUTPUT_DIR = Path(
    os.environ.get(
        "RECOMMENDER_OUTPUT_DIR",
        Path(__file__).resolve().parents[1] / "data" / "movie-recommender",
    )
)
IMAGE_BASE_URL = os.environ.get("TMDB_IMAGE_BASE_URL", "https://image.tmdb.org/t/p/w500").rstrip("/")
TOP_K = int(os.environ.get("RECOMMENDER_TOP_K", "50"))


def normalize_text(value):
    text = str(value or "").strip().lower()
    normalized = []
    previous_space = True
    for char in text:
        if char.isalnum():
            normalized.append(char)
            previous_space = False
        elif not previous_space:
            normalized.append(" ")
            previous_space = True
    return "".join(normalized).strip()


def tokenize(value):
    normalized = normalize_text(value)
    return normalized.split() if normalized else []


def safe_float(value):
    try:
        return float(value)
    except Exception:
        return 0.0


def load_movie_dict():
    with MOVIE_DICT_PATH.open("rb") as handle:
        return pickle.load(handle)


def load_similarity():
    with SIMILARITY_PATH.open("rb") as handle:
        return pickle.load(handle)


def load_meta():
    meta = {}
    with TMDB_MOVIES_CSV_PATH.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            movie_id = str(row.get("id") or "").strip()
            if not movie_id:
                continue
            poster_path = str(row.get("poster_path") or "").strip()
            poster_url = f"{IMAGE_BASE_URL}/{poster_path.lstrip('/')}" if poster_path else ""
            meta[movie_id] = {
                "overview": str(row.get("overview") or "").strip(),
                "releaseDate": str(row.get("release_date") or "").strip(),
                "voteAverage": safe_float(row.get("vote_average")),
                "popularity": safe_float(row.get("popularity")),
                "posterPath": poster_path,
                "posterUrl": poster_url,
            }
    return meta


def is_better_candidate(candidate, current):
    candidate_score = (
        safe_float(candidate.get("popularity")),
        safe_float(candidate.get("voteAverage")),
        len(candidate.get("overview") or ""),
    )
    current_score = (
        safe_float(current.get("popularity")),
        safe_float(current.get("voteAverage")),
        len(current.get("overview") or ""),
    )
    return candidate_score > current_score


def build_unique_movies(movie_dict, meta_by_id):
    unique_by_title = {}
    order = []
    original_to_kept = {}
    ordered_indices = sorted(movie_dict["title"].keys())

    for similarity_index, index in enumerate(ordered_indices):
        raw_title = movie_dict["title"].get(index)
        title = str(raw_title or "").strip()
        normalized_title = normalize_text(title)
        if not normalized_title:
            continue

        movie_id = str(movie_dict["movie_id"].get(index, "")).strip()
        tags = str(movie_dict["tags"].get(index, "")).strip()
        meta = meta_by_id.get(movie_id, {})
        item = {
            "movieId": movie_id or f"title:{normalized_title}",
            "title": title,
            "normalizedTitle": normalized_title,
            "titleTokens": tokenize(title),
            "tags": normalize_text(tags),
            "tagTokens": tokenize(tags),
            "overview": meta.get("overview", ""),
            "releaseDate": meta.get("releaseDate", ""),
            "voteAverage": safe_float(meta.get("voteAverage")),
            "popularity": safe_float(meta.get("popularity")),
            "posterPath": meta.get("posterPath", ""),
            "posterUrl": meta.get("posterUrl", ""),
            "hasPoster": bool(meta.get("posterUrl")),
            "sourceIndex": int(similarity_index),
        }

        existing = unique_by_title.get(normalized_title)
        if existing is None:
            unique_by_title[normalized_title] = item
            order.append(normalized_title)
            original_to_kept[int(similarity_index)] = normalized_title
            continue

        if is_better_candidate(item, existing):
            unique_by_title[normalized_title] = item
        original_to_kept[int(similarity_index)] = normalized_title

    movies = [unique_by_title[key] for key in order]
    for movie in movies:
        movie["sourceIndex"] = int(movie["sourceIndex"])
    return movies, unique_by_title, original_to_kept


def build_neighbors(movies, title_to_movie, original_to_kept, similarity):
    neighbors = {}
    movie_by_title = {movie["normalizedTitle"]: movie for movie in movies}
    candidate_pool = min(max(TOP_K * 8, 100), len(original_to_kept))

    for movie in movies:
        source_index = int(movie["sourceIndex"])
        row = np.asarray(similarity[source_index], dtype=float)
        top_indices = np.argpartition(row, -candidate_pool)[-candidate_pool:]
        sorted_indices = top_indices[np.argsort(row[top_indices])[::-1]]

        picked = []
        seen_titles = {movie["normalizedTitle"]}
        for candidate_index in sorted_indices:
            kept_title = original_to_kept.get(int(candidate_index))
            if not kept_title or kept_title in seen_titles:
                continue

            candidate_movie = movie_by_title.get(kept_title)
            if not candidate_movie:
                continue

            seen_titles.add(kept_title)
            picked.append(
                {
                    "movieId": candidate_movie["movieId"],
                    "score": round(float(row[candidate_index]), 6),
                }
            )
            if len(picked) >= TOP_K:
                break

        neighbors[movie["movieId"]] = picked

    return neighbors


def write_output(movies, neighbors):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    movies_to_write = []
    for movie in movies:
        current = dict(movie)
        current.pop("sourceIndex", None)
        movies_to_write.append(current)

    metadata = {
        "movieCount": len(movies_to_write),
        "neighborCount": TOP_K,
        "generatedFrom": {
            "movieDictPath": str(MOVIE_DICT_PATH),
            "similarityPath": str(SIMILARITY_PATH),
            "tmdbMoviesCsvPath": str(TMDB_MOVIES_CSV_PATH),
        },
    }

    with (OUTPUT_DIR / "movies.json").open("w", encoding="utf-8") as handle:
        json.dump(movies_to_write, handle, ensure_ascii=True, separators=(",", ":"))

    with (OUTPUT_DIR / "neighbors.json").open("w", encoding="utf-8") as handle:
        json.dump(neighbors, handle, ensure_ascii=True, separators=(",", ":"))

    with (OUTPUT_DIR / "metadata.json").open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, ensure_ascii=True, indent=2)


def main():
    movie_dict = load_movie_dict()
    similarity = load_similarity()
    meta_by_id = load_meta()

    movies, title_to_movie, original_to_kept = build_unique_movies(movie_dict, meta_by_id)
    neighbors = build_neighbors(movies, title_to_movie, original_to_kept, similarity)
    write_output(movies, neighbors)

    print(
        json.dumps(
            {
                "ok": True,
                "movieCount": len(movies),
                "neighborCount": TOP_K,
                "outputDir": str(OUTPUT_DIR),
            }
        )
    )


if __name__ == "__main__":
    main()
