import csv
import json
import os
import pickle
import sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


try:
    import numpy  # noqa: F401
except Exception:
    print(json.dumps({
        "ok": False,
        "message": "NumPy is not available in the configured Python environment.",
        "code": "NUMPY_MISSING",
    }))
    sys.exit(1)


MOVIE_DICT_PATH = Path(os.environ.get("MOVIE_DICT_PATH", r"C:\Users\hp\Downloads\movie_dict.pkl"))
SIMILARITY_PATH = Path(os.environ.get("SIMILARITY_PATH", r"C:\Users\hp\Downloads\similarity.pkl"))
TMDB_MOVIES_CSV_PATH = Path(os.environ.get("TMDB_MOVIES_CSV_PATH", r"C:\Users\hp\Downloads\tmdb_5000_movies.csv"))
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "").strip()
TMDB_IMAGE_BASE_URL = os.environ.get("TMDB_IMAGE_BASE_URL", "https://image.tmdb.org/t/p/w500").rstrip("/")

_movie_dict = None
_similarity = None
_movies_meta = None
_tmdb_movie_cache = {}
_tmdb_debug = {}
_title_rows = None
_movie_index_by_id = None
_movie_index_by_title = None


def load_movie_dict():
    global _movie_dict
    if _movie_dict is None:
        with MOVIE_DICT_PATH.open("rb") as handle:
            _movie_dict = pickle.load(handle)
    return _movie_dict


def load_similarity():
    global _similarity
    if _similarity is None:
        with SIMILARITY_PATH.open("rb") as handle:
            _similarity = pickle.load(handle)
    return _similarity


def safe_float(value):
    try:
        return float(value)
    except Exception:
        return 0.0


def load_movies_meta():
    global _movies_meta
    if _movies_meta is None:
        out = {}
        with TMDB_MOVIES_CSV_PATH.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                movie_id = str(row.get("id") or "").strip()
                if not movie_id:
                    continue

                poster_path = (row.get("poster_path") or "").strip()
                poster_url = ""
                if poster_path and TMDB_API_KEY:
                    poster_url = f"{TMDB_IMAGE_BASE_URL}/{poster_path.lstrip('/')}"

                out[movie_id] = {
                    "movieId": movie_id,
                    "title": (row.get("title") or "").strip(),
                    "overview": (row.get("overview") or "").strip(),
                    "releaseDate": (row.get("release_date") or "").strip(),
                    "voteAverage": safe_float(row.get("vote_average")),
                    "popularity": safe_float(row.get("popularity")),
                    "posterPath": poster_path,
                    "posterUrl": poster_url,
                }
        _movies_meta = out
    return _movies_meta


def load_title_rows():
    global _title_rows
    if _title_rows is None:
        movie_dict = load_movie_dict()
        meta_by_id = load_movies_meta()
        rows = []
        for index, title in movie_dict["title"].items():
            candidate = (title or "").strip()
            lowered = candidate.lower()
            movie_id = str(movie_dict["movie_id"].get(index, "")).strip()
            popularity = meta_by_id.get(movie_id, {}).get("popularity", 0.0)
            rows.append({
                "index": index,
                "title": candidate,
                "titleLower": lowered,
                "movieId": movie_id,
                "popularity": popularity,
            })
        _title_rows = rows
    return _title_rows


def load_movie_indexes():
    global _movie_index_by_id, _movie_index_by_title
    if _movie_index_by_id is None or _movie_index_by_title is None:
        by_id = {}
        by_title = {}
        for row in load_title_rows():
            if row["movieId"]:
                by_id[row["movieId"]] = row["index"]
            if row["titleLower"] and row["titleLower"] not in by_title:
                by_title[row["titleLower"]] = row["index"]
        _movie_index_by_id = by_id
        _movie_index_by_title = by_title
    return _movie_index_by_id, _movie_index_by_title


