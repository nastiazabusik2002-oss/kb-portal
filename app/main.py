"""TTN Chat Desk — сервер.

Zammad лишається «двигуном»: усі тикети, теги, тригери й статистика живуть
там. Сервер лише:
  • тримає спільний список чатів (один пошук у Zammad на всіх агентів);
  • виконує дії агента від його імені (X-On-Behalf-Of);
  • перекладає (ключ OpenAI тільки тут) і віддає шаблони з таблиці.
"""
import asyncio
import base64
import contextlib
import html
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import config, templates_sheet, translate, zammad
from .zammad import ZammadError

STATIC = Path(__file__).resolve().parent.parent / "static"
OVERRIDE_TTL = 20  # с — поки Elasticsearch Zammad не проіндексував зміну


# ── Спільний стан черги ───────────────────────────────────────
class Store:
    def __init__(self):
        self.active: list[dict] = []        # відкриті чати (new/open)
        self.taken: set[int] = set()        # з тегом chat-taken
        self.closed: list[dict] = []
        self.closed_at = 0.0
        self.overrides: dict[int, dict] = {}  # локальні зміни до переіндексації
        self.tag_hist: dict[str, str | None] = {}
        self.updated_at = 0.0
        self.error = ""
        self.locks: dict[int, asyncio.Lock] = {}

    def lock(self, tid: int) -> asyncio.Lock:
        return self.locks.setdefault(tid, asyncio.Lock())

    def set_override(self, tid: int, taken: bool, owner_id: int | None):
        self.overrides[tid] = {"taken": taken, "owner_id": owner_id, "until": time.time() + OVERRIDE_TTL}

    def override(self, tid: int):
        o = self.overrides.get(tid)
        if o and o["until"] > time.time():
            return o
        self.overrides.pop(tid, None)
        return None


store = Store()

Q_CHAT = (f'title:"{config.CHAT_TITLE}" AND priority_id:{config.CHAT_PRIORITY_ID}'
          + "".join(f' AND NOT title:"{x}"' for x in config.EXCLUDED_TITLES))
Q_ACTIVE = f"{Q_CHAT} AND state.name:(new OR open)"


def is_chat(t: dict) -> bool:
    title = t.get("title") or ""
    return (config.CHAT_TITLE in title and t.get("priority_id") == config.CHAT_PRIORITY_ID
            and title not in config.EXCLUDED_TITLES)


def site_of(t: dict) -> str:
    title = t.get("title") or ""
    return title.split(config.CHAT_TITLE, 1)[-1].strip() if config.CHAT_TITLE in title else ""


def is_closed_state(state_id) -> bool:
    return state_id in (4, 5)


async def tag_stale(t: dict) -> bool:
    """Тег «протух»: чат закривали ПІСЛЯ того, як його взяли (переоткритий
    чат має бути в загальній черзі). Підстраховка до тригера Zammad."""
    if not t.get("last_close_at"):
        return False
    key = f"{t['id']}|{t.get('updated_at')}"
    if key not in store.tag_hist:
        try:
            store.tag_hist[key] = await zammad.tag_added_at(t["id"])
        except ZammadError:
            store.tag_hist[key] = None
    at = store.tag_hist[key]
    return bool(at) and t["last_close_at"] > at


# last_contact_customer_at у Zammad = «чекає з» (оновлюється лише на першому
# повідомленні клієнта після відповіді агента). Для сортування й міток беремо
# час САМЕ останнього повідомлення клієнта — з статей, з кешем по updated_at.
_last_msg: dict[int, tuple[str, tuple]] = {}
_art_sem = asyncio.Semaphore(8)
_BOT_RE = re.compile(r"\b(bot|ai)\b", re.I)


async def wait_info(arts: list) -> tuple[str | None, str | None]:
    """(час останнього повідомлення клієнта, «чекає з»).
    «Чекає з» — перше повідомлення клієнта, на яке ще не відповів ЖИВИЙ агент
    (відповідь AI-бота «передаю колезі» очікування не зупиняє). None — відповіли."""
    last, waiting = None, None
    for a in sorted(arts or [], key=lambda x: x.get("created_at") or ""):
        at = a.get("created_at")
        if a.get("sender") == "Customer":
            last = at
            waiting = waiting or at
        elif a.get("sender") == "Agent" and not a.get("internal"):
            if not _BOT_RE.search((await zammad.user(a.get("created_by_id")))["name"]):
                waiting = None
    return last, waiting


