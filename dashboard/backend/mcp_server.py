"""
MCP server: lets Claude (Claude Desktop / Claude Code) work with the AI Trader Dashboard.

It talks to the dashboard backend over HTTP (http://127.0.0.1:8000 by default),
so every order still goes through the same Risk Manager and Kill Switch.
Start the dashboard first (start.bat), then add this server to Claude Desktop.
"""
import os

import requests
from mcp.server.fastmcp import FastMCP

BASE = os.environ.get("AITRADER_URL", "http://127.0.0.1:8000").rstrip("/") + "/api/"
TOKEN_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "api_token.txt")
mcp = FastMCP("ai-trader")


def _headers():
    """The dashboard writes its API token to data/api_token.txt when it starts."""
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return {"X-AIT-Token": f.read().strip()}
    except OSError:
        return {}


def _get(path, **params):
    r = requests.get(BASE + path, params={k: v for k, v in params.items() if v is not None}, timeout=30,
                     headers=_headers())
    r.raise_for_status()
    return r.json()


def _post(path, body=None):
    r = requests.post(BASE + path, json=body or {}, timeout=30, headers=_headers())
    try:
        data = r.json()
    except Exception:
        data = {"error": r.text}
    if r.status_code >= 400:
        return {"ok": False, "status": r.status_code, **(data if isinstance(data, dict) else {"error": data})}
    return data


@mcp.tool()
def get_account() -> dict:
    """Account balance/equity/credit, today's P/L, daily-loss usage and goal progress."""
    return _get("account")


@mcp.tool()
def get_market_context(timeframe: str = "M5") -> dict:
    """Compact market snapshot for XAUUSD: price, EMA20/50/200, RSI, ATR, 50-bar range on the
    given timeframe and H1, latest strategy signals, and today's risk status."""
    return _get("ai/context", tf=timeframe)


@mcp.tool()
def get_candles(timeframe: str = "M5", count: int = 120, symbol: str = None) -> list:
    """Recent OHLC candles with EMA/Bollinger values (time = broker server time, unix seconds).
    symbol: empty = the main gold symbol, or an extra symbol such as "BTCUSD"."""
    d = _get("rates", tf=timeframe, count=max(count, 250), signals="false", symbol=symbol)
    return d["candles"][-count:]


@mcp.tool()
def get_signals() -> dict:
    """Latest signals from the 6-strategy scanner (SMC, Supply/Demand, EMA, BB, Asian Breakout, AI Playbook)."""
    d = _get("signals")
    d["history"] = d["history"][:30]
    return d


@mcp.tool()
def backtest_strategies(timeframe: str = "M5", bars: int = 6000, symbol: str = None) -> dict:
    """Backtest every strategy lane on recent history (spread on entry, gaps, one position per lane,
    Breakeven/Trailing simulated when the Trade Manager manages Dashboard orders - gold only).
    symbol: empty = gold, or e.g. "BTCUSD". Max 20000 bars.
    Returns win rate, PF, expectancy, t-stat, total R and max DD per strategy."""
    d = _get("backtest", tf=timeframe, count=bars, symbol=symbol)
    for v in d["results"].values():
        v.pop("trades", None)
    return d


@mcp.tool()
def get_positions() -> dict:
    """Open positions and pending orders."""
    return {"positions": _get("positions"), "orders": _get("orders")}


@mcp.tool()
def get_journal(days: int = 30, source: str = None, strategy: str = None, side: str = None,
                result: str = None, limit: int = 50) -> dict:
    """Trade journal from MT5 history. source = EA name or 'Manual'; result = win/loss/open."""
    d = _get("journal", days=days, source=source, strategy=strategy, side=side, result=result)
    d["trades"] = d["trades"][:limit]
    return d


@mcp.tool()
def get_performance(days: int = 90) -> dict:
    """Performance analytics: summary, drawdown, consistency, by strategy/EA, by hour and weekday."""
    d = _get("analytics", days=days)
    d.pop("curve", None)
    d["daily"] = d["daily"][-30:]
    return d


