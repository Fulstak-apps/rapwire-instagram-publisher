#!/usr/bin/env python3
"""Deterministic RapWire story ranking and newsroom diversification.

The model should write and reason about a *small* high-quality shortlist. This module
runs before any LLM call so freshness, source quality, novelty, visual usefulness,
audience momentum, and repeat fatigue are handled cheaply and consistently.

It intentionally does not publish anything and it does not weaken the downstream
editorial/publisher safety gates.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
import math
import os
import re
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlparse


DEFAULT_SHORTLIST = max(3, min(12, int(os.environ.get("RAPWIRE_NEWSROOM_POOL", "7"))))
MIN_SCORE = max(0.0, min(100.0, float(os.environ.get("RAPWIRE_VIRAL_MIN_SCORE", "42"))))
ENTITY_COOLDOWN_HOURS = max(1.0, float(os.environ.get("RAPWIRE_ENTITY_COOLDOWN_HOURS", "12")))
DEBUG = os.environ.get("RAPWIRE_NEWSROOM_DEBUG", "0").strip().lower() in {"1", "true", "yes", "on"}

# These scores are not declarations that a source is always correct. They are only a
# prior used for ordering. Sensitive claims still receive a corroboration penalty.
SOURCE_TRUST = {
    "complexmusic": 13.0,
    "worldstarhiphop": 9.0,
    "akademiks": 9.0,
    "saycheesetv": 8.0,
    "traploreross": 8.0,
    "nojumper": 7.0,
    "theshaderoom": 7.0,
    "detroitrapnews": 6.0,
    "detroitrapdaily": 6.0,
    "poetikflakkonews": 6.0,
    "gta6latest": 6.0,
}

HIGH_AUTHORITY_DOMAINS = {
    "apnews.com", "reuters.com", "billboard.com", "variety.com", "rollingstone.com",
    "nytimes.com", "latimes.com", "npr.org", "pitchfork.com", "grammy.com",
}
MID_AUTHORITY_DOMAINS = {
    "complex.com", "hiphopdx.com", "xxlmag.com", "tmz.com", "hotnewhiphop.com",
}

# A small gravity prior helps obvious tent-pole artists break ties. It is deliberately
# modest so a genuinely hot emerging-artist story can still outrank routine superstar news.
DEFAULT_TENTPOLES = {
    "drake", "kendrick lamar", "nicki minaj", "cardi b", "travis scott", "future",
    "young thug", "lil wayne", "lil durk", "playboi carti", "tyler the creator",
    "doechii", "glorilla", "sexyy red", "21 savage", "metro boomin", "eminem",
    "50 cent", "jay-z", "jay z", "kanye west", "ye",
}
TENTPOLES = DEFAULT_TENTPOLES | {
    x.strip().casefold() for x in os.environ.get("RAPWIRE_TENTPOLE_ARTISTS", "").split(",") if x.strip()
}

HEAT_SIGNALS: tuple[tuple[str, float, str], ...] = (
    ("diss", 9.0, "diss/public conflict"),
    ("fires back", 9.0, "direct response"),
    ("responds", 8.0, "direct response"),
    ("response", 6.0, "response"),
    ("beef", 7.0, "public beef"),
    ("reunion", 8.0, "reunion"),
    ("surprise", 7.0, "surprise development"),
    ("first look", 6.0, "first-look value"),
    ("breaks record", 9.0, "record-setting moment"),
    ("breaks the record", 9.0, "record-setting moment"),
    ("number one", 7.0, "chart milestone"),
    ("#1", 7.0, "chart milestone"),
    ("sold out", 6.0, "sellout milestone"),
    ("sells out", 6.0, "sellout milestone"),
    ("announces", 3.0, "new announcement"),
    ("drops", 4.0, "new drop"),
    ("releases", 3.0, "new release"),
    ("premieres", 4.0, "premiere"),
    ("signs", 4.0, "new signing"),
)

IMPACT_SIGNALS: tuple[tuple[str, float], ...] = (
    ("grammy", 5.0), ("billboard", 4.0), ("album", 3.0), ("mixtape", 3.0),
    ("tour", 3.0), ("festival", 2.0), ("concert", 2.0), ("label", 2.5),
    ("deal", 2.5), ("collab", 2.5), ("collaboration", 2.5), ("single", 1.5),
)

FLUFF_TERMS = (
    "birthday", "adorable", "daddy duties", "relationship goals", "on vacay", "vacation",
    "outfit", "thirst trap", "roommate diaries", "scenarioz", "spotted leaving", "new look",
)
SENSITIVE_TERMS = (
    "arrest", "arrested", "charged", "charge", "accused", "alleged", "allegedly", "lawsuit",
    "indicted", "trial", "court", "sentenced", "plea", "shooting", "shot", "killed", "murder",
    "dead", "dies", "death", "assault", "abuse", "rape", "convicted", "federal case",
)
UNCERTAINTY_TERMS = ("rumor", "rumoured", "rumored", "unconfirmed", "reportedly", "sources say")


@dataclass(frozen=True)
class StoryScore:
    score: float
    priority: str
    lane: str
    reasons: tuple[str, ...]
    entity: str
    duplicate_of: str = ""


@dataclass(frozen=True)
class RankedObject:
    item: Any
    ranking: StoryScore


def _first(story: Mapping[str, Any], *keys: str, default: Any = "") -> Any:
    for key in keys:
        value = story.get(key)
        if value not in (None, "", []):
            return value
    return default


def _mapping(story: Any) -> dict[str, Any]:
    if isinstance(story, Mapping):
        return dict(story)
    data = getattr(story, "__dict__", None)
    if isinstance(data, dict):
        return dict(data)
    return {
        key: getattr(story, key)
        for key in ("guid", "id", "title", "headline", "description", "summary", "link", "url",
                    "published_at", "published", "source_handle", "source", "image_url", "image")
        if hasattr(story, key)
    }


def _text(story: Mapping[str, Any]) -> str:
    title = str(_first(story, "title", "headline"))
    body = str(_first(story, "description", "summary", "story", "body"))
    return re.sub(r"\s+", " ", f"{title} {body}").strip()


def _title(story: Mapping[str, Any]) -> str:
    title = str(_first(story, "title", "headline"))
    return re.sub(r"^\s*@[A-Za-z0-9._]+\s*:\s*", "", title).strip()


def _parse_date(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        dt = value
    elif value:
        raw = str(value).strip()
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            try:
                from email.utils import parsedate_to_datetime
                dt = parsedate_to_datetime(raw)
            except Exception:
                return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _published(story: Mapping[str, Any]) -> datetime | None:
    return _parse_date(_first(story, "published_at", "published", "pub_date", "created_at", "source_published_at"))


def _source_handle(story: Mapping[str, Any]) -> str:
    explicit = str(_first(story, "source_handle", "handle")).strip().lstrip("@").casefold()
    if explicit:
        return explicit
    title = str(_first(story, "title", "headline"))
    match = re.match(r"\s*@([A-Za-z0-9._]+)\s*:", title)
    return match.group(1).casefold() if match else ""


def _domain(story: Mapping[str, Any]) -> str:
    url = str(_first(story, "link", "url", "source_url"))
    host = urlparse(url).netloc.casefold().removeprefix("www.")
    return host.split(":", 1)[0]


def source_trust(story: Mapping[str, Any]) -> float:
    handle = _source_handle(story)
    if handle in SOURCE_TRUST:
        return SOURCE_TRUST[handle]
    domain = _domain(story)
    if domain in HIGH_AUTHORITY_DOMAINS:
        return 14.0
    if domain in MID_AUTHORITY_DOMAINS:
        return 10.0
    return 5.0


def _lane(text: str) -> str:
    blob = text.casefold()
    if any(x in blob for x in ("gta 6", "grand theft auto", "rockstar games")):
        return "gta"
    if any(x in blob for x in SENSITIVE_TERMS):
        return "legal"
    if any(x in blob for x in ("diss", "beef", "fires back", "responds", "feud")):
        return "beef"
    if any(x in blob for x in ("album", "mixtape", "single", "song", "track", "tour", "concert", "festival", "video")):
        return "music"
    if any(x in blob for x in ("label", "deal", "signs", "contract", "business", "catalog", "publishing")):
        return "business"
    if any(x in blob for x in ("breaking", "just in", "developing")):
        return "breaking"
    return "culture"


def _primary_entity(story: Mapping[str, Any]) -> str:
    explicit = str(_first(story, "featured_person", "featured_artist", "artist", "entity")).strip()
    if explicit:
        return explicit.casefold()
    blob = f" {_title(story).casefold()} "
    for artist in sorted(TENTPOLES, key=len, reverse=True):
        if re.search(rf"(?<![a-z0-9]){re.escape(artist)}(?![a-z0-9])", blob):
            return artist
    # Best-effort fallback: the first 2-3 title tokens before a strong verb.
    clean = re.sub(r"[^A-Za-z0-9'&.-]+", " ", _title(story)).strip()
    if not clean:
        return ""
    before_verb = re.split(r"\b(?:drops|releases|responds|announces|wins|signs|faces|says|is|was|has|gets)\b", clean, maxsplit=1, flags=re.I)[0]
    tokens = before_verb.split()[:3]
    candidate = " ".join(tokens).casefold().strip()
    return candidate if 1 <= len(tokens) <= 3 else ""


def _external_momentum(story: Mapping[str, Any]) -> float:
    """Use optional upstream trend/velocity signals when a collector provides them."""
    values: list[float] = []
    for key in ("trend_score", "velocity", "engagement_score", "momentum"):
        raw = story.get(key)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value <= 1:
            value *= 100
        values.append(max(0.0, min(100.0, value)))
    if not values:
        return 0.0
    return min(15.0, max(values) * 0.15)


def _corroborations(story: Mapping[str, Any]) -> int:
    raw = _first(story, "corroboration_count", "source_count", "sources", default=1)
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)):
        return max(1, len(raw))
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 1


def _similarity(a: Mapping[str, Any], b: Mapping[str, Any]) -> float:
    def norm(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()
    ta, tb = norm(_title(a)), norm(_title(b))
    if not ta or not tb:
        return 0.0
    sa, sb = set(ta.split()), set(tb.split())
    jaccard = len(sa & sb) / max(1, len(sa | sb))
    sequence = SequenceMatcher(None, ta, tb).ratio()
    return max(jaccard, sequence)


def _story_id(story: Mapping[str, Any]) -> str:
    return str(_first(story, "guid", "id", "source_guid", "link", "url", default=_title(story)))


def _priority(score: float) -> str:
    if score >= 80:
        return "P1"
    if score >= 65:
        return "P2"
    if score >= 50:
        return "P3"
    return "P4"


def base_score(story: Mapping[str, Any], now: datetime | None = None) -> StoryScore:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    text = _text(story)
    blob = text.casefold()
    reasons: list[str] = []
    score = 0.0

    published = _published(story)
    if published is None:
        freshness = 2.0
        reasons.append("missing publication time")
    else:
        age_hours = max(0.0, (now - published).total_seconds() / 3600.0)
        freshness = 32.0 * math.pow(0.5, age_hours / 18.0)
        if age_hours <= 3:
            reasons.append("very fresh")
        elif age_hours <= 12:
            reasons.append("fresh")
        elif age_hours > 36:
            reasons.append("aging")
    score += freshness

    trust = source_trust(story)
    score += trust
    reasons.append(f"source prior {trust:.0f}/14")

    heat = 0.0
    seen_heat: set[str] = set()
    for term, weight, label in HEAT_SIGNALS:
        if term in blob and label not in seen_heat:
            heat += weight
            seen_heat.add(label)
    heat = min(20.0, heat)
    if heat:
        score += heat
        reasons.append(f"cultural heat +{heat:.0f}")

    impact = min(10.0, sum(weight for term, weight in IMPACT_SIGNALS if term in blob))
    if impact:
        score += impact
        reasons.append(f"impact +{impact:.0f}")

    entity = _primary_entity(story)
    if entity in TENTPOLES:
        score += 8.0
        reasons.append("tent-pole artist")

    image = str(_first(story, "image_url", "image", "og_image"))
    if image.startswith(("http://", "https://")):
        score += 4.0
        reasons.append("usable visual")
    else:
        score -= 3.0
        reasons.append("weak visual")

    momentum = _external_momentum(story)
    if momentum:
        score += momentum
        reasons.append(f"upstream momentum +{momentum:.0f}")

    if any(term in blob for term in FLUFF_TERMS):
        score -= 18.0
        reasons.append("lifestyle/fluff penalty")

    sensitive = any(term in blob for term in SENSITIVE_TERMS)
    uncertain = any(term in blob for term in UNCERTAINTY_TERMS)
    corroborations = _corroborations(story)
    if uncertain:
        score -= 8.0
        reasons.append("uncertainty penalty")
    if sensitive and corroborations < 2:
        if trust < 10:
            score = min(score, 54.0)
            reasons.append("uncorroborated sensitive claim capped")
        else:
            score -= 6.0
            reasons.append("sensitive claim needs corroboration")
    if sensitive and uncertain and corroborations < 2:
        score = min(score, 44.0)
        reasons.append("unconfirmed sensitive claim capped")

    score = max(0.0, min(100.0, score))
    return StoryScore(round(score, 1), _priority(score), _lane(text), tuple(reasons), entity)


def rank_stories(
    stories: Iterable[Mapping[str, Any]],
    *,
    recent_stories: Iterable[Mapping[str, Any]] = (),
    now: datetime | None = None,
    limit: int | None = None,
    min_score: float = MIN_SCORE,
) -> list[dict[str, Any]]:
    """Return copied story dicts enriched with explainable newsroom ranking metadata."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    current = [dict(story) for story in stories]
    history = [dict(story) for story in recent_stories]
    prelim = [(story, base_score(story, now)) for story in current]
    prelim.sort(key=lambda pair: pair[1].score, reverse=True)

    scored: list[tuple[dict[str, Any], StoryScore]] = []
    higher: list[dict[str, Any]] = []
    for story, initial in prelim:
        score = initial.score
        reasons = list(initial.reasons)
        duplicate_of = ""

        for previous in history + higher:
            similarity = _similarity(story, previous)
            if similarity >= 0.82:
                penalty = 48.0 if previous in history else 34.0
                score -= penalty
                duplicate_of = _story_id(previous)
                reasons.append(f"near-duplicate -{penalty:.0f}")
                break

        if initial.entity:
            recent_same_entity = 0
            for previous in history:
                previous_map = dict(previous)
                if _primary_entity(previous_map) != initial.entity:
                    continue
                published = _published(previous_map)
                if published is None or (now - published).total_seconds() <= ENTITY_COOLDOWN_HOURS * 3600:
                    recent_same_entity += 1
            if recent_same_entity:
                penalty = min(24.0, 10.0 + 5.0 * (recent_same_entity - 1))
                score -= penalty
                reasons.append(f"entity fatigue -{penalty:.0f}")

        same_entity_in_batch = sum(
            1 for previous in higher
            if initial.entity and _primary_entity(previous) == initial.entity
        )
        if same_entity_in_batch:
            penalty = min(16.0, 8.0 * same_entity_in_batch)
            score -= penalty
            reasons.append(f"batch variety -{penalty:.0f}")

        score = max(0.0, min(100.0, score))
        ranking = StoryScore(
            round(score, 1), _priority(score), initial.lane, tuple(reasons), initial.entity, duplicate_of
        )
        scored.append((story, ranking))
        higher.append(story)

    scored.sort(key=lambda pair: pair[1].score, reverse=True)
    output: list[dict[str, Any]] = []
    for story, ranking in scored:
        if ranking.score < min_score:
            continue
        enriched = dict(story)
        enriched.update({
            "viral_score": ranking.score,
            "viral_priority": ranking.priority,
            "viral_lane": ranking.lane,
            "viral_entity": ranking.entity,
            "viral_reasons": list(ranking.reasons),
            "duplicate_of": ranking.duplicate_of,
        })
        output.append(enriched)
        if limit is not None and len(output) >= limit:
            break
    return output