async def last_customer_msg(t: dict) -> tuple:
    tid, upd = t["id"], t.get("updated_at") or ""
    hit = _last_msg.get(tid)
    if hit and hit[0] == upd:
        return hit[1]
    async with _art_sem:
        try:
            arts = await zammad.api("GET", f"/ticket_articles/by_ticket/{tid}")
        except ZammadError:
            return t.get("last_contact_customer_at"), None
    info = await wait_info(arts)
    _last_msg[tid] = (upd, info)
    return info


async def slim(t: dict) -> dict:
    cust = await zammad.user(t.get("customer_id"))
    return {
        "id": t["id"], "number": t.get("number"), "site": site_of(t),
        "customer_id": t.get("customer_id"), "customer": cust["name"],
        "owner_id": t.get("owner_id"), "state_id": t.get("state_id"),
        "booking": t.get(config.BOOKING_FIELD) or "",
        "created_at": t.get("created_at"), "updated_at": t.get("updated_at"),
        "last_customer_at": t.get("_last_msg") or t.get("last_contact_customer_at"),
        "waiting_since": t.get("_waiting"),
        "last_close_at": t.get("last_close_at"),
    }


async def refresh_active():
    active, taken = await asyncio.gather(
        zammad.search(Q_ACTIVE),
        zammad.search(f"{Q_ACTIVE} AND tags:{config.TAKEN_TAG}", expand=False),
    )
    active = [t for t in active if is_chat(t)]
    taken_ids = {int(x["id"] if isinstance(x, dict) else x) for x in taken}
    # Підчищаємо протухлі теги в переоткритих чатах
    for t in active:
        if t["id"] in taken_ids and t.get("last_close_at") and await tag_stale(t):
            taken_ids.discard(t["id"])
            with contextlib.suppress(ZammadError):
                await zammad.remove_tag(t["id"], config.TAKEN_TAG)
    lasts = await asyncio.gather(*(last_customer_msg(t) for t in active))
    for t, (at, waiting) in zip(active, lasts):
        t["_last_msg"], t["_waiting"] = at, waiting
    store.active = await asyncio.gather(*(slim(t) for t in active))
    store.taken = taken_ids
    store.updated_at = time.time()
    store.error = ""


async def refresh_closed(force=False):
    if not force and time.time() - store.closed_at < 30:
        return
    items = await zammad.search(f"{Q_CHAT} AND state.name:(closed OR merged)", per_page=50, max_pages=1)
    store.closed = await asyncio.gather(*(slim(t) for t in items if is_chat(t)))
    store.closed_at = time.time()


async def refresher():
    while True:
        try:
            await refresh_active()
        except Exception as e:  # мережа/Zammad недоступний — показуємо в UI, пробуємо далі
            store.error = str(e)[:200]
        translate.save_cache()
        await asyncio.sleep(5)


def category(t: dict, uid: int) -> str:
    if is_closed_state(t.get("state_id")):
        return "history"
    o = store.override(t["id"])
    taken = o["taken"] if o else t["id"] in store.taken
    owner = (o or {}).get("owner_id") or t.get("owner_id")
    if not taken or not owner or owner == config.NO_OWNER_ID:
        return "queue"
    return "mine" if owner == uid else "others"


def owner_of(t: dict) -> int | None:
    o = store.override(t["id"])
    return (o or {}).get("owner_id") or t.get("owner_id")


# ── Застосунок ────────────────────────────────────────────────
def _session_secret() -> str:
    if config.SESSION_SECRET:
        return config.SESSION_SECRET
    # Немає в Secret — генеруємо і тримаємо у DATA_DIR, щоб перезапуск не розлогінював усіх
    p = config.DATA_DIR / "session_secret"
    try:
        return p.read_text().strip()
    except FileNotFoundError:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        s = secrets.token_hex(32)
        p.write_text(s)
        return s


@contextlib.asynccontextmanager
async def lifespan(app):
    translate.load_cache()
    task = asyncio.create_task(refresher())
    yield
    task.cancel()
    translate.save_cache()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
app.add_middleware(SessionMiddleware, secret_key=_session_secret(), session_cookie="desk_session",
                   max_age=30 * 24 * 3600, same_site="lax", https_only=config.COOKIE_SECURE)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def same_origin_writes(request: Request, call_next):
    # Захист від запитів з чужих сайтів: зміни приймаємо лише з нашої сторінки
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and origin.split("://", 1)[-1] != request.headers.get("host"):
            return JSONResponse({"detail": "bad origin"}, status_code=403)
    return await call_next(request)


