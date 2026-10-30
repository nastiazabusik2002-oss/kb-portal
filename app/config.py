"""Налаштування з оточення (.env локально, Secret у Rancher)."""
import os
from pathlib import Path


def _load_dotenv():
    # Простий .env-лоадер для локального запуску (у Rancher змінні приходять із Secret)
    p = Path(__file__).resolve().parent.parent / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

ZAMMAD_URL = os.environ.get("ZAMMAD_URL", "https://zammad.ttndev.com").rstrip("/")
ZAMMAD_TOKEN = os.environ.get("ZAMMAD_TOKEN", "")          # токен з правами admin.user + ticket.agent
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
SHEETS_API_KEY = os.environ.get("SHEETS_API_KEY", "")
SHEET_ID = os.environ.get("SHEET_ID", "1wPyqo0wb8p7sqe0w9AWmp05cHMa76eRR851EB7JrSPs")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"  # true — коли буде HTTPS
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))

# ── Чати сайту (ті самі умови, що в оверв'ю «Чати з кабінету») ──
CHAT_TITLE = "Chat –"
CHAT_PRIORITY_ID = 3
EXCLUDED_TITLES = ["Chat – my.tickets.ua"]
TAKEN_TAG = "chat-taken"
NO_OWNER_ID = 1
STATE_OPEN_IDS = [1, 2]
STATE_CLOSED_ID = 4
REASON_FIELD = "contact_reason_tree"
BOOKING_FIELD = "bookingid"
AUTO_REASON = "mytickets.chat"

# Відділи, де вже може бути звернення по бронюванню
DEPT_GROUPS = {226: "Виписка", 225: "Рефанд", 227: "Інвол", 293: "ССО"}  # 293 = CCO consultation
CHAT_GROUP_ID = 1
# Службовий клієнт «Cco», на якого команда заводить звернення у відділи
DEPT_CUSTOMER_ID = int(os.environ.get("DEPT_CUSTOMER_ID", "149165"))
