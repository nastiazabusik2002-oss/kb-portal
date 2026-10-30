"""Шаблони з Google-таблиці команди (та сама, що в розширенні «Шаблони саппорту»).

Лист «ЧАТИ»: рядок 0 — повний текст українською, рядок 2 — короткі назви,
з рядка 4 — у колонці A мова/сайт (English, Tickets.ge, Tickets.az. …),
далі переклади по колонках.
"""
import re
import time
from urllib.parse import quote

import httpx

from . import config

CHAT_SHEET = "ЧАТИ"
TTL = 300

_cache = {"at": 0.0, "data": None}

# Внутрішні шаблони для звернення у відділ (з «Шаблони саппорту»)
INTERNAL = {
    "Виписка": [
        ("додати багаж", "додайте будь ласка багаж для _ на сегмент _ _ кг"),
        ("уточнити за багаж", "підкажіть який багаж тут можемо запропонувати пасажиру, вартість і габарити для одного"),
        ("не працює ПНР", "на жаль не працює пнр на сайті АК, перевірте чи коректний"),
        ("тур код", "підкажіть будь ласка який тур код, в адмінці і в замаді не знайшлось"),
        ("місця", "підкажіть чи можемо додати місця"),
        ("чи був багаж", "підкажіть, будь ласка, чи було оформлено багаж, адже пасажиру прийшлось платити в аеропорту"),
        ("пришвидшити виписку", "пришвидшіть будь ласка виписку"),
        ("зміни до виписки", "пасажир повідомив що помилився даними у _, коректні дані _ чи можемо змінити?"),
    ],
    # У «Шаблони саппорту» ці три підписані як «ССГ» — відносимо до ССО (CCO consultation)
    "ССО": [
        ("карта місць", "чи можете будь ласка надати карту місць?"),
        ("пошта Раян", "чи можете дати, будь ласка, пошту для ryanair"),
        ("мильна карта", "чи можемо додати мильну карту _"),
        ("пришвидшити опрацювання", "підкажіть будь ласка, чи можемо пришвидшити опрацювання запиту"),
    ],
    "*": [
        ("пришвидшити опрацювання", "підкажіть будь ласка, чи можемо пришвидшити опрацювання запиту"),
    ],
}

# Сайт → мова, якщо в таблиці немає окремого рядка для сайту
SITE_LANG = {
    "travelfrom.es": "Español", "travelfrom.fr": "Français", "kissandfly.it": "Italiano",
    "kissandfly.de": "Deutsch", "kissandfly.at": "Deutsch", "travelfrom.nl": "Nederlands",
    "tickets.com.tr": "Turkish", "alrehlat.com": "Arabic", "mytickets.ae": "Arabic",
    "tickets.pl": "Polski", "tickets.ee": "Estonian",
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9.]", "", (s or "").lower()).strip(".")


async def _fetch() -> dict:
    url = (f"https://sheets.googleapis.com/v4/spreadsheets/{config.SHEET_ID}/values/"
           f"{quote(CHAT_SHEET)}?key={config.SHEETS_API_KEY}")
    async with httpx.AsyncClient(timeout=20.0) as c:
        r = await c.get(url)
    r.raise_for_status()
    values = r.json().get("values", [])
    full = values[0] if values else []
    labels = values[2] if len(values) > 2 else []
    topics = []
    for c_idx in range(1, max(len(full), len(labels))):
        label = (labels[c_idx] if c_idx < len(labels) else "").strip()
        ua = (full[c_idx] if c_idx < len(full) else "").strip()
        if label or ua:
            topics.append({"col": c_idx, "label": " ".join(label.split()) or ua[:40] + "…", "ua": ua, "tr": {}})
    langs = []
    for row in values[4:]:
        lang = (row[0] if row else "").strip()
        if not lang or len(lang) > 40:
            continue
        if lang not in langs:
            langs.append(lang)
        for t in topics:
            txt = (row[t["col"]] if t["col"] < len(row) else "").strip()
            if txt:
                t["tr"][lang] = (t["tr"][lang] + "\n\n" + txt) if lang in t["tr"] else txt
    for t in topics:
        t.pop("col")
    return {"topics": [t for t in topics if t["ua"]], "langs": langs}


async def chats() -> dict:
    if _cache["data"] is None or time.time() - _cache["at"] > TTL:
        try:
            _cache["data"] = await _fetch()
            _cache["at"] = time.time()
        except Exception:
            if _cache["data"] is None:
                return {"topics": [], "langs": []}
    return _cache["data"]


def lang_for_site(site: str, langs: list[str]) -> str | None:
    """Рядок таблиці для сайту клієнта: спершу рядок самого сайту
    (Tickets.ge, Tickets.az. …), далі мова сайту, інакше English."""
    s = _norm(site)
    for l in langs:
        if s and _norm(l.split()[0] if l.split() else l) == s:
            return l
    want = SITE_LANG.get(s)
    if want:
        for l in langs:
            if l.strip().lower() == want.lower():
                return l
    for l in langs:
        if l.strip().lower() == "english":
            return l
    return None


def site_row(site: str, langs: list[str]) -> str | None:
    """Окремий рядок саме цього сайту (Tickets.ge, Tickets.az. …), якщо є."""
    s = _norm(site)
    for l in langs:
        if s and _norm(l.split()[0] if l.split() else l) == s:
            return l
    return None


def language_rows(langs: list[str]) -> list[str]:
    """Рядки-мови (без рядків окремих сайтів)."""
    return [l for l in langs if "." not in l.split()[0]] if langs else []


def internal_for(group: str) -> list[dict]:
    items = INTERNAL.get(group) or INTERNAL["*"]
    return [{"label": a, "text": b} for a, b in items]
