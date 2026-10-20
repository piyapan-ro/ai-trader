"""Is the gold market open? Used to skip AI calls (and their cost) while nothing trades.

Two independent checks:
* the clock: spot gold follows the CME schedule in New York time - closed from Friday 17:00 to
  Sunday 18:00, plus the daily break 17:00-18:00 (US DST computed without a tz database)
* the feed: the broker says the symbol is disabled / close-only, or the last tick has not moved
  for STALE_SEC (holidays, broker-specific breaks)
"""
import datetime as dt
import time

from strategies import _nth_sunday

STALE_SEC = 180
TRADE_MODE_DISABLED, TRADE_MODE_CLOSEONLY = 0, 3


def ny_offset_hours(ts):
    """UTC offset of New York at unix time ts (-4 in summer, -5 in winter)."""
    y = dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).year
    utc = lambda m, d, h: dt.datetime(y, m, d, h, tzinfo=dt.timezone.utc).timestamp()
    return -4 if utc(3, _nth_sunday(y, 3, 2), 7) <= ts < utc(11, _nth_sunday(y, 11, 1), 6) else -5


def clock_closed_reason(ts=None):
    """Reason gold is closed by the weekly schedule at unix time ts, or ''."""
    ts = time.time() if ts is None else ts
    ny = dt.datetime.fromtimestamp(ts + ny_offset_hours(ts) * 3600, tz=dt.timezone.utc)
    wd, h = ny.weekday(), ny.hour  # Mon=0 ... Sun=6
    if wd == 5 or (wd == 4 and h >= 17) or (wd == 6 and h < 18):
        return "ตลาดทองปิดช่วงสุดสัปดาห์ (ศุกร์ 17:00 – อาทิตย์ 18:00 เวลานิวยอร์ก)"
    if h == 17:
        return "ตลาดทองพักประจำวัน (17:00 – 18:00 เวลานิวยอร์ก)"
    return ""


class MarketWatch:
    """Remembers when the tick last changed, so a frozen feed is noticed."""

    def __init__(self, broker, get_symbol):
        self.broker, self.get_symbol = broker, get_symbol
        self.seen = {}  # symbol -> (tick time, wall time first seen)

    def closed_reason(self):
        if self.broker.mode != "live":
            return ""  # the simulator's market never closes
        symbol = self.get_symbol()
        reason = clock_closed_reason()
        if reason:
            return reason
        info = self.broker.symbol_info(symbol) or {}
        if info.get("trade_mode") in (TRADE_MODE_DISABLED, TRADE_MODE_CLOSEONLY):
            return f"{symbol} ปิดให้เปิดออเดอร์ใหม่ (trade_mode={info.get('trade_mode')})"
        tk = self.broker.tick(symbol)
        if not tk:
            return f"ไม่มีราคา {symbol} จาก MT5"
        now = time.time()
        last, since = self.seen.get(symbol, (None, now))
        if tk["time"] != last:
            self.seen[symbol] = (tk["time"], now)
            return ""
        if now - since >= STALE_SEC:
            return f"ราคา {symbol} ไม่ขยับมา {int((now - since) // 60)} นาที – ตลาดน่าจะปิด"
        return ""
