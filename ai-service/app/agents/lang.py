"""
Reply language: English ("en") or Hinglish ("hi", Hindi written in Roman script).

The assistant answers in the language the user writes in. Hindi typed in Devanagari is also
answered in Hinglish (the product supports English and Hinglish only). Short, neutral messages
("comedy", "2", an event title) keep the language of the conversation so far.
"""

import re
from typing import Optional

EN = "en"
HI = "hi"

# Words that are clearly Hindi when written in Roman script. Ambiguous ones that are also common
# English words ("main", "ha", "to", "me") are left out on purpose.
_HINGLISH = {
    "hai", "hain", "hu", "hoon", "ho", "tha", "thi", "kya", "kyu", "kyun", "kyon", "kaise", "kaisa", "kaisi",
    "kab", "kahan", "kaha", "kidhar", "kaun", "kon", "kitna", "kitne", "kitni", "dikhao", "dikha", "dikhado",
    "dikhaiye", "batao", "bata", "batado", "bataiye", "mujhe", "muje", "mjhe", "humko", "hume", "hamein", "mera",
    "meri", "mere", "chahiye", "chaiye", "chahie", "chahta", "chahti", "koi", "kuch", "kuchh", "aaj", "kal", "parso",
    "wala", "wali", "wale", "nahi", "nhi", "nahin", "haan", "acha", "accha", "achha", "theek", "thik", "bhai",
    "yaar", "yar", "sabse", "sasta", "saste", "sasti", "mehenga", "dekhna", "dekhni", "dekhne", "jaana", "jana",
    "chalo", "karo", "krdo", "kardo", "krna", "karna", "karni", "hoga", "hogi", "honge", "raha", "rahi", "rahe",
    "bhi", "aur", "abhi", "liye", "lie", "isme", "usme", "iska", "uska", "dusra", "doosra", "pehla", "pahla",
    "agla", "agle", "wapas", "paisa", "paise", "milega", "milegi", "mil", "jao", "jaye", "chaliye", "shukriya",
    "dhanyavad", "namaste", "namaskar", "kripya", "zara", "mein", "mai", "pe", "par", "ke", "ka", "ki", "ko",
    "se", "ye", "yeh", "wo", "woh", "vo", "unka", "inka", "sakte", "sakta", "sakti", "dijiye", "dedo",
    "hasi", "natak", "gaana", "gaane", "khel", "shaam", "raat", "subah", "hafte", "weekend",
}
# Short function words that only count when another Hinglish word is present.
_WEAK = {"ke", "ka", "ki", "ko", "se", "pe", "par", "mil", "ho", "weekend", "mai", "ye", "vo", "wo"}
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def detect(text: str, previous: Optional[str] = None) -> str:
    if _DEVANAGARI.search(text or ""):
        return HI
    words = re.findall(r"[a-z]+", (text or "").lower())
    strong = sum(1 for w in words if w in _HINGLISH and w not in _WEAK)
    weak = sum(1 for w in words if w in _WEAK)
    if strong >= 1 and strong + weak >= 2 or strong >= 2:
        return HI
    if strong == 1 and len(words) <= 3:
        return HI
    english_cues = sum(1 for w in words if w in {"show", "me", "find", "what", "is", "are", "the", "please", "can", "you", "i", "want", "book", "tell", "about", "any", "there", "events", "my"})
    if english_cues >= 2:
        return EN
    return previous or EN


def normalize(code: Optional[str], fallback: str = EN) -> str:
    c = (code or "").strip().lower()
    if c in ("hi", "hinglish", "hindi", "hin"):
        return HI
    if c in ("en", "english", "eng"):
        return EN
    return fallback


