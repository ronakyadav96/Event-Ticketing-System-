# Event AI Service

Conversational layer for the event/movie ticketing platform. It understands requests and
orchestrates the conversation; the Node/Express backend remains the only authority for
events, seats, prices, payments, bookings and refunds.

```
Angular ─► FastAPI (/api/v1) ─► identity + conversation ownership ─► LangGraph
   hydrate → understand (rewrite → state update → policy) → route → guardrail | search | booking | refund | faq → validate
            └─► tools ─► Node/Express ─► MongoDB / Stripe
   ─► PostgreSQL (messages + checkpoints) ─► response (single `booking` state object)
```

## Layout

| Path | Purpose |
|---|---|
| `app/understanding/rewrite.py` | Model 1, step 1: latest message (English/Hinglish, follow-ups) → one standalone English request; catches off-topic and small talk |
| `app/understanding/tracker.py` | Model 1, step 2: intent + what changes (search action NEW/MORE/REFINE/CHANGE_TYPE, filters, booking slots), validated |
| `app/understanding/policy.py` | Deterministic search policy: new search, next page, refine, or other event types |
| `app/understanding/fallback.py` | UI-phrase fast path and degraded mode (English + Hinglish) when the model is unavailable |
| `app/agents/search.py` | Executes the search plan (filtered pages or a mix of categories), event details |
| `app/agents/booking.py` | Booking state machine (`BookingStage`), payment status, booking status |
| `app/agents/refund.py` | Cancellation of paid bookings, refund requests, refund status |
| `app/agents/faq.py` | Grounded FAQ answers from the RAG index |
| `app/agents/guardrail.py` | Small talk (Model 2), fixed out-of-domain reply, unsafe-input handling |
| `app/graph/` | State, nodes, workflow; thread id = `<user_id>::<conversation_id>` |
| `app/tools/` | Deterministic tools over the Node API and the RAG index |
| `services/node_client.py` | HTTP client for Node (forwards the user's JWT; no mocks) |
| `db/` | PostgreSQL conversation store, Redis per-conversation turn lock |

## Run

```bash
cd ai-service
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # set JWT_SECRET (same as Node), GEMINI_API_KEY, POSTGRES_URL, REDIS_URL
.venv/bin/uvicorn main:app --port 8000
```

`APP_ENV=production` disables every in-memory fallback (Postgres and Redis become required).

Local Postgres + Redis: `docker compose up -d` from the repo root (see `docker-compose.yml`).
Without them the service still runs in development, but chat history is lost on restart.

## Deploy

`Dockerfile` builds a production image (listens on `$PORT`). On Render: New → Web Service →
root directory `ai-service`, runtime Docker, and set `APP_ENV=production`, `JWT_SECRET`,
`GEMINI_API_KEY`, `NODE_BACKEND_BASE_URL`, `POSTGRES_URL`, `REDIS_URL` and
`CORS_ORIGINS=<frontend URL>`. Then put `https://<service>/api/v1` in
`event-ticketing-app/src/environments/environment.prod.ts` → `aiApiUrl`.

## Tests

```bash
.venv/bin/python -m pytest
```

The suite runs the real graph, agents and API against a fake Node backend with scripted
Model 1 output (Model 2 is left unavailable, exercising the deterministic fallbacks).