@mcp.tool()
def get_risk_status() -> dict:
    """Risk rules, today's usage (loss limit, orders, open positions), kill-switch state and recent risk events."""
    return _get("risk")


@mcp.tool()
def calculate_lot(side: str, stop_loss: float, take_profit: float = None, entry: float = None,
                  risk_pct: float = None) -> dict:
    """Lot size for a given SL using the risk-% rule (entry defaults to current price). Also returns R:R."""
    return _post("calc", {"side": side, "sl": stop_loss, "tp": take_profit, "entry": entry, "risk_pct": risk_pct})


@mcp.tool()
def place_order(side: str, volume: float, stop_loss: float, take_profit: float = None, kind: str = "MARKET",
                price: float = None, strategy: str = "AI") -> dict:
    """Send an order to MT5 (kind = MARKET / LIMIT / STOP). The dashboard Risk Manager validates it first
    (max lot, risk per trade, daily loss, orders/day, spread, kill switch). Call it when the user asks you
    to trade - either this specific trade or a standing instruction such as "analyse and trade for me on my
    demo account". Always state the side, lot, SL, TP and reason when you place an order."""
    return _post("order", {"side": side, "volume": volume, "sl": stop_loss, "tp": take_profit, "kind": kind,
                           "price": price, "strategy": strategy})


@mcp.tool()
def get_ai_reviews(days: int = 30) -> dict:
    """AI reviews of open positions that went the wrong way (HOLD / CLOSE / TIGHTEN_SL / MOVE_TP), each scored
    against 'leave it alone' on real prices: gain_r > 0 means the AI's decision was better."""
    return _get("ai/reviews", days=days, limit=15)


@mcp.tool()
def get_lanes(days: int = 30) -> dict:
    """Trading lanes (each strategy + the AI) with their own quota: mode off/shadow/live, today's use,
    and results on real prices for live trades and shadow (paper) signals. A lane goes Live when its
    shadow results are positive over enough plans (>= 30)."""
    return _get("lanes", days=days)


@mcp.tool()
def get_ai_track_record(days: int = 30) -> dict:
    """How accurate the AI's trade plans really were: every plan (also ones not traded) is scored
    against real M1 prices (TP or SL first). Win rate / avg R by confidence level, liquidity-sweep
    alignment, session and source, plus a suggested minimum confidence once there is enough data."""
    d = _get("ai/journal", days=days, limit=15)
    return d


@mcp.tool()
def run_optimizer(timeframe: str = "M5", bars: int = 12000, combos_per_strategy: int = 40) -> dict:
    """Start the walk-forward parameter optimizer for all 6 strategies (runs in the background,
    ~10-60 s). Poll get_optimizer_results until running is false."""
    return _post("optimize/run", {"tf": timeframe, "bars": bars, "max_combos": combos_per_strategy})


@mcp.tool()
def get_optimizer_results() -> dict:
    """Latest optimizer results: per-strategy out-of-sample performance (current vs tuned params),
    recommendations with evidence, active parameters and change history. Applying a recommendation
    is done by the user in the dashboard (AI & Analytics > Adaptive Optimizer)."""
    d = _get("optimize")
    if d.get("result"):
        for v in d["result"]["strategies"].values():
            v.pop("windows", None)
    d["active_params"] = _get("strategy_params")
    return d


@mcp.tool()
def close_position(ticket: int) -> dict:
    """Close one open position by ticket."""
    return _post(f"position/{ticket}/close")


@mcp.tool()
def modify_position(ticket: int, stop_loss: float = None, take_profit: float = None) -> dict:
    """Change SL/TP of an open position. A value you leave out keeps its current level.
    The stop cannot be removed or widened beyond the per-trade risk limit."""
    return _post(f"position/{ticket}/modify", {"sl": stop_loss, "tp": take_profit})


@mcp.tool()
def activate_kill_switch(reason: str = "requested via Claude") -> dict:
    """EMERGENCY STOP: close all positions, delete pending orders and block new trades.
    (Releasing the kill switch can only be done by the user in the dashboard.)"""
    return _post("kill", {"reason": reason})


if __name__ == "__main__":
    mcp.run()
