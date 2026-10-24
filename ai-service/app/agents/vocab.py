"""
Search vocabulary shared by the model path and the degraded (no-model) path.

Users rarely say the catalog's category names. "funny", "hasi", "stand-up" all mean Comedy;
"gaana", "DJ night" mean Concert; "cricket", "IPL" mean Sports. normalize_search() maps the
extracted search onto the categories and cities that actually exist in the catalog, so both
the chat and the explore page run the same, correct query.
"""

import re
from typing import Any, Dict, Iterable, List, Optional

# Words that only name a category: they become the category filter and are not kept as text.
CATEGORY_WORDS: Dict[str, List[str]] = {
    "Comedy": [
        "comedy", "comedies", "comedian", "comedians", "comic", "standup", "stand-up", "stand up", "funny",
        "hasi", "hansi", "hasna", "hasne", "hasane", "jokes", "joke", "laugh", "laughter", "laughing", "mazak",
        "mazaak", "open mic", "openmic",
    ],
    "Concert": [
        "concert", "concerts", "music", "musical", "gig", "gigs", "live music", "band", "bands", "singer",
        "singing", "gaana", "gaane", "gana", "gane", "geet", "sangeet", "music show", "music shows",
    ],
    "Sports": ["sports", "sport", "khel", "khelkud", "match", "matches", "game", "games", "tournament"],
    "Plays": ["play", "plays", "theatre", "theater", "drama", "natak", "naatak", "stage play"],
    "Workshop": ["workshop", "workshops", "class", "classes", "masterclass", "sikhna", "seekhna", "learn", "learning"],
    "Seminar": ["seminar", "seminars", "talk", "talks", "conference", "conferences", "summit", "lecture", "webinar"],
    "Activities": ["activity", "activities", "outdoor", "adventure"],
    "Movie": ["movie", "movies", "film", "films", "flim", "picture", "pikchar", "cinema"],
}

# Specific interests: they imply a category and are also kept as search text
# (the search drops the text again if nothing matches it, keeping the category).
TOPIC_WORDS: Dict[str, List[str]] = {
    "Sports": [
        "cricket", "football", "soccer", "ipl", "t20", "kabaddi", "marathon", "running", "run", "cycling",
        "cyclothon", "basketball", "volleyball", "badminton", "tennis", "hockey",
    ],
    "Concert": ["dj", "edm", "qawwali", "sufi", "rap", "hip-hop", "hip hop", "rock", "indie", "classical", "bollywood night", "retro"],
    "Workshop": ["pottery", "painting", "art", "craft", "crafts", "pitch", "startup"],
    "Activities": ["yoga", "camping", "trek", "trekking", "meditation"],
}

# Genre words used for movies (comedy movies, action films...), with Hinglish synonyms.
GENRE_ALIASES: Dict[str, str] = {
    "funny": "comedy", "hasi": "comedy", "comic": "comedy", "comedies": "comedy",
    "darawni": "horror", "darawna": "horror", "bhoot": "horror", "scary": "horror",
    "romantic": "romance", "pyaar": "romance", "love": "romance",
    "sci fi": "science fiction", "scifi": "science fiction", "sci-fi": "science fiction",
    "animated": "animation", "cartoon": "animation", "kids": "family",
    "fight": "action", "maar dhaad": "action", "maardhaad": "action",
}

MOVIE_GENRES = [
    "action", "adventure", "animation", "comedy", "crime", "documentary", "drama", "family", "fantasy", "history",
    "horror", "music", "mystery", "romance", "science fiction", "thriller", "war", "western",
]

CITY_ALIASES: Dict[str, str] = {
    "mumbai": "Mumbai", "bombay": "Mumbai", "navi mumbai": "Mumbai", "thane": "Mumbai",
    "delhi": "Delhi-NCR", "new delhi": "Delhi-NCR", "ncr": "Delhi-NCR", "delhi ncr": "Delhi-NCR", "delhi-ncr": "Delhi-NCR",
    "gurgaon": "Delhi-NCR", "gurugram": "Delhi-NCR", "noida": "Delhi-NCR",
    "bangalore": "Bengaluru", "bengaluru": "Bengaluru", "banglore": "Bengaluru",
    "hyderabad": "Hyderabad", "secunderabad": "Hyderabad",
    "chandigarh": "Chandigarh", "jaipur": "Jaipur", "pune": "Pune", "ahmedabad": "Ahmedabad",
    "kolkata": "Kolkata", "calcutta": "Kolkata", "chennai": "Chennai", "madras": "Chennai",
}

# "events", "shows", "kuch karne ko": live entertainment, not the movie catalog.
_LIVE_WORDS = re.compile(r"\b(events?|shows?|live|kuch\s+karne|plans?|outing|experiences?|hangout)\b", re.I)
_MOVIE_WORDS = re.compile(r"\b(movies?|films?|flim|picture|pikchar|cinema)\b", re.I)


