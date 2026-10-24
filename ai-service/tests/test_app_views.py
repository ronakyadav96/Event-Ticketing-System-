"""Hinglish / English replies, search vocabulary, and results shown in the app (views)."""

import pytest

from app.agents import lang
from app.agents.vocab import normalize_search
from config import settings
from tests.conftest import Chat

# asyncio_mode = auto (pytest.ini) runs the async tests; no module-wide mark needed.

FACETS = {
    "categories": ["Activities", "Comedy", "Concert", "Movie", "Plays", "Seminar", "Sports", "Workshop"],
    "cities": ["Bengaluru", "Delhi-NCR", "Mumbai", "Pune"],
}


def search(**kw):
    return {"intent": "EVENT_SEARCH", "search": kw}


# ── Language ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "text, expected",
    [
        ("show me comedy events", lang.EN),
        ("comedy shows dikhao", lang.HI),
        ("kal koi concert hai kya", lang.HI),
        ("mujhe 2 ticket chahiye", lang.HI),
        ("सिनेमा में क्या चल रहा है", lang.HI),
        ("what's on this weekend", lang.EN),
    ],
)
def test_language_detection(text, expected):
    assert lang.detect(text) == expected


def test_neutral_message_keeps_conversation_language():
    assert lang.detect("Laugh Riot", previous=lang.HI) == lang.HI
    assert lang.detect("2", previous=lang.EN) == lang.EN


# ── Vocabulary ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "query, spec, expected",
    [
        ("kuch funny dikhao", {"genre": "funny"}, {"category": "Comedy", "genre": None, "text": None}),
        ("gaana sunna hai", {"text": "gaana"}, {"category": "Concert", "text": None}),
        ("cricket match", {"text": "cricket"}, {"category": "Sports", "text": "cricket"}),
        ("natak dikhao", {}, {"category": "Plays"}),
        ("funny movies", {"category": "Movie"}, {"category": "Movie", "genre": "comedy"}),
        ("show me events", {}, {"live": True, "category": None}),
        ("comedy in bangalore", {"category": "Comedy", "venue": "bangalore"}, {"city": "Bengaluru", "venue": None}),
    ],
)
def test_search_vocabulary(query, spec, expected):
    out = normalize_search(spec, query, FACETS)
    for key, value in expected.items():
        assert out.get(key) == value, (key, out)


# ── Results open in the app ────────────────────────────────────────────────────

async def test_search_returns_explore_view_with_same_filters(graph, fake_node, model):
    model.on("show me comedy events", **search(category="Comedy"))
    out = await Chat(graph, city="Mumbai").say("show me comedy events")
    view = out["reply"]["view"]
    assert view["type"] == "explore"
    assert view["params"]["category"] == "Comedy"
    assert view["params"]["city"] == "Mumbai"  # searches default to the city selected in the app
    assert view["params"]["src"] == "chat" and view["params"]["sort"] == "relevance"
    assert "page" in out["reply"]["text"]


async def test_hinglish_search_gets_hinglish_reply(graph, fake_node, model):
    model.on("comedy shows dikhao", language="hi", **search(category="Comedy"))
    out = await Chat(graph).say("comedy shows dikhao")
    assert out["lang"] == lang.HI
    assert "mile" in out["reply"]["text"] and "dikha diye" in out["reply"]["text"]


async def test_degraded_mode_answers_hinglish_in_hinglish(graph, fake_node, monkeypatch):
    from app.agents import intent as intent_module
    from app.llm import LLMUnavailable

    async def down(*_a, **_k):
        raise LLMUnavailable("down")

    monkeypatch.setattr(intent_module, "extract", down)
    out = await Chat(graph).say("kuch funny dikhao")
    assert {e["category"] for e in out["reply"]["events"]} == {"Comedy"}
    assert out["lang"] == lang.HI and "mile" in out["reply"]["text"]


async def test_specific_topic_falls_back_to_its_category(graph, fake_node, model):
    model.on("standup by nobody", **search(category="Comedy", text="zzz unknown"))
    out = await Chat(graph).say("standup by nobody")
    assert out["reply"]["events"] and "zzz unknown" in out["reply"]["text"]
    assert "q" not in out["reply"]["view"]["params"]


async def test_show_more_pages_the_view(graph, fake_node, model, monkeypatch):
    from app.agents import search as search_agent

    monkeypatch.setattr(search_agent, "PAGE_SIZE", 4)
    chat = Chat(graph)
    model.on("comedy", **search(category="Comedy"))
    await chat.say("comedy")
    out = await chat.say("aur dikhao")  # fast path, no model call
    assert out["reply"]["view"]["params"]["p"] == 2


async def test_details_open_the_event_page(graph, fake_node, model):
    chat = Chat(graph)
    model.on("comedy", **search(category="Comedy"))
    first = (await chat.say("comedy"))["reply"]["events"][0]
    model.on("tell me about the first one", intent="EVENT_DETAILS", event_id=first["id"])
    out = await chat.say("tell me about the first one")
    assert out["reply"]["view"] == {"type": "event", "event_id": first["id"], "action": "details"}


async def test_booking_opens_the_booking_page(graph, fake_node, model, monkeypatch):
    monkeypatch.setattr(settings, "CHAT_BOOKING_MODE", "app")
    chat = Chat(graph, authenticated=False)  # the app's booking page handles sign-in
    model.on("comedy", **search(category="Comedy"))
    first = (await chat.say("comedy"))["reply"]["events"][0]
    out = await chat.say(f"Book {first['title']}")  # the UI's own phrase: resolved without the model
    assert out["reply"]["view"] == {"type": "event", "event_id": first["id"], "action": "book"}
    assert out["booking"]["stage"] == "IDLE"


async def test_booking_ambiguous_title_asks_which_one(graph, fake_node, model, monkeypatch):
    monkeypatch.setattr(settings, "CHAT_BOOKING_MODE", "app")
    model.on("book star voyage", intent="BOOKING", event_title="Star Voyage")
    out = await Chat(graph).say("book star voyage")
    assert out["reply"]["view"] is None
    assert len(out["reply"]["events"]) == 2


async def test_faq_and_small_talk_never_navigate(graph, fake_node, model):
    model.on("hello", intent="SMALL_TALK")
    out = await Chat(graph).say("hello")
    assert out["reply"]["view"] is None