_STRINGS = {
    # Search
    "found_one": {EN: "I found 1 {label}{where} — showing it on the page 👉", HI: "{where_hi}1 {label} mila — page pe dikha diya 👉"},
    "found_many": {EN: "I found {n} {label}{where} — they're on the page now 👉", HI: "{where_hi}{n} {label} mile — page pe dikha diye 👉"},
    "found_more": {EN: "Here are more {label}{where} ({start}–{end} of {n}) 👉", HI: "Aur {label}{where_tail_hi} ({start}–{end} / {n}) — page pe dikha diye 👉"},
    "relaxed": {EN: "Nothing matched “{text}” exactly, so here are all {label}{where} instead.", HI: "“{text}” ka exact match nahi mila, isliye{where_mid_hi} saare {label} dikha raha hoon."},
    "none_found": {EN: "I couldn't find any {label}{where} with upcoming shows. Try another date, category or city?", HI: "{where_hi}abhi koi upcoming {label} nahi mila. Koi aur date, category ya city try karein?"},
    "seen_all": {EN: "That's all {n} {label}{where} I have. Want to search for something else?", HI: "Bas itne hi the — {n} {label}{where_tail_hi}. Kuch aur dhoondhein?"},
    "tap_to_book": {EN: "Tap any card to see details and book.", HI: "Kisi bhi card pe tap karke details dekho aur book karo."},
    "show_more": {EN: "Show me more", HI: "Aur dikhao"},
    "this_weekend": {EN: "Only this weekend", HI: "Sirf is weekend"},
    "under_500": {EN: "Under ₹500", HI: "₹500 se kam"},
    # Details / booking hand-off
    "opening_details": {EN: "Opening **{title}** for you 👉", HI: "**{title}** ki details khol di 👉"},
    "opening_booking": {EN: "Opening booking for **{title}** — pick your show and seats there 🎟️", HI: "**{title}** ki booking khol di — wahan show aur seats chun lo 🎟️"},
    "which_to_book": {EN: "Which of these would you like to book?", HI: "Inme se kaunsa book karna hai?"},
    "which_event": {EN: "Which event would you like? You can ask me to search first.", HI: "Kaunsa event? Pehle mujhse search karwa lo."},
    "not_found_named": {EN: "I couldn't find an event called “{name}”.", HI: "“{name}” naam ka koi event nahi mila."},
    "ambiguous": {EN: "I found a few events that could match. Which one did you mean?", HI: "Kuch events match ho rahe hain. Aapka matlab kaunsa tha?"},
    "no_longer": {EN: "That event is no longer available.", HI: "Ye event ab available nahi hai."},
    # Guardrail
    "out_of_domain": {
        EN: "I’m your Event AI 🎬 I can help with movies, events, bookings and related questions — but not with that.",
        HI: "Main aapka Event AI hoon 🎬 Movies, events aur bookings mein madad kar sakta hoon — iske baare mein nahi.",
    },
    "unknown": {
        EN: "Sorry, I didn't quite get that. Could you rephrase? I can help with movies, events, bookings and refunds.",
        HI: "Sorry, samajh nahi aaya. Thoda alag tareeke se bologe? Main movies, events, booking aur refund mein help kar sakta hoon.",
    },
    "degraded": {
        EN: "I'm having trouble understanding requests right now. Please try again in a moment — you can also browse events from the website meanwhile.",
        HI: "Abhi mujhe requests samajhne mein dikkat ho rahi hai. Thodi der mein try karo — tab tak website pe events browse kar sakte ho.",
    },
    "sensitive": {
        EN: "🔒 Please don't share card numbers or other payment details in chat. Payments are only taken on the secure Stripe checkout page.",
        HI: "🔒 Chat mein card number ya payment details share mat karo. Payment sirf secure Stripe checkout page pe hota hai.",
    },
    "injection": {
        EN: "I can only help with events, movies, bookings and related questions. What would you like to do?",
        HI: "Main sirf events, movies aur bookings mein help kar sakta hoon. Kya karna hai?",
    },
    # FAQ
    "no_answer": {
        EN: "I don't have information about that in our policy documents. Please contact our support team for help with this question.",
        HI: "Iske baare mein hamare policy documents mein jaankari nahi hai. Please support team se contact karo.",
    },
    "policy_quote": {EN: "Here's what our policy documents say:", HI: "Hamari policy mein ye likha hai:"},
    "login_to_book": {
        EN: "🔒 Please log in to book tickets — it only takes a moment, and I'll bring you straight back to this booking.",
        HI: "🔒 Ticket book karne ke liye pehle login karo — bas ek minute lagega, phir main aapko wapas isi booking pe le aaunga.",
    },
}

# Quick-reply chips per language.
SUGGESTIONS = {
    EN: ["Comedy shows this weekend", "Concerts near me", "Show me movies", "My bookings"],
    HI: ["Is weekend comedy shows", "Concerts dikhao", "Movies dikhao", "Meri bookings"],
}

CATEGORY_LABELS = {
    "comedy": "comedy shows",
    "concert": "music shows",
    "sports": "sports events",
    "plays": "plays",
    "workshop": "workshops",
    "seminar": "talks & seminars",
    "activities": "activities",
    "movie": "movies",
    "movies": "movies",
}


def t(key: str, lang: str, **kw) -> str:
    entry = _STRINGS[key]
    return entry.get(lang, entry[EN]).format(**kw)