def _phrase_in(phrase: str, text: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", text) is not None


def find_category(text: str, available: Iterable[str]) -> Optional[str]:
    """The catalog category named by any category word in `text` (longest phrase wins)."""
    t = (text or "").lower()
    avail = {c.lower(): c for c in available}
    best = None
    for cat, words in CATEGORY_WORDS.items():
        if cat.lower() not in avail:
            continue
        for w in words:
            if _phrase_in(w, t) and (best is None or len(w) > len(best[1])):
                best = (avail[cat.lower()], w)
    return best[0] if best else None


def find_topic(text: str, available: Iterable[str]) -> Optional[tuple]:
    """(category, topic word) for a specific interest such as cricket or yoga."""
    t = (text or "").lower()
    avail = {c.lower(): c for c in available}
    for cat, words in TOPIC_WORDS.items():
        if cat.lower() not in avail:
            continue
        for w in sorted(words, key=len, reverse=True):
            if _phrase_in(w, t):
                return avail[cat.lower()], w
    return None


def find_city(text: str, known: Iterable[str] = ()) -> Optional[str]:
    t = (text or "").lower()
    for alias in sorted(CITY_ALIASES, key=len, reverse=True):
        if _phrase_in(alias, t):
            return CITY_ALIASES[alias]
    for city in known:
        if city and _phrase_in(city.lower(), t):
            return city
    return None


def canonical_genre(genre: Optional[str]) -> Optional[str]:
    if not genre:
        return genre
    g = genre.strip().lower()
    return GENRE_ALIASES.get(g, g)


def _strip_words(text: str, words: Iterable[str]) -> Optional[str]:
    out = (text or "").lower()
    for w in sorted(words, key=len, reverse=True):
        out = re.sub(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])", " ", out)
    out = re.sub(r"\s+", " ", out).strip()
    return out or None


def normalize_search(spec: Dict[str, Any], query: str, facets: Dict[str, Any]) -> Dict[str, Any]:
    """Map a search spec onto real catalog categories / cities. Returns a new spec."""
    spec = dict(spec or {})
    categories = facets.get("categories") or []
    known_cities = facets.get("cities") or []
    all_category_words = [w for words in CATEGORY_WORDS.values() for w in words]

    # City: an explicit city wins; a "venue" that is really a city becomes the city.
    city = spec.get("city")
    if city:
        city = find_city(city, known_cities) or city
    venue = spec.get("venue")
    if venue and not city:
        # Only a venue that is nothing but a city name ("Pune", "bangalore") is treated as the city.
        as_city = find_city(venue, known_cities)
        if as_city and _strip_words(venue, list(CITY_ALIASES) + [c.lower() for c in known_cities]) is None:
            city, venue = as_city, None
    if not city:
        city = find_city(query, known_cities) if re.search(r"\b(in|at|me|mein|mai|near)\b", (query or "").lower()) else None
    spec["city"] = city
    spec["venue"] = venue

    category = spec.get("category")
    if category:
        match = next((c for c in categories if c.lower() == str(category).lower()), None)
        category = match or find_category(str(category), categories) or category
    is_movie = (category or "").lower() in ("movie", "movies") or bool(_MOVIE_WORDS.search(query or ""))

    genre = canonical_genre(spec.get("genre"))
    text = spec.get("text")

    if is_movie:
        # "funny movies": funny is the movie genre, the category stays Movie.
        if not category:
            category = next((c for c in categories if c.lower() in ("movie", "movies")), None)
        if text and not genre:
            g = canonical_genre(text)
            if g != text.lower() or g in MOVIE_GENRES:
                genre, text = g, None
        if not genre:
            q = (query or "").lower()
            for word in sorted(list(GENRE_ALIASES) + MOVIE_GENRES, key=len, reverse=True):
                if _phrase_in(word, q):
                    genre = canonical_genre(word)
                    break
    else:
        # Live events: category words become the category filter.
        for source in (genre, text, query):
            if category or not source:
                continue
            category = find_category(source, categories)
        if category and genre and find_category(genre, [category]) == category:
            genre = None  # "comedy" as genre of the Comedy category adds nothing
        if not category:
            topic = find_topic(" ".join(filter(None, [text, genre, query])), categories)
            if topic:
                category = topic[0]
                text = text or topic[1]
        if text:
            text = _strip_words(text, all_category_words + list(CITY_ALIASES) + [c.lower() for c in categories])

    spec["category"] = category
    spec["genre"] = genre
    spec["text"] = text
    # Generic "show me events" → live events only (the movie catalog would otherwise swamp them).
    dated = bool(spec.get("date_from") or spec.get("date_to"))
    spec["live"] = bool(not category and not text and not is_movie and (dated or _LIVE_WORDS.search(query or "")))
    return spec