@app.exception_handler(ZammadError)
async def zammad_error(request: Request, exc: ZammadError):
    status = 403 if exc.status in (401, 403) else 502
    msg = "Немає доступу в Zammad" if status == 403 else str(exc)
    return JSONResponse({"detail": msg}, status_code=status)


def me(request: Request) -> dict:
    s = request.session
    if not s.get("uid"):
        raise HTTPException(401, "Потрібно увійти")
    return {"id": s["uid"], "name": s.get("name", ""), "login": s.get("login", "")}


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
async def healthz():
    return {"ok": True, "queue_age": round(time.time() - store.updated_at, 1), "error": store.error}


# ── Вхід ──────────────────────────────────────────────────────
@app.post("/api/login")
async def login(request: Request):
    data = await request.json()
    lg, pw = (data.get("login") or "").strip(), data.get("password") or ""
    if not lg or not pw:
        raise HTTPException(400, "Введіть логін і пароль")
    u = await zammad.verify_login(lg, pw)
    if not u:
        raise HTTPException(401, "Невірний логін або пароль Zammad")
    if not await zammad.is_agent(u):
        raise HTTPException(403, "Цей акаунт не має ролі агента в Zammad")
    name = " ".join(x for x in [u.get("firstname"), u.get("lastname")] if x) or u.get("login")
    request.session.clear()
    request.session.update({"uid": u["id"], "name": name, "login": u.get("login")})
    return {"id": u["id"], "name": name}


