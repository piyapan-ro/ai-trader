"""
AI position review: when an open Dashboard position moves against us, the AI looks at it again and
answers HOLD / CLOSE / TIGHTEN_SL / MOVE_TP.

Safety rules (enforced in code, not only in the prompt):
- the stop is never widened or removed, no averaging down, no adding, no reversing
- TIGHTEN_SL must stay beyond the current price by a buffer; MOVE_TP may only bring the target closer
Mode (Scanner setting ai_review_mode): off / shadow (decide + score only) / live (execute).

Every decision is scored against real M1 prices twice:
  baseline = what happened if the position had been left alone (old SL/TP)
  decision = what the AI's decision would give (CLOSE = R at the decision, TIGHTEN/MOVE = new levels)
  gain_r   = decision - baseline   (in R of the risk at review time)
so it is measurable whether the reviews help before they are allowed to act.
"""
import math
import threading
import time
import uuid

import store

MAX_RECORDS = 1000
TIMEOUT = 24 * 3600
ACTIONS = ("HOLD", "CLOSE", "TIGHTEN_SL", "MOVE_TP")
_lock = threading.Lock()


def _load():
    return store.load("ai_review").get("reviews", [])


def _save(rows):
    store.save("ai_review", {"reviews": rows[-MAX_RECORDS:]})


def check(decision, pos, cur, atr):
    """Validate an AI decision for position pos at current exit price cur. Returns (action, new_sl, new_tp, problem)."""
    act = str(decision.get("action", "HOLD")).upper().strip()
    if act not in ACTIONS:
        return "HOLD", None, None, f"action '{act}' ไม่รู้จัก → HOLD"
    buy = pos["side"] == "BUY"
    sl, tp = pos["sl"] or 0.0, pos["tp"] or 0.0
    buf_sl, buf_tp = 0.3 * (atr or 0), 0.2 * (atr or 0)
    try:
        new_sl = float(decision.get("new_sl")) if decision.get("new_sl") not in (None, "", 0) else None
        new_tp = float(decision.get("new_tp")) if decision.get("new_tp") not in (None, "", 0) else None
    except (TypeError, ValueError):
        return "HOLD", None, None, "ตัวเลข SL/TP อ่านไม่ได้ → HOLD"
    if any(x is not None and not math.isfinite(x) for x in (new_sl, new_tp)):  # json.loads accepts NaN / Infinity
        return "HOLD", None, None, "ตัวเลข SL/TP ไม่ใช่ตัวเลขจริง → HOLD"
    if act in ("TIGHTEN_SL", "MOVE_TP") and not (atr and math.isfinite(atr) and atr > 0):
        return "HOLD", None, None, "ไม่มีค่า ATR – ตรวจระยะห่าง SL/TP ไม่ได้ → HOLD"
    if act == "TIGHTEN_SL":
        if new_sl is None:
            return "HOLD", None, None, "TIGHTEN_SL ไม่มี new_sl → HOLD"
        if (buy and new_sl <= sl) or (not buy and new_sl >= sl):
            return "HOLD", None, None, f"new_sl {new_sl} ไม่ได้แคบลงจาก {sl} (ห้ามขยาย SL) → HOLD"
        if (buy and new_sl > cur - buf_sl) or (not buy and new_sl < cur + buf_sl):
            return "HOLD", None, None, f"new_sl {new_sl} ใกล้ราคาปัจจุบัน {cur} เกินไป (ต้องห่าง ≥ 0.3×ATR) → HOLD"
        return act, round(new_sl, 2), None, ""
    if act == "MOVE_TP":
        if new_tp is None:
            return "HOLD", None, None, "MOVE_TP ไม่มี new_tp → HOLD"
        if (buy and new_tp <= cur + buf_tp) or (not buy and new_tp >= cur - buf_tp):
            return "HOLD", None, None, f"new_tp {new_tp} อยู่ผิดฝั่ง/ใกล้ราคาเกินไป → HOLD"
        if tp and ((buy and new_tp >= tp) or (not buy and new_tp <= tp)):
            return "HOLD", None, None, f"new_tp {new_tp} ไกลกว่าเดิม {tp} (เลื่อนได้เฉพาะเข้าใกล้) → HOLD"
        return act, None, round(new_tp, 2), ""
    return act, None, None, ""


def record(pos, review, meta):
    rec = {
        "id": uuid.uuid4().hex[:12], "time": int(meta["server_time"]), "ticket": pos["ticket"],
        "lane": (pos.get("comment") or "")[4:] or "?", "symbol": pos["symbol"], "side": pos["side"],
        "entry": pos["price_open"], "sl": pos["sl"], "tp": pos["tp"] or 0.0, "price": meta["price"],
        "r_at": meta["r_at"], "spread": meta.get("spread") or 0.0, "atr": meta.get("atr"),
        "ai_action": review.get("ai_action"), "action": review["action"], "new_sl": review.get("new_sl"),
        "new_tp": review.get("new_tp"), "confidence": review.get("confidence", 0), "reason": review.get("reason", "")[:300],
        "problem": review.get("problem", ""), "mode": meta["mode"], "executed": bool(meta.get("executed")),
        "exec_msg": meta.get("exec_msg", ""), "model": meta.get("model"),
        "status": "open", "baseline_r": None, "decision_r": None, "gain_r": None,
    }
    if not rec["ai_action"]:
        rec["status"] = "error"  # the AI answer could not be read - not a decision, not scored
    with _lock:
        rows = _load()
        rows.append(rec)
        _save(rows)
    return rec


