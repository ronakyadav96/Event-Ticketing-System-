# Event AI Service

Conversational layer for the event/movie ticketing platform. It understands requests and
orchestrates the conversation; the Node/Express backend remains the only authority for
events, seats, prices, payments, bookings and refunds.

```
Angular ─► FastAPI (/api/v1) ─► identity + conversation ownership ─► LangGraph
   hydrate → classify (Model 1) → route → guardrail | search | booking | refund | faq → validate
            └─► tools ─► Node/Express ─► MongoDB / Stripe
   ─► PostgreSQL (messages + checkpoints) ─► response (single `booking` state object)
```

## Layout

| Path | Purpose |
|---|---|
| `app/agents/intent.py` | The only intent classifier (Model 1 structured extraction + validated degraded mode) |
| `app/agents/search.py` | Event search, contextual follow-ups ("another", "not this one"), event details |
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

## Tests

```bash
.venv/bin/python -m pytest
```

The suite runs the real graph, agents and API against a fake Node backend with scripted
Model 1 output (Model 2 is left unavailable, exercising the deterministic fallbacks).
