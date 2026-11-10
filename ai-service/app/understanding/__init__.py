"""
Query understanding: rewrite → state update → deterministic policy.

1. rewrite  (Model 1): turn the latest message — often a Hinglish fragment like "aur dikhao" or
   "doosra wala" — into one self-contained English request, using the recent conversation.
   Off-topic and small-talk messages are recognised here and never reach step 2.
2. tracker  (Model 1): from that standalone request, report what changed in the conversation
   state (intent, search action and filters, booking slots, ...). Every value is validated.
3. policy   (code):    decide what actually happens — new search, next page, refine, or switch
   to other event types. The model never decides this on its own.

When the model is unavailable, fallback.py handles unambiguous inputs deterministically.
"""

from app.understanding.pipeline import understand

__all__ = ["understand"]
