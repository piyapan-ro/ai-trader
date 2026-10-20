"""Small JSON-file settings store (data/*.json) with defaults and thread safety."""
import json
import os
import threading
from copy import deepcopy

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
os.makedirs(DATA_DIR, exist_ok=True)

DEFAULTS = {
    "settings": {
        "symbol": "XAUUSD",            # change to your broker's name, e.g. XAUUSDm / GOLD
        "timeframe": "M5",
        "dashboard_magic": 777000,      # magic used for orders sent from this dashboard
        "deviation_points": 50,
        "mt5": {                        # leave empty to attach to the MT5 terminal that is already open
            "path": "",
            "login": 0,
            "password": "",
            "server": ""
        },
        "goals": {"daily": 50.0, "weekly": 250.0, "monthly": 1000.0},
        "asian_session": {"start_hour": 1, "end_hour": 8, "trade_until_hour": 16},
        "ai": {"provider": "anthropic", "anthropic_api_key": "", "anthropic_workspace_id": "", "model": "claude-sonnet-5-5",
               "openai_api_key": "", "openai_model": "gpt-6.1-sol", "news_note": ""}
    },
    "risk": {
        "lot_mode": "fixed",            # "fixed" = use default_lot | "risk" = size from risk_per_trade_pct
        "default_lot": 0.01,
        "max_lot": 1.0,
        "risk_per_trade_pct": 1.0,
        "max_daily_loss_pct": 3.0,
        "max_daily_loss_money": 0.0,    # 0 = use % only
        "max_orders_per_day": 20,
        "max_open_positions": 3,
        "max_same_side": 1,             # MANUAL Dashboard orders open in the SAME direction at once (0 = no limit)
        "same_side_cooldown_min": 15,   # no new manual order in the same direction within N minutes of the last one
        # lanes: every strategy and the AI trade with their OWN quota, so one cannot block another
        "lane_max_positions": 1,        # open + pending per lane
        "lane_cooldown_min": 15,        # minutes between two entries of the same lane
        "lane_max_orders_day": 6,       # entries per lane per server day
        "lane_max_daily_loss_pct": 6.0, # a lane stops for the day after losing this % of the balance
        "max_total_open_risk_pct": 12.0,  # sum of SL risk of all open/pending positions (all lanes + manual)
        "max_spread": 0.80,             # in price units ($ for gold)
        "require_sl": True,
        "auto_kill_on_daily_loss": True,
        "auto_release_new_day": True,   # auto-kill from the daily loss limit is lifted at server midnight
        "kill_switch": False,
        "kill_switch_reason": "",
        "kill_switch_time": 0,
        "kill_switch_auto": False,
        "kill_switch_day": 0
    },
    "ea_map": {
        "0": "Manual",
        "260109": "GoldScalper M1",
        "260110": "AIScalper M1",
        "777000": "Dashboard"
    },
    "scanner": {
        "enabled": True,
        "interval_sec": 30,
        "auto_trade": False,            # OFF by default - turn on only after testing on demo
        "strategies": {
            "SMC": True, "SND": True, "EMA": True, "BB": True, "ASIA": True, "AIPB": True
        },
        "auto_trade_strategies": {
            "SMC": False, "SND": False, "EMA": False, "BB": False, "ASIA": False, "AIPB": False
        },
        "ai_liquidity_mode": "block",   # AI plan against a fresh liquidity sweep: block | warn | off
        "ai_limit_expiry_min": 45,      # default validity of AI LIMIT/STOP orders (the AI may set 15..ai_limit_max_min)
        "ai_limit_max_min": 120,
        "ai_review_mode": "shadow",     # AI review of positions going the wrong way: off | shadow | live
        "ai_review_trigger_r": 0.5,     # review when a position is this many R against us
        "ai_review_min_conf": 60,       # live: act only at this confidence or higher
        "ai_review_max": 3,             # reviews per position
        "lane_gate_mode": "block",      # strategy lanes: market-context gate block | warn | off
    },
    "strategy_params": {},              # per-strategy overrides applied from the Optimizer
    "optimizer": {"history": []},       # applied changes (for rollback)
    "notes": {},
    "runtime": {"traded": [], "partial_done": []},
    "symbols": {},                       # extra symbols (e.g. BTCUSD) - see symbols.py  # survives restarts: signals already traded, partial TPs done
}

_lock = threading.RLock()


def _path(name):
    return os.path.join(DATA_DIR, f"{name}.json")


def _merge(default, current):
    if not isinstance(default, dict) or not isinstance(current, dict):
        return current
    out = deepcopy(default)
    for k, v in current.items():
        out[k] = _merge(default.get(k), v) if k in default else v
    return out


_last_good = {}  # name -> last successfully read/written data (used if the file becomes unreadable)


def _read(p):
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def load(name):
    with _lock:
        default = DEFAULTS.get(name, {})
        p = _path(name)
        if not os.path.exists(p):
            return deepcopy(default)
        try:
            data = _read(p)
            _last_good[name] = deepcopy(data)
            return _merge(default, data)
        except Exception as e:
            print(f"[STORE] cannot read {p}: {e!r}")
        # unreadable file: never silently fall back to defaults (that would e.g. release an active Kill Switch)
        if name in _last_good:
            return _merge(default, deepcopy(_last_good[name]))
        try:
            data = _read(p + ".bak")
            print(f"[STORE] using backup {p}.bak")
            _last_good[name] = deepcopy(data)
            return _merge(default, data)
        except Exception:
            pass
        out = deepcopy(default)
        if name == "risk":  # fail safe: refuse new orders until the user saves the risk settings again
            out["load_error"] = "อ่านไฟล์ risk.json ไม่ได้ – เปิดหน้า Risk & Settings ตรวจกฎความเสี่ยงแล้วกดบันทึก"
        return out


def save(name, data):
    with _lock:
        if name == "risk" and isinstance(data, dict):
            data.pop("load_error", None)  # transient flag, never written to disk
        p = _path(name)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        if os.path.exists(p):
            try:
                _read(p)  # keep the previous version only if it is valid JSON
                os.replace(p, p + ".bak")
            except Exception:
                pass
        os.replace(tmp, p)
        _last_good[name] = deepcopy(data)
        return data


def modify(name, fn):
    """Atomic load -> fn(data) -> save (fn edits data in place). Prevents lost updates between threads."""
    with _lock:
        data = load(name)
        fn(data)
        return save(name, data)


def update(name, patch):
    with _lock:
        data = load(name)
        data = _merge(data, patch)
        return save(name, data)