def _walk(bars, buy, spr, stop, target):
    """First exit on M1 bid bars. Returns (exit_price_on_bid_chart, time) or (None, None)."""
    for r in bars.itertuples():
        if buy:
            if stop and r.low <= stop:
                return stop, int(r.time)
            if target and r.high >= target:
                return target, int(r.time)
        else:
            if stop and r.high + spr >= stop:
                return stop - spr, int(r.time)
            if target and r.low + spr <= target:
                return target - spr, int(r.time)
    return None, None


def _score(rec, bars, now):
    if not rec.get("ai_action"):
        rec["status"] = "error"
        return True
    buy = rec["side"] == "BUY"
    spr = rec["spread"] or 0.0
    risk = abs(rec["entry"] - rec["sl"]) or 1e-9
    b = bars[bars["time"] >= (rec["time"] // 60 + 1) * 60]
    to_r = (lambda bid: (bid - rec["entry"]) / risk) if buy else (lambda bid: (rec["entry"] - bid - spr) / risk)
    timeout = now - rec["time"] > TIMEOUT and len(b)
    last = float(b["close"].iat[-1]) if len(b) else None

    def outcome(stop, target):
        px, _ = _walk(b, buy, spr, stop, target)
        if px is not None:
            return round(to_r(px), 2)
        return round(to_r(last), 2) if timeout else None

    base = outcome(rec["sl"], rec["tp"])
    act = rec["ai_action"] if rec.get("ai_action") in ACTIONS else rec["action"]
    if act == "CLOSE":
        dec = rec["r_at"]
    elif act == "TIGHTEN_SL" and rec.get("new_sl"):
        dec = outcome(rec["new_sl"], rec["tp"])
    elif act == "MOVE_TP" and rec.get("new_tp"):
        dec = outcome(rec["sl"], rec["new_tp"])
    else:
        dec = base
    if base is None or dec is None:
        return False
    rec.update(status="done", baseline_r=base, decision_r=dec, gain_r=round(dec - base, 2))
    return True


def evaluate(broker, now):
    with _lock:
        rows = _load()
        todo = [r for r in rows if r["status"] == "open"]
        if not todo:
            return 0
        changed = 0
        for sym_ in {r["symbol"] for r in todo}:
            mine = [r for r in todo if r["symbol"] == sym_]
            bars = broker.rates_range(sym_, "M1", min(r["time"] for r in mine) - 60, now + 60)
            if bars is None or not len(bars):
                continue
            bars = bars[bars["time"] + 60 <= now]
            changed += sum(1 for r in mine if _score(r, bars, now))
        if changed:
            _save(rows)
        return changed


def _agg(rows):
    d = [r for r in rows if r["status"] == "done"]
    n = len(d)
    if not n:
        return {"n": 0, "avg_gain_r": None, "total_gain_r": 0.0, "avg_decision_r": None, "avg_baseline_r": None, "helped": 0, "hurt": 0}
    return {"n": n, "avg_gain_r": round(sum(r["gain_r"] for r in d) / n, 3), "total_gain_r": round(sum(r["gain_r"] for r in d), 2),
            "avg_decision_r": round(sum(r["decision_r"] for r in d) / n, 3),
            "avg_baseline_r": round(sum(r["baseline_r"] for r in d) / n, 3),
            "helped": sum(1 for r in d if r["gain_r"] > 0), "hurt": sum(1 for r in d if r["gain_r"] < 0)}


def stats(days=30, now=None):
    now = now or time.time()
    rows = [r for r in _load() if r["time"] >= now - days * 86400]
    by = {a: _agg([r for r in rows if (r.get("ai_action") or r["action"]) == a]) for a in ACTIONS}
    allv = _agg(rows)
    verdict = ("ยังไม่มีข้อมูลพอ (ต้องมีผลอย่างน้อย 20 ครั้ง)" if allv["n"] < 20 else
               "AI แก้ออเดอร์แล้วดีขึ้นโดยเฉลี่ย" if allv["avg_gain_r"] > 0 else "AI แก้ออเดอร์แล้วแย่ลงโดยเฉลี่ย – ไม่ควรเปิด Live")
    return {"reviews": len(rows), "open": sum(1 for r in rows if r["status"] == "open"),
            "errors": sum(1 for r in rows if r["status"] == "error"), "all": allv,
            "by_action": by, "executed": _agg([r for r in rows if r["executed"]]), "verdict": verdict,
            "note": "gain = ผลของการตัดสินใจของ AI − ผลถ้าปล่อยไว้ (หน่วย R ของความเสี่ยงตอนรีวิว) · บวก = AI ช่วย"}


def recent(limit=30):
    return list(reversed(_load()))[:limit]