def fetch_tmdb_movie_meta(movie_id):
    normalized_id = str(movie_id or "").strip()
    if not normalized_id or not TMDB_API_KEY:
        _tmdb_debug[normalized_id] = {
            "movieId": normalized_id,
            "fetched": False,
            "reason": "API_KEY_MISSING" if normalized_id else "MOVIE_ID_MISSING",
        }
        return {}

    if normalized_id in _tmdb_movie_cache:
        return _tmdb_movie_cache[normalized_id]

    query = urlencode({"api_key": TMDB_API_KEY})
    url = f"https://api.themoviedb.org/3/movie/{normalized_id}?{query}"

    try:
        with urlopen(url, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
            _tmdb_debug[normalized_id] = {
                "movieId": normalized_id,
                "fetched": True,
                "status": getattr(response, "status", 200),
                "reason": "OK",
                "hasPosterPath": bool(payload.get("poster_path")),
            }
    except Exception:
        _tmdb_debug[normalized_id] = {
            "movieId": normalized_id,
            "fetched": False,
            "reason": "REQUEST_FAILED",
        }
        payload = {}

    poster_path = str(payload.get("poster_path") or "").strip()
    poster_url = f"{TMDB_IMAGE_BASE_URL}/{poster_path.lstrip('/')}" if poster_path else ""

    out = {
        "posterPath": poster_path,
        "posterUrl": poster_url,
        "overview": str(payload.get("overview") or "").strip(),
        "releaseDate": str(payload.get("release_date") or "").strip(),
        "voteAverage": safe_float(payload.get("vote_average")),
        "popularity": safe_float(payload.get("popularity")),
        "title": str(payload.get("title") or "").strip(),
    }
    _tmdb_movie_cache[normalized_id] = out
    return out


def build_movie_item(index, movie_dict, meta_by_id):
    movie_id = str(movie_dict["movie_id"].get(index, "")).strip()
    title = (movie_dict["title"].get(index, "") or "").strip()
    meta = meta_by_id.get(movie_id, {})
    live_meta = fetch_tmdb_movie_meta(movie_id) if (TMDB_API_KEY and not meta.get("posterPath")) else {}
    merged = {**meta, **{k: v for k, v in live_meta.items() if v not in ("", 0.0, None)}}

    return {
        "movieId": movie_id,
        "title": title or merged.get("title", ""),
        "overview": merged.get("overview", ""),
        "releaseDate": merged.get("releaseDate", ""),
        "voteAverage": merged.get("voteAverage", 0.0),
        "popularity": merged.get("popularity", 0.0),
        "posterPath": merged.get("posterPath", ""),
        "posterUrl": merged.get("posterUrl", ""),
        "hasPoster": bool(merged.get("posterUrl")),
    }


def search_titles(query, limit):
    query = (query or "").strip().lower()
    if not query:
        return []

    movie_dict = load_movie_dict()
    meta_by_id = load_movies_meta()

    scored = []
    for row in load_title_rows():
        index = row["index"]
        candidate = row["title"]
        lowered = row["titleLower"]
        if query not in lowered:
            continue

        if lowered == query:
            score = 0
        elif lowered.startswith(query):
            score = 1
        else:
            score = 2

        popularity = row["popularity"]
        scored.append((score, -popularity, candidate, index))

    scored.sort(key=lambda item: (item[0], item[1], item[2]))
    return [build_movie_item(index, movie_dict, meta_by_id) for _, _, _, index in scored[:limit]]


def list_movies(query, page, limit):
    movie_dict = load_movie_dict()
    meta_by_id = load_movies_meta()
    normalized = (query or "").strip().lower()

    ranked = []
    for row in load_title_rows():
        index = row["index"]
        title = row["title"]
        item = build_movie_item(index, movie_dict, meta_by_id)
        current_title = (item.get("title") or title or "").strip()
        lowered = current_title.lower()
        if normalized and normalized not in lowered:
            continue
        score = 0 if not normalized else (0 if lowered == normalized else 1 if lowered.startswith(normalized) else 2)
        ranked.append((score, -float(item.get("popularity", 0.0)), current_title, item))

    ranked.sort(key=lambda entry: (entry[0], entry[1], entry[2]))
    data = [item for _, _, _, item in ranked]
    total = len(data)
    total_pages = max(1, (total + limit - 1) // limit)
    start = (page - 1) * limit
    end = start + limit
    return {
        "ok": True,
        "data": data[start:end],
        "page": page,
        "limit": limit,
        "total": total,
        "totalPages": total_pages,
        "hasMore": page < total_pages,
    }


def get_movie(movie_id):
    normalized_id = str(movie_id or "").strip()
    if not normalized_id:
        return {
            "ok": False,
            "message": "Movie id is required.",
            "code": "MOVIE_ID_REQUIRED",
        }

    movie_dict = load_movie_dict()
    meta_by_id = load_movies_meta()
    by_id, _ = load_movie_indexes()
    matched_index = by_id.get(normalized_id)
    if matched_index is not None:
        return {
            "ok": True,
            "movie": build_movie_item(matched_index, movie_dict, meta_by_id),
            "posterConfig": {
                "apiKeyConfigured": bool(TMDB_API_KEY),
                "imageBaseUrl": TMDB_IMAGE_BASE_URL,
            },
            "posterDebug": _tmdb_debug.get(normalized_id, {}),
        }

    return {
        "ok": False,
        "message": "Movie not found in dataset.",
        "code": "MOVIE_NOT_FOUND",
        "posterDebug": _tmdb_debug.get(normalized_id, {}),
    }


def resolve_recommendation_match(movie_dict, normalized, limit):
    _, by_title = load_movie_indexes()
    matched_index = by_title.get(normalized)
    matched_title = ""
    if matched_index is not None:
        matched_title = (movie_dict["title"].get(matched_index, "") or "").strip()

    exact_match = True
    suggestions = []

    if matched_index is None:
        exact_match = False
        suggestions = search_titles(normalized, min(max(limit, 5), 10))
        if not suggestions:
            return None, "", False, []

        fallback_title = str(suggestions[0].get("title") or "").strip().lower()
        matched_index = by_title.get(fallback_title)
        if matched_index is not None:
            matched_title = (movie_dict["title"].get(matched_index, "") or "").strip()

    return matched_index, matched_title, exact_match, suggestions


def execute_command(command, query, limit, page):
    if command == "search":
        return {
            "ok": True,
            "results": search_titles(query, max(1, min(limit, 20))),
        }
    if command == "list":
        return list_movies(query, page, limit)
    if command == "movie":
        return get_movie(query)
    if command == "recommend":
        return recommend(query, max(1, min(limit, 20)))
    return {
        "ok": False,
        "message": f"Unknown command: {command}",
        "code": "UNKNOWN_COMMAND",
    }


def process_request(command, query="", limit=6, page=1):
    exit_code = 0
    limit = max(1, min(limit, 40))
    page = max(1, page)

    try:
        payload = execute_command(command, query, limit, page)
        if not payload.get("ok"):
            exit_code = 1
    except FileNotFoundError as exc:
        payload = {
            "ok": False,
            "message": f"Required file not found: {exc.filename}",
            "code": "FILE_NOT_FOUND",
        }
        exit_code = 1
    except Exception as exc:
        payload = {
            "ok": False,
            "message": str(exc),
            "code": "RUNTIME_ERROR",
        }
        exit_code = 1

    return payload, exit_code


def serve():
    for raw_line in sys.stdin:
        line = (raw_line or "").strip()
        if not line:
            continue

        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            command = str(request.get("command") or "").strip()
            query = request.get("query") or ""
            limit = int(request.get("limit", 6))
            page = int(request.get("page", 1))
            payload, _ = process_request(command, query, limit, page)
            response = {
                "id": request_id,
                "ok": bool(payload.get("ok")),
                "payload": payload,
            }
            if not payload.get("ok"):
                response["error"] = payload.get("message") or "Movie request failed."
        except Exception as exc:
            response = {
                "id": request_id,
                "ok": False,
                "error": str(exc),
                "payload": {
                    "ok": False,
                    "message": str(exc),
                    "code": "RUNTIME_ERROR",
                },
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def recommend(title, limit):
    movie_dict = load_movie_dict()
    similarity = load_similarity()
    meta_by_id = load_movies_meta()

    normalized = (title or "").strip().lower()
    if not normalized:
        return {
            "ok": False,
            "message": "Movie title is required.",
            "code": "TITLE_REQUIRED",
        }

    matched_index, matched_title, exact_match, suggestions = resolve_recommendation_match(movie_dict, normalized, limit)
    if matched_index is None:
        return {
            "ok": False,
            "message": "Movie not found in recommender dataset.",
            "code": "MOVIE_NOT_FOUND",
            "suggestions": suggestions,
        }

    distances = list(enumerate(similarity[matched_index]))
    distances.sort(key=lambda item: item[1], reverse=True)
    picks = distances[1 : limit + 1]

    recommendations = []
    for index, score in picks:
        item = build_movie_item(index, movie_dict, meta_by_id)
        item["similarityScore"] = float(score)
        recommendations.append(item)

    selected = build_movie_item(matched_index, movie_dict, meta_by_id)

    return {
        "ok": True,
        "selected": selected,
        "matchedTitle": matched_title,
        "recommendations": recommendations,
        "exactMatch": exact_match,
        "suggestions": suggestions,
        "posterConfig": {
            "apiKeyConfigured": bool(TMDB_API_KEY),
            "imageBaseUrl": TMDB_IMAGE_BASE_URL,
        },
        "posterDebug": _tmdb_debug.get(str(selected.get("movieId") or "").strip(), {}),
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "ok": False,
            "message": "Command is required.",
            "code": "COMMAND_REQUIRED",
        }))
        sys.exit(1)

    command = sys.argv[1]
    query = sys.argv[2] if len(sys.argv) > 2 else ""
    if command == "serve":
        serve()
        return

    try:
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    except Exception:
        limit = 6
    try:
        page = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    except Exception:
        page = 1

    payload, exit_code = process_request(command, query, limit, page)

    print(json.dumps(payload))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