@app.post("/api/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
async def get_me(request: Request):
    return me(request)


@app.get("/api/meta")
async def meta(request: Request):
    me(request)
    reasons, tpl = await asyncio.gather(zammad.reasons(), templates_sheet.chats())
    return {"reasons": reasons, "auto_reason": config.AUTO_REASON, "templates": tpl["topics"],
            "depts": [{"id": gid, "name": name, "templates": templates_sheet.internal_for(name)}
                      for gid, name in config.DEPT_GROUPS.items()]}


# ── Список чатів ──────────────────────────────────────────────
@app.get("/api/chats")
async def chats(request: Request, tab: str = "queue", agent: int = 0):
    """tab: queue | mine | agent (чати конкретного агента, agent=id) | history"""
    u = me(request)
    counts = {"queue": 0, "mine": 0, "others": 0}
    load: dict[int, int] = {}   # хто скільки чатів зараз веде
    rows = []
    for t in store.active:
        cat = category(t, u["id"])
        counts[cat] = counts.get(cat, 0) + 1
        if cat in ("mine", "others"):
            oid = owner_of(t)
            load[oid] = load.get(oid, 0) + 1
            if tab == "agent" and oid == agent:
                rows.append(t)
        if cat == tab:
            rows.append(t)
    agents = [{"id": oid, "name": (await zammad.user(oid))["name"], "count": n, "me": oid == u["id"]}
              for oid, n in load.items()]
    agents.sort(key=lambda a: (-a["count"], a["name"]))
    if tab == "history":
        await refresh_closed()
        rows = list(store.closed)
    out = []
    for t in rows:
        oid = owner_of(t)
        owner = (await zammad.user(oid))["name"] if oid and oid != config.NO_OWNER_ID else ""
        out.append({**t, "category": category(t, u["id"]) if tab != "history" else "history", "owner": owner})
    if tab == "agent":
        tab = f"agent:{agent}"
    # Зверху — чат, де клієнт написав останнім (як у месенджері)
    key = (lambda t: max(t.get("last_customer_at") or "", t.get("created_at") or "")
           if tab != "history" else (t.get("updated_at") or ""))
    out.sort(key=key, reverse=True)
    # Для звуків і міток «нове повідомлення» — по всіх чатах, незалежно від вкладки
    activity = {t["id"]: max(t.get("last_customer_at") or "", t.get("created_at") or "")
                for t in store.active if category(t, u["id"]) in ("queue", "mine")}
    return {"tab": tab, "counts": counts, "chats": out, "agents": agents, "error": store.error,
            "age": round(time.time() - store.updated_at, 1),
            "queue_ids": [t["id"] for t in store.active if category(t, u["id"]) == "queue"],
            "mine": {i: a for i, a in activity.items()
                     if any(t["id"] == i and category(t, u["id"]) == "mine" for t in store.active)}}


# ── Тикет (чат або тикет відділу) ─────────────────────────────
def _when(s: str | None) -> str:
    return s or ""


async def _article(a: dict, ticket_id: int) -> dict:
    sender = a.get("sender")
    if sender == "Customer":
        kind = "c"
    elif a.get("internal"):
        kind = "note" if sender != "System" else "sys"
    elif sender == "System":
        kind = "sys"
    else:
        kind = "a"
    author = await zammad.user(a.get("created_by_id")) if kind != "c" else {"name": "", "id": 0}
    text = zammad.article_text(a)
    atts = []
    for x in a.get("attachments") or []:
        fn = x.get("filename") or "file"
        if fn.startswith("pasted-") and fn.endswith(".png"):
            continue
        mime = (x.get("preferences") or {}).get("Content-Type") or ""
        atts.append({"name": fn, "image": mime.startswith("image/"),
                     "url": f"/api/att/{ticket_id}/{a['id']}/{x['id']}"})
    return {"id": a["id"], "kind": kind, "author": author["name"], "author_id": author.get("id"),
            "text": text, "time": _when(a.get("created_at")), "type": a.get("type"),
            "attachments": atts, "translate": kind in ("c", "a") and translate.needs_translation(text)}


def _group_label(t: dict, groups: dict) -> str:
    gid = t.get("group_id")
    if gid in config.DEPT_GROUPS:
        return config.DEPT_GROUPS[gid]
    if gid == config.CHAT_GROUP_ID:
        return "Чат" if config.CHAT_TITLE in (t.get("title") or "") else "Пошта"
    return groups.get(gid, f"#{gid}")


async def _related(t: dict, uid: int) -> list[dict]:
    """Інші звернення клієнта + тикети відділів по тому самому бронюванню."""
    ids: list[int] = []
    with contextlib.suppress(ZammadError):
        r = await zammad.api("GET", "/ticket_customer", params={"customer_id": t["customer_id"]}, as_user=uid)
        ids = [int(x) for x in (r.get("ticket_ids_open") or []) + (r.get("ticket_ids_closed") or [])]
    booking = (t.get(config.BOOKING_FIELD) or "").strip()
    if booking and booking != "-":
        with contextlib.suppress(ZammadError):
            found = await zammad.search(f'{config.BOOKING_FIELD}:"{booking}"', per_page=50, max_pages=1)
            ids += [x["id"] for x in found if x.get("group_id") in config.DEPT_GROUPS]
    ids = sorted({i for i in ids if i != t["id"]}, reverse=True)[:20]

    async def one(i):
        try:
            return await zammad.api("GET", f"/tickets/{i}", as_user=uid)
        except ZammadError:
            return None  # немає доступу до групи — просто не показуємо

    groups = await zammad.groups()
    out = []
    for x in await asyncio.gather(*(one(i) for i in ids)):
        if not x:
            continue
        g = _group_label(x, groups)
        dept = x.get("group_id") in config.DEPT_GROUPS
        kind = "dept" if dept else ("chat" if config.CHAT_TITLE in (x.get("title") or "") else "mail")
        out.append({"id": x["id"], "number": x.get("number"), "title": x.get("title") or "",
                    "group": g, "dept": dept, "kind": kind,
                    "open": not is_closed_state(x.get("state_id")), "created_at": x.get("created_at")})
    out.sort(key=lambda r: (not (r["dept"] and r["open"]), not r["open"], -(r["id"])))
    return out


async def _tpl_lang(site: str, sample: str, langs: list[str]) -> str | None:
    """Мова шаблонів: рядок сайту → мова, якою пише клієнт (GPT) → мова за сайтом."""
    row = templates_sheet.site_row(site, langs)
    if row:
        return row
    if sample:
        with contextlib.suppress(Exception):
            picked = await translate.pick_lang(sample, templates_sheet.language_rows(langs))
            if picked:
                return picked
    return templates_sheet.lang_for_site(site, langs)


@app.get("/api/tickets/{tid}")
async def ticket(request: Request, tid: int, with_related: bool = True, since: str = ""):
    u = me(request)
    # Опитування відкритого чату: якщо за даними спільного списку тикет не
    # змінювався — не смикаємо Zammad зовсім (головна економія навантаження)
    if since:
        cur = next((x for x in store.active if x["id"] == tid), None)
        if cur and (cur.get("updated_at") or "") <= since:
            return {"unchanged": True}
    t, arts = await asyncio.gather(
        zammad.api("GET", f"/tickets/{tid}", as_user=u["id"]),
        zammad.api("GET", f"/ticket_articles/by_ticket/{tid}", as_user=u["id"]),
    )
    cust = await zammad.user(t.get("customer_id"))
    articles = await asyncio.gather(*(_article(a, tid) for a in arts or []))
    chat = is_chat(t)
    t["_last_msg"], t["_waiting"] = await wait_info(arts)
    tags = await zammad.tags(tid) if chat else []
    taken = config.TAKEN_TAG in tags and not await tag_stale(t)
    if chat and not is_closed_state(t.get("state_id")):
        store.set_override(tid, taken, t.get("owner_id"))
        # Якщо тикета ще немає в списку (ES не встиг) — додаємо
        if not any(x["id"] == tid for x in store.active):
            store.active.append(await slim(t))
        else:
            for i, x in enumerate(store.active):
                if x["id"] == tid:
                    store.active[i] = await slim(t)
    cat = category(await slim(t), u["id"]) if chat else None
    oid = t.get("owner_id")
    owner = (await zammad.user(oid))["name"] if oid and oid != config.NO_OWNER_ID else ""
    groups = await zammad.groups()
    tpl = await templates_sheet.chats()
    site = site_of(t)
    # Зразок мови клієнта — останнє його повідомлення не кирилицею
    sample = next((a["text"] for a in reversed(articles) if a["kind"] == "c" and translate.needs_translation(a["text"])), "")
    return {
        "id": t["id"], "number": t.get("number"), "title": t.get("title"), "site": site,
        "is_chat": chat, "group": _group_label(t, groups), "dept": t.get("group_id") in config.DEPT_GROUPS,
        "open": not is_closed_state(t.get("state_id")), "state_id": t.get("state_id"),
        "customer": cust, "booking": t.get(config.BOOKING_FIELD) or "", "reason": t.get(config.REASON_FIELD) or "",
        "category": cat, "owner": owner, "owner_id": oid, "waiting_since": t.get("_waiting"),
        "articles": articles, "updated_at": t.get("updated_at"),
        "related": await _related(t, u["id"]) if with_related else None,
        "tpl_lang": await _tpl_lang(site, sample, tpl["langs"]) if chat else None,
        "lang_sample": sample,
        "internal_templates": templates_sheet.internal_for(_group_label(t, groups)),
        "zammad_url": f"{config.ZAMMAD_URL}/#ticket/zoom/{t['id']}",
    }


@app.get("/api/att/{tid}/{aid}/{attid}")
async def attachment(request: Request, tid: int, aid: int, attid: int):
    u = me(request)
    r = await zammad.client().get(f"/ticket_attachment/{tid}/{aid}/{attid}",
                                  params={"disposition": "inline"}, headers={"X-On-Behalf-Of": str(u["id"])})
    if r.status_code >= 400:
        raise HTTPException(r.status_code, "Файл недоступний")
    return Response(r.content, media_type=r.headers.get("content-type", "application/octet-stream"),
                    headers={"Cache-Control": "private, max-age=3600"})


# ── Дії агента ────────────────────────────────────────────────
async def _take(tid: int, uid: int, force: bool) -> dict:
    """Взяти чат. Через наш сервер усі агенти беруть чати послідовно (lock),
    тож двоє одночасно один чат не візьмуть."""
    async with store.lock(tid):
        t, tg = await asyncio.gather(zammad.api("GET", f"/tickets/{tid}"), zammad.tags(tid))
        has = config.TAKEN_TAG in tg
        oid = t.get("owner_id")
        held = has and oid and oid not in (config.NO_OWNER_ID, uid) and not await tag_stale(t)
        if held and not force:
            who = (await zammad.user(oid))["name"]
            raise HTTPException(409, f"Цей чат уже веде {who}")
        if not has:
            await zammad.add_tag(tid, config.TAKEN_TAG, as_user=uid)
        if oid != uid:
            await zammad.api("PUT", f"/tickets/{tid}", json={"owner_id": uid}, as_user=uid)
        store.set_override(tid, True, uid)
        return {"ok": True}


@app.post("/api/tickets/{tid}/take")
async def take(request: Request, tid: int):
    u = me(request)
    data = await request.json()
    return await _take(tid, u["id"], bool(data.get("force")))


@app.post("/api/tickets/{tid}/transfer")
async def transfer(request: Request, tid: int):
    """Передати чат конкретному колезі: він стає власником, тег лишається,
    у чаті — внутрішня нотатка, хто кому передав."""
    u = me(request)
    data = await request.json()
    to = int(data.get("to") or 0)
    if not to or to == config.NO_OWNER_ID:
        raise HTTPException(400, "Оберіть колегу")
    target = await zammad.user(to)
    async with store.lock(tid):
        if config.TAKEN_TAG not in await zammad.tags(tid):
            await zammad.add_tag(tid, config.TAKEN_TAG, as_user=u["id"])
        await zammad.api("PUT", f"/tickets/{tid}", json={"owner_id": to}, as_user=u["id"])
        store.set_override(tid, True, to)
    note = (data.get("note") or "").strip()
    with contextlib.suppress(ZammadError):
        await zammad.api("POST", "/ticket_articles", as_user=u["id"], json={
            "ticket_id": tid, "type": "note", "internal": True, "content_type": "text/plain",
            "body": f"Чат передано: {u['name']} → {target['name']}" + (f". {note}" if note else "")})
    return {"ok": True}


@app.get("/api/agents")
async def agents(request: Request, q: str = ""):
    """Пошук колег-агентів для «Передати»."""
    me(request)
    q = q.strip()
    if len(q) < 2:
        return {"agents": []}
    users = await zammad.api("GET", "/users/search", params={"query": q, "limit": 25})
    out = []
    for x in users or []:
        if x.get("active") and await zammad.is_agent(x):
            name = " ".join(v for v in [x.get("firstname"), x.get("lastname")] if v) or x.get("login")
            out.append({"id": x["id"], "name": name, "email": x.get("email") or ""})
    return {"agents": out[:10]}


@app.get("/api/search")
async def search_booking(request: Request, booking: str = ""):
    """Пошук усіх тикетів за Booking Number (чати, листи, відділи)."""
    u = me(request)
    b = re.sub(r"[^A-Za-z0-9]", "", booking).upper()
    if len(b) < 4:
        raise HTTPException(400, "Введіть booking (мінімум 4 символи)")
    found = await zammad.search(f'{config.BOOKING_FIELD}:"{b}" OR title:"{b}"', per_page=50, max_pages=1, as_user=u["id"])
    groups = await zammad.groups()
    out = []
    for t in found:
        cust = await zammad.user(t.get("customer_id"))
        dept = t.get("group_id") in config.DEPT_GROUPS
        out.append({"id": t["id"], "number": t.get("number"), "title": t.get("title") or "",
                    "group": _group_label(t, groups), "dept": dept, "is_chat": is_chat(t) or config.CHAT_TITLE in (t.get("title") or ""),
                    "open": not is_closed_state(t.get("state_id")), "customer": cust["name"],
                    "created_at": t.get("created_at"), "updated_at": t.get("updated_at")})
    out.sort(key=lambda r: r["updated_at"] or "", reverse=True)
    return {"booking": b, "results": out}


@app.post("/api/tickets/{tid}/release")
async def release(request: Request, tid: int):
    u = me(request)
    async with store.lock(tid):
        await zammad.remove_tag(tid, config.TAKEN_TAG, as_user=u["id"])
        t = await zammad.api("GET", f"/tickets/{tid}")
        store.set_override(tid, False, t.get("owner_id"))
    return {"ok": True}


async def _upload(form_id: str, f: UploadFile, uid: int):
    content = await f.read()
    if len(content) > 15 * 1024 * 1024:
        raise HTTPException(413, f"Файл {f.filename} більший за 15 МБ")
    await zammad.api("POST", f"/upload_caches/{form_id}", as_user=uid,
                     files={"File": (f.filename or "file", content, f.content_type or "application/octet-stream")})


@app.post("/api/tickets/{tid}/reply")
async def reply(request: Request, tid: int):
    """Відповідь клієнту в чат (текст і/або файли). Відповісти з черги = взяти чат на себе."""
    u = me(request)
    form = await request.form()
    text = (form.get("text") or "").strip()
    files = [f for f in form.getlist("files") if hasattr(f, "filename")][:10]
    data = {"force": form.get("force") == "1"}
    if not text and not files:
        raise HTTPException(400, "Порожнє повідомлення")
    t = await zammad.api("GET", f"/tickets/{tid}", as_user=u["id"])
    if is_chat(t) and not is_closed_state(t.get("state_id")):
        cat = category(await slim(t), u["id"])
        if cat == "queue" or (cat == "others" and data.get("force")):
            await _take(tid, u["id"], bool(data.get("force")))
        elif cat == "others":
            who = (await zammad.user(owner_of(t)))["name"]
            raise HTTPException(409, f"Цей чат веде {who}")
    cust = await zammad.user(t.get("customer_id"))
    art = {"ticket_id": tid, "body": text, "type": "email", "to": cust["email"] or None,
           "internal": False, "content_type": "text/plain"}
    images = [f for f in files if (f.content_type or "").startswith("image/")]
    others = [f for f in files if f not in images]
    if images:
        # Картинки вбудовуємо в HTML (data:…) — Zammad сам перетворює їх на
        # inline-вкладення, і клієнт бачить просто картинку, без назви файлу
        parts = [f"<div>{html.escape(line) or '<br>'}</div>" for line in text.split("\n")] if text else []
        for f in images:
            content = await f.read()
            if len(content) > 10 * 1024 * 1024:
                raise HTTPException(413, "Картинка більша за 10 МБ")
            parts.append(f'<div><img src="data:{f.content_type};base64,{base64.b64encode(content).decode()}" '
                         f'style="max-width:100%"></div>')
        art["body"] = "".join(parts)
        art["content_type"] = "text/html"
    if others:
        form_id = secrets.token_hex(16)
        for f in others:
            await _upload(form_id, f, u["id"])
        art["form_id"] = form_id
        if not art["body"]:
            # Zammad не приймає порожнє тіло — підставляємо назви файлів
            art["body"] = "📎 " + ", ".join(f.filename or "file" for f in others)
    await zammad.api("POST", "/ticket_articles", as_user=u["id"], json=art)
    return {"ok": True}


@app.post("/api/tickets/{tid}/article")
async def dept_article(request: Request, tid: int):
    """Нотатка у тикет відділу або лист клієнту в ньому.
    Якщо передано from_chat — у чат падає внутрішня нотатка, що й куди написали."""
    u = me(request)
    data = await request.json()
    text = (data.get("text") or "").strip()
    mode = data.get("mode") or "note"
    if not text:
        raise HTTPException(400, "Порожнє повідомлення")
    t = await zammad.api("GET", f"/tickets/{tid}", as_user=u["id"])
    if mode == "mail":
        cust = await zammad.user(t.get("customer_id"))
        art = {"ticket_id": tid, "body": text, "type": "email", "to": cust["email"] or None,
               "internal": False, "content_type": "text/plain"}
    else:
        art = {"ticket_id": tid, "body": text, "type": "note", "internal": True, "content_type": "text/plain"}
    await zammad.api("POST", "/ticket_articles", as_user=u["id"], json=art)

    chat_id = data.get("from_chat")
    if chat_id and int(chat_id) != tid:
        groups = await zammad.groups()
        where = f"{_group_label(t, groups)} #{t.get('number')}"
        log = (f"Написали у {where}: «{text}»" if mode != "mail"
               else f"Надіслали лист клієнту в тикет {where}: «{text}»")
        with contextlib.suppress(ZammadError):
            await zammad.api("POST", "/ticket_articles", as_user=u["id"], json={
                "ticket_id": int(chat_id), "body": log, "type": "note", "internal": True, "content_type": "text/plain"})
    return {"ok": True}


@app.post("/api/dept-tickets")
async def create_dept_ticket(request: Request):
    """Нове звернення у Виписку / Рефанд / Інвол — так само, як агенти створюють
    його вручну: клієнт «Cco», стаття типу phone, назва «BOOKING суть»,
    заповнені booking і причина. У чат падає внутрішня нотатка-посилання."""
    u = me(request)
    data = await request.json()
    gid = int(data.get("group_id") or 0)
    if gid not in config.DEPT_GROUPS:
        raise HTTPException(400, "Оберіть відділ")
    text = (data.get("text") or "").strip()
    subject = " ".join((data.get("subject") or "").split())
    booking = (data.get("booking") or "").strip()
    if not text:
        raise HTTPException(400, "Опишіть запит для відділу")
    if not subject:
        raise HTTPException(400, "Вкажіть коротко суть (для назви тикета)")
    reason = data.get("reason") or ""
    ticket = {
        "title": f"{booking} {subject}".strip(),
        "group_id": gid,
        "customer_id": config.DEPT_CUSTOMER_ID,
        "priority_id": 3 if data.get("urgent") else 2,
        "article": {"type": "phone", "sender": "Agent", "internal": False,
                    "content_type": "text/plain", "body": text, "subject": subject},
    }
    if booking:
        ticket[config.BOOKING_FIELD] = booking
    if reason and reason != config.AUTO_REASON and reason in await zammad.reasons():
        ticket[config.REASON_FIELD] = reason
    t = await zammad.api("POST", "/tickets", json=ticket, as_user=u["id"])

    chat_id = data.get("from_chat")
    if chat_id:
        with contextlib.suppress(ZammadError):
            await zammad.api("POST", "/ticket_articles", as_user=u["id"], json={
                "ticket_id": int(chat_id), "type": "note", "internal": True, "content_type": "text/plain",
                "body": f"Створили звернення у {config.DEPT_GROUPS[gid]} #{t.get('number')}: «{text}»"})
    return {"id": t["id"], "number": t.get("number")}


@app.post("/api/tickets/{tid}/reason")
async def set_reason(request: Request, tid: int):
    u = me(request)
    data = await request.json()
    reason = data.get("reason") or ""
    if reason not in await zammad.reasons():
        raise HTTPException(400, "Оберіть причину зі списку")
    await zammad.api("PUT", f"/tickets/{tid}", json={config.REASON_FIELD: reason}, as_user=u["id"])
    return {"ok": True}


@app.post("/api/tickets/{tid}/close")
async def close(request: Request, tid: int):
    u = me(request)
    data = await request.json()
    reason = data.get("reason") or ""
    reasons = await zammad.reasons()
    if not reason or reason == config.AUTO_REASON or reason not in reasons:
        raise HTTPException(400, "Щоб закрити чат, оберіть причину звернення")
    t = await zammad.api("GET", f"/tickets/{tid}", as_user=u["id"])
    changes = {"state_id": config.STATE_CLOSED_ID, config.REASON_FIELD: reason}
    booking = (data.get("booking") or "").strip()
    if not (t.get(config.BOOKING_FIELD) or "").strip():
        if not booking:
            raise HTTPException(400, "Щоб закрити чат, вкажіть Booking Number")
        changes[config.BOOKING_FIELD] = booking
    await zammad.api("PUT", f"/tickets/{tid}", json=changes, as_user=u["id"])
    # Закрили — знімаємо тег, щоб при переоткритті чат знову був у загальній черзі
    with contextlib.suppress(ZammadError):
        await zammad.remove_tag(tid, config.TAKEN_TAG, as_user=u["id"])
    store.active = [x for x in store.active if x["id"] != tid]
    store.closed_at = 0
    return {"ok": True}


# ── Статистика агента ─────────────────────────────────────────
KYIV = ZoneInfo("Europe/Kyiv")
_stats_cache: dict[int, tuple[float, dict]] = {}


def _periods() -> dict[str, tuple[str, str]]:
    """Сьогодні / вчора / цей тиждень / цей місяць — за київським часом, у UTC для пошуку."""
    now = datetime.now(KYIV)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    utc = lambda d: d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "today": (utc(day), utc(now)),
        "yesterday": (utc(day - timedelta(days=1)), utc(day)),
        "week": (utc(day - timedelta(days=day.weekday())), utc(now)),
        "month": (utc(day.replace(day=1)), utc(now)),
    }


