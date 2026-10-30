"""Переклад через OpenAI. Ключ лише на сервері; переклади кешуються на диск,
щоб той самий текст не оплачувати двічі (і між перезапусками пода)."""
import asyncio
import hashlib
import json
import re

import httpx

from . import config

CYRILLIC_RE = re.compile(r"[Ѐ-ӿ]")
LETTER_RE = re.compile(r"[^\W\d_]", re.U)
MAX_LEN = 4000

PROMPT_UK = (
    "Ти перекладач служби підтримки. Перекладай текст користувача на українську мову. "
    "Відповідай ЛИШЕ перекладом, без лапок, приміток чи пояснень. "
    "Імена людей, номери замовлень, посилання та коди залишай без змін."
)


def prompt_to_lang_of(sample: str) -> str:
    return (
        "Ти перекладач служби підтримки. Визнач мову ЗРАЗКА нижче і переклади текст користувача саме цією мовою. "
        "Тон ввічливий, як у служби підтримки. Відповідай ЛИШЕ перекладом, без лапок, приміток чи пояснень. "
        "Імена людей, номери замовлень, посилання та коди залишай без змін.\n\nЗРАЗОК:\n" + sample[:500]
    )


def needs_translation(text: str) -> bool:
    t = (text or "").strip()
    return bool(t) and len(t) <= MAX_LEN and bool(LETTER_RE.search(t)) and not CYRILLIC_RE.search(t)


_cache: dict[str, str] = {}
_cache_file = config.DATA_DIR / "translations.json"
_sem = asyncio.Semaphore(6)
_dirty = False


def load_cache():
    global _cache
    try:
        _cache = json.loads(_cache_file.read_text(encoding="utf-8"))
    except Exception:
        _cache = {}


def save_cache():
    global _dirty
    if not _dirty:
        return
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _cache_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(_cache, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_cache_file)
    _dirty = False


def _key(prompt: str, text: str) -> str:
    return hashlib.sha1((prompt + "\x00" + text).encode("utf-8")).hexdigest()


async def _call(prompt: str, text: str) -> str:
    async with _sem:
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"},
                json={"model": config.OPENAI_MODEL, "temperature": 0,
                      "messages": [{"role": "system", "content": prompt}, {"role": "user", "content": text}]},
            )
    if r.status_code >= 400:
        raise RuntimeError(f"OpenAI {r.status_code}: {r.text[:200]}")
    return (r.json()["choices"][0]["message"]["content"] or "").strip()


async def to_uk(text: str) -> str | None:
    text = (text or "").strip()
    if not needs_translation(text):
        return None
    k = _key(PROMPT_UK, text)
    if k not in _cache:
        global _dirty
        _cache[k] = await _call(PROMPT_UK, text)
        _dirty = True
    tr = _cache[k]
    # Модель повернула той самий текст (номер, e-mail) — перекладу немає
    return None if tr.strip() == text else tr


async def to_lang_of(text: str, sample: str) -> str:
    return await _call(prompt_to_lang_of(sample), text.strip())


async def pick_lang(sample: str, options: list[str]) -> str | None:
    """Якою з мов таблиці шаблонів написав клієнт (кешується)."""
    sample = (sample or "").strip()[:400]
    if not sample or not options:
        return None
    prompt = ("Визнач мову ЗРАЗКА. Відповідай РІВНО одним варіантом зі списку (як написано) або NONE.\nСписок: "
              + " | ".join(options))
    k = _key(prompt, sample)
    if k not in _cache:
        global _dirty
        _cache[k] = await _call(prompt, sample)
        _dirty = True
    ans = _cache[k].strip()
    return next((o for o in options if o.strip().lower() == ans.lower()), None)
