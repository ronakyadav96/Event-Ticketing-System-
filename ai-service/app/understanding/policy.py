"""
Step 3: deterministic search policy.

The model only reports a search action and the filters the user expressed; this module
decides what is actually fetched, from the persisted search session:

- NEW         → fresh search with exactly the requested filters (asking for the same search
                again pages forward instead of repeating page 1).
- MORE        → next page of the current search; with new criteria it becomes a REFINE.
- REFINE      → current filters merged with the requested ones, from page 1.
- CHANGE_TYPE → a named category (keeping date/price constraints), or a mix of the catalog
                categories the user has not been shown yet.
"""

from typing import Any, Dict, List

FILTER_KEYS = ("text", "category", "genre", "venue", "date_from", "date_to", "max_price")
# Constraints that still apply when the user switches to another kind of event.
_CARRY_OVER = ("date_from", "date_to", "max_price", "venue")


def requested_filters(spec: Dict[str, Any]) -> Dict[str, Any]:
    return {k: spec.get(k) for k in FILTER_KEYS if spec.get(k) not in (None, "")}


def _same(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    return {k: str(v).lower() for k, v in a.items()} == {k: str(v).lower() for k, v in b.items()}


def _subset(requested: Dict[str, Any], previous: Dict[str, Any]) -> bool:
    return all(str(previous.get(k, "")).lower() == str(v).lower() for k, v in requested.items())


def plan_search(search: Dict[str, Any], spec: Dict[str, Any], categories: List[str]) -> Dict[str, Any]:
    """
    Returns {"kind": "filters" | "mix", "continue": bool, "filters": {...},
             "categories": [...] (mix only), "keep_shown_categories": bool}.
    """
    action = spec.get("action") or "NEW"
    requested = requested_filters(spec)
    previous = dict(search.get("filters") or {})
    mix = search.get("mix") or None
    has_previous = bool(previous) or bool(search.get("seen")) or bool(mix)

    def fresh(filters: Dict[str, Any]) -> Dict[str, Any]:
        return {"kind": "filters", "continue": False, "filters": filters, "categories": [], "keep_shown_categories": False}

    def same_again() -> Dict[str, Any]:
        if mix:
            return {"kind": "mix", "continue": True, "filters": previous, "categories": list(mix["categories"]), "keep_shown_categories": True}
        return {"kind": "filters", "continue": True, "filters": previous, "categories": [], "keep_shown_categories": True}

    if action == "MORE":
        if has_previous and _subset(requested, previous):
            return same_again()
        action = "REFINE" if has_previous else "NEW"

    if action == "CHANGE_TYPE":
        shown = set(search.get("shown_categories") or [])
        if previous.get("category"):
            shown.add(previous["category"])
        excluded = shown | set(spec.get("exclude_categories") or [])
        carried = {k: previous[k] for k in _CARRY_OVER if k in previous}
        target = requested.get("category")
        if target and target not in set(spec.get("exclude_categories") or []):
            plan = fresh({**carried, **requested})
            plan["keep_shown_categories"] = True
            return plan
        remaining = [c for c in categories if c not in excluded]
        if not remaining:
            # Everything has been shown already: fall back to everything except what they rejected.
            remaining = [c for c in categories if c not in set(spec.get("exclude_categories") or [])]
        filters = {**carried, **{k: v for k, v in requested.items() if k != "category"}}
        return {"kind": "mix", "continue": False, "filters": filters, "categories": remaining, "keep_shown_categories": True}

    if action == "REFINE" and has_previous:
        return fresh({**previous, **requested})

    # NEW: the model often re-sends the current search verbatim; page forward instead of repeating.
    if has_previous and not mix and requested and _same(requested, previous):
        return same_again()
    return fresh(requested)
