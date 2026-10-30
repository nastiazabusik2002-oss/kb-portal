"""Клієнт Zammad API.

Сервер ходить у Zammad одним службовим токеном, а дії агента виконує
від його імені через заголовок X-On-Behalf-Of — тоді в Zammad автором
повідомлення/зміни записується сам агент, і права груп перевіряються
саме для нього.
"""
import asyncio
import html
import re
import time

import httpx

from . import config

_client: httpx.AsyncClient | None = None
_client_loop = None


def client() -> httpx.AsyncClient:
    # Клієнт прив'язаний до event loop — якщо loop інший (перезапуск), створюємо новий
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client_loop is not loop:
        _client_loop = loop
        _client = httpx.AsyncClient(
            base_url=f"{config.ZAMMAD_URL}/api/v1",
            headers={"Authorization": f"Token token={config.ZAMMAD_TOKEN}"},
            timeout=httpx.Timeout(30.0, connect=10.0),
            limits=httpx.Limits(max_connections=20),
        )
    return _client


class ZammadError(Exception):
    def __init__(self, status: int, text: str):
        super().__init__(f"Zammad {status}: {text[:300]}")
        self.status = status


async def api(method: str, path: str, *, as_user: int | None = None, **kw):
    headers = kw.pop("headers", {})
    if as_user:
        headers["X-On-Behalf-Of"] = str(as_user)
    r = await client().request(method, path, headers=headers, **kw)
    if r.status_code >= 400:
        raise ZammadError(r.status_code, r.text)
    if not r.content:
        return None
    ct = r.headers.get("content-type", "")
    return r.json() if "json" in ct else r.content


async def raw(path: str) -> httpx.Response:
    """Сирий GET (вкладення) — віддаємо як є."""
    return await client().get(path)


# ── Перевірка логіна агента ────────────────────────────────────
async def verify_login(login: str, password: str) -> dict | None:
    """Пароль перевіряє сам Zammad (Basic auth), ми його ніде не зберігаємо."""
    async with httpx.AsyncClient(timeout=20.0) as c:
        r = await c.get(f"{config.ZAMMAD_URL}/api/v1/users/me?expand=true", auth=(login, password))
    if r.status_code != 200:
        return None
    return r.json()


# ── Кеші довідників ───────────────────────────────────────────
_users: dict[int, dict] = {}
_user_locks: dict[int, asyncio.Lock] = {}
_roles: dict | None = None
_groups: dict | None = None
_reasons: list | None = None
_reasons_at = 0.0


async def user(uid: int) -> dict:
    if not uid:
        return {"id": 0, "name": "", "email": ""}
    if uid in _users:
        return _users[uid]
    lock = _user_locks.setdefault(uid, asyncio.Lock())
    async with lock:
        if uid in _users:
            return _users[uid]
        try:
            u = await api("GET", f"/users/{uid}")
            name = " ".join(x for x in [u.get("firstname"), u.get("lastname")] if x) or u.get("login") or u.get("email") or f"#{uid}"
            info = {"id": uid, "name": name, "email": u.get("email") or ""}
        except ZammadError:
            info = {"id": uid, "name": f"#{uid}", "email": ""}
        _users[uid] = info
        return info


async def roles() -> dict:
    """id ролі → список прав"""
    global _roles
    if _roles is None:
        items = await api("GET", "/roles?per_page=200&expand=true")
        _roles = {r["id"]: r.get("permissions") or [] for r in items}
    return _roles


async def is_agent(me: dict) -> bool:
    rs = await roles()
    for rid in me.get("role_ids") or []:
        perms = rs.get(rid, [])
        if any(p == "ticket.agent" or p == "admin" or p.startswith("admin.") for p in perms):
            return True
    return False


async def groups() -> dict:
    global _groups
    if _groups is None:
        items = await api("GET", "/groups?per_page=500")
        _groups = {g["id"]: g.get("name") or f"#{g['id']}" for g in items}
    return _groups


async def reasons() -> list[str]:
    """Варіанти «Причини звернення» (tree_select → плаский список значень)."""
    global _reasons, _reasons_at
    if _reasons is not None and time.time() - _reasons_at < 600:
        return _reasons
    attrs = await api("GET", "/object_manager_attributes")
    out: list[str] = []
    for a in attrs:
        if a.get("object") == "Ticket" and a.get("name") == config.REASON_FIELD:
            opts = (a.get("data_option") or {}).get("options")

            def walk(lst):
                for o in lst or []:
                    if o.get("value"):
                        out.append(o["value"])
                    walk(o.get("children"))

            if isinstance(opts, list):
                walk(opts)
            elif isinstance(opts, dict):
                out.extend(opts.keys())
    _reasons = list(dict.fromkeys(out))
    _reasons_at = time.time()
    return _reasons


# ── Пошук і теги ──────────────────────────────────────────────
async def search(query: str, *, per_page=100, max_pages=5, expand=True, as_user: int | None = None) -> list[dict]:
    out = []
    for page in range(1, max_pages + 1):
        r = await api("GET", "/tickets/search", as_user=as_user, params={
            "query": query, "per_page": per_page, "page": page,
            "sort_by": "updated_at", "order_by": "desc", "expand": "true" if expand else "false",
        })
        items = r if isinstance(r, list) else (r or {}).get("tickets", [])
        out.extend(items)
        if len(items) < per_page:
            break
    return out


async def tags(ticket_id: int) -> list[str]:
    r = await api("GET", "/tags", params={"object": "Ticket", "o_id": ticket_id})
    return (r or {}).get("tags", [])


async def add_tag(ticket_id: int, item: str, as_user: int | None = None):
    await api("POST", "/tags/add", json={"object": "Ticket", "o_id": ticket_id, "item": item}, as_user=as_user)


async def remove_tag(ticket_id: int, item: str, as_user: int | None = None):
    await api("DELETE", "/tags/remove", json={"object": "Ticket", "o_id": ticket_id, "item": item}, as_user=as_user)


async def tag_added_at(ticket_id: int) -> str | None:
    """Коли востаннє ставили тег chat-taken (з історії тикета)."""
    h = await api("GET", f"/ticket_history/{ticket_id}")
    at = None
    for x in (h or {}).get("history", []):
        if x.get("type") == "added" and x.get("attribute") == "tag" and x.get("value_to") == config.TAKEN_TAG:
            at = x.get("created_at")
    return at


# ── Текст статті ──────────────────────────────────────────────
_TAG_RE = re.compile(r"<[^>]+>")
_BR_RE = re.compile(r"<\s*(br|/p|/div|/li|/tr|/h\d)\s*/?>", re.I)
_QUOTE_RE = re.compile(r"<blockquote.*?</blockquote>", re.I | re.S)


def article_text(a: dict) -> str:
    body = a.get("body") or ""
    if (a.get("content_type") or "").startswith("text/html"):
        body = _QUOTE_RE.sub("", body)
        body = _BR_RE.sub("\n", body)
        body = _TAG_RE.sub("", body)
        body = html.unescape(body)
    body = re.sub(r"[ \t ]+", " ", body)
    body = re.sub(r"\n\s*\n\s*\n+", "\n\n", body)
    return body.strip()