async def _count(query: str) -> int:
    r = await zammad.api("GET", "/tickets/search", params={"query": query, "only_total_count": "true"})
    return int((r or {}).get("total_count") or 0)


@app.get("/api/stats")
async def stats(request: Request):
    """Скільки чатів агент закрив (чат закритий, власник — агент). Пріоритет не
    фільтруємо: після закриття Zammad повертає чатам «2 normal»."""
    u = me(request)
    hit = _stats_cache.get(u["id"])
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    base = (f'title:"{config.CHAT_TITLE}"' + "".join(f' AND NOT title:"{x}"' for x in config.EXCLUDED_TITLES)
            + " AND state.name:closed")
    out = {}
    for key, (a, b) in _periods().items():
        rng = f"last_close_at:[{a} TO {b}]"
        mine, team = await asyncio.gather(
            _count(f"{base} AND owner_id:{u['id']} AND {rng}"),
            _count(f"{base} AND NOT owner_id:{config.NO_OWNER_ID} AND {rng}"),
        )
        out[key] = {"mine": mine, "team": team}
    res = {"periods": out, "now_taken": sum(1 for t in store.active if category(t, u["id"]) == "mine")}
    _stats_cache[u["id"]] = (time.time(), res)
    return res


# ── Переклад ──────────────────────────────────────────────────
@app.post("/api/translate")
async def translate_many(request: Request):
    me(request)
    data = await request.json()
    texts = [x for x in (data.get("texts") or []) if isinstance(x, str)][:50]

    async def one(x):
        try:
            return x, await translate.to_uk(x)
        except Exception:
            return x, None

    return {"results": dict(await asyncio.gather(*(one(x) for x in texts)))}


@app.post("/api/translate-reply")
async def translate_reply(request: Request):
    me(request)
    data = await request.json()
    text, sample = (data.get("text") or "").strip(), (data.get("sample") or "").strip()
    if not text or not sample:
        raise HTTPException(400, "Немає тексту або зразка мови клієнта")
    try:
        return {"text": await translate.to_lang_of(text, sample)}
    except Exception as e:
        raise HTTPException(502, f"Не вдалося перекласти: {e}")
