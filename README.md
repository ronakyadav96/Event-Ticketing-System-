# Event Ticketing System

A BookMyShow-style ticketing app — movies, comedy, concerts, sports, plays, workshops — with
an AI assistant ("Event AI") that understands English and Hinglish and shows its results right
in the app.

| Folder | What it is | Port |
|---|---|---|
| `frontend/` | Angular 21 web app (home, explore, event details, booking, dashboards, chat widget) | 4200 |
| `backend/` | Node/Express API over MongoDB: events, search, seats, Stripe payments, bookings | 5001 |
| `ai-service/` | FastAPI + LangGraph chat assistant (Claude by default) | 8000 |
| `e2e/` | Browser smoke test of the running app for every role | — |

## How the assistant works

```
"is weekend kuch funny dikhao"
   → intent + entities (Claude Haiku 4.5, structured output; rule-based fallback without a model)
   → normalised to the catalog: category=Comedy, dates=this weekend, city=<selected city>
   → same query the explore page runs  →  reply carries a view
   → the app navigates to /explore?category=Comedy&from=…&to=…&src=chat, the chat closes
```

- Replies in the user's language: English or Hinglish (Hindi typed in Devanagari is answered in Hinglish).
- Synonyms map onto real categories: funny / hasi / stand-up → Comedy, gaana / DJ → Music, cricket / IPL → Sports, natak → Plays …
- "Tell me about the second one" opens that event's page; "book X" / "X ke tickets book karo" opens the booking page.
- Policies (refunds, cancellation…) are answered from the documents in `ai-service/app/rag/docs`.

## Run locally

Prerequisites: Node 20+, Python 3.12, Docker (for Postgres + Redis), Chrome (for the e2e test).

```bash
# 1. Infrastructure for chat history (Postgres) and per-conversation locks (Redis)
docker compose up -d

# 2. Backend
cd backend && cp .env.example .env   # fill MONGO_URI, JWT_SECRET, Stripe keys
npm install && npm run dev

# 3. AI service
cd ai-service && cp .env.example .env   # same JWT_SECRET; ANTHROPIC_API_KEY
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --port 8000

# 4. Frontend
cd frontend && npm install && npx ng serve --proxy-config proxy.conf.json
```

Open http://localhost:4200.

### Demo catalog

`backend/src/scripts/seed_demo_events.js` adds ~26 live events across cities and categories
(tagged `sourceType: "demo"`, dates relative to today) and tidies legacy venue spellings. It
backs up affected events to `backend/backups/` before writing.

```bash
cd backend
node src/scripts/seed_demo_events.js            # dry run
node src/scripts/seed_demo_events.js --apply    # write
node src/scripts/seed_demo_events.js --remove   # delete the demo events again
```

## Tests

```bash
cd ai-service && .venv/bin/python -m pytest      # agents, Hinglish, vocabulary, views (no network)
cd e2e && npm install && npm run smoke            # needs all three services running
```

## Configuration notes

- `LLM_PROVIDER=anthropic` (default, `claude-haiku-4-5`) or `gemini`. Without a key the assistant
  still handles clear requests with its rule-based mode.
- `CHAT_BOOKING_MODE=app` opens the app's booking page; `chat` runs the step-by-step booking
  flow inside the chat instead.
- `JWT_SECRET` must be identical in `backend/.env` and `ai-service/.env`.