def rank_objects(
    items: Iterable[Any],
    *,
    recent_stories: Iterable[Mapping[str, Any]] = (),
    now: datetime | None = None,
    limit: int | None = None,
    min_score: float = MIN_SCORE,
) -> list[RankedObject]:
    """Rank arbitrary candidate objects while preserving object identity for existing code."""
    original = list(items)
    by_marker = {id(item): item for item in original}
    wrapped: list[dict[str, Any]] = []
    for item in original:
        data = _mapping(item)
        data["__object_marker"] = id(item)
        wrapped.append(data)
    ranked = rank_stories(
        wrapped,
        recent_stories=recent_stories,
        now=now,
        limit=limit,
        min_score=min_score,
    )
    result: list[RankedObject] = []
    for story in ranked:
        marker = story["__object_marker"]
        ranking = StoryScore(
            float(story["viral_score"]),
            str(story["viral_priority"]),
            str(story["viral_lane"]),
            tuple(story["viral_reasons"]),
            str(story["viral_entity"]),
            str(story.get("duplicate_of", "")),
        )
        result.append(RankedObject(by_marker[marker], ranking))
    return result


def select_diverse(ranked: Sequence[RankedObject], limit: int = DEFAULT_SHORTLIST) -> list[RankedObject]:
    """Build a shortlist without allowing one artist/topic to monopolize the LLM prompt."""
    selected: list[RankedObject] = []
    entity_counts: dict[str, int] = {}
    lane_counts: dict[str, int] = {}
    for item in ranked:
        entity = item.ranking.entity
        lane = item.ranking.lane
        if entity and entity_counts.get(entity, 0) >= 2:
            continue
        if lane_counts.get(lane, 0) >= 3 and len(selected) >= 4:
            continue
        selected.append(item)
        if entity:
            entity_counts[entity] = entity_counts.get(entity, 0) + 1
        lane_counts[lane] = lane_counts.get(lane, 0) + 1
        if len(selected) >= limit:
            break
    return selected


def debug_lines(ranked: Sequence[RankedObject], top: int = 7) -> list[str]:
    lines: list[str] = []
    for index, item in enumerate(ranked[:top], 1):
        title = _title(_mapping(item.item))[:100]
        reasons = "; ".join(item.ranking.reasons[-4:])
        lines.append(
            f"#{index} {item.ranking.priority} {item.ranking.score:05.1f} "
            f"[{item.ranking.lane}] {title} :: {reasons}"
        )
    return lines
