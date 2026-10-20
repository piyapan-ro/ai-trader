"""
Plan journal for every lane (the AI and each strategy, Live or Shadow).
Every AI / rule plan is recorded (also WAIT, low-confidence and rejected ones) and
scored afterwards against real M1 prices - "would it have hit TP or SL first?".
This measures how accurate the AI really is at each confidence level without risking money,
so the minimum confidence can be chosen from data instead of a guess.

Scoring rules (conservative):
- MARKET: entry = ask (BUY) / bid (SELL) at analysis time. Scanning starts at the next M1 bar.
- LIMIT/STOP: must fill within `expiry_min` minutes, otherwise "expired" (no result).
- BUY exits on bid (M1 bars are bid), SELL exits on ask = bid + spread at analysis time.
- If SL and TP are both inside one M1 bar, it counts as a loss.
- Unresolved after 24 h -> closed at the last price (R = mark-to-market).
"""
import threading
import time
import uuid

import store

MAX_RECORDS = 1500
TIMEOUT = 24 * 3600
BUCKETS = [(0, 50), (50, 60), (60, 70), (70, 80), (80, 101)]
_lock = threading.Lock()


def _load():
    return store.load("ai_journal").get("plans", [])


def _save(plans):
    store.save("ai_journal", {"plans": plans[-MAX_RECORDS:]})


def record(plan, meta):
    """Store a plan. meta: server_time, origin (auto/manual), session, regime, spread, model."""
    rec = {
        "id": uuid.uuid4().hex[:12], "time": int(meta.get("server_time") or time.time()),
        "origin": meta.get("origin", "manual"), "source": plan.get("source"), "model": meta.get("model"),
        "lane": meta.get("lane", "AI"), "symbol": meta.get("symbol"),
        "action": plan.get("action", "WAIT"), "order_type": plan.get("order_type", "MARKET"),
        "entry": plan.get("entry"), "entry_ref": plan.get("entry_ref"), "sl": plan.get("sl"), "tp": plan.get("tp"),
        "rr": plan.get("rr"), "confidence": float(plan.get("confidence") or 0), "valid": bool(plan.get("valid")),
        "gate": plan.get("gate", ""), "valid_min": plan.get("valid_min"),
        "problem": plan.get("problem", ""), "liq_alignment": plan.get("liq_alignment"),
        "liq_notes": plan.get("liq_notes", []), "session": meta.get("session"), "regime": meta.get("regime"),
        "spread": float(meta.get("spread") or 0), "reason": str(plan.get("reason") or "")[:200],
        "executed": bool(meta.get("executed")), "status": "wait", "result_r": None, "exit": None, "exit_time": None,
    }
    scorable = (rec["action"] in ("BUY", "SELL") and rec["sl"] and rec["tp"] and rec["entry_ref"]
                and ((rec["action"] == "BUY" and rec["sl"] < rec["entry_ref"] < rec["tp"]) or
                     (rec["action"] == "SELL" and rec["tp"] < rec["entry_ref"] < rec["sl"])))
    if rec["action"] in ("BUY", "SELL"):
        rec["status"] = ("pending" if rec["order_type"] != "MARKET" else "open") if scorable else "unscorable"
    with _lock:
        plans = _load()
        plans.append(rec)
        _save(plans)
    return rec["id"]


def mark_executed(plan_id):
    if not plan_id:
        return
    with _lock:
        plans = _load()
        for p in plans:
            if p["id"] == plan_id:
                p["executed"] = True
        _save(plans)


def _score(p, bars, now, expiry_min):
    """Advance one plan with M1 bars (DataFrame, bid prices). Returns True if changed."""
    buy = p["action"] == "BUY"
    spr = p.get("spread") or 0.0
    t0 = (p["time"] // 60 + 1) * 60  # first full minute after the analysis
    b = bars[bars["time"] >= t0]
    entry = p["entry_ref"]
    start = 0
    if p["status"] == "pending":
        lim = p["entry"] or entry
        kind = p["order_type"]
        filled = None
        expiry_min = p.get("valid_min") or expiry_min  # the plan's own validity when the AI gave one
        for i, r in enumerate(b.itertuples()):
            if r.time > p["time"] + expiry_min * 60:
                break
            ask_lo, ask_hi = r.low + spr, r.high + spr
            hit = ((buy and kind == "LIMIT" and ask_lo <= lim) or (buy and kind == "STOP" and ask_hi >= lim) or
                   (not buy and kind == "LIMIT" and r.high >= lim) or (not buy and kind == "STOP" and r.low <= lim))
            if hit:
                filled = i
                break
        if filled is None:
            if now > p["time"] + (p.get("valid_min") or expiry_min) * 60:
                p.update(status="expired", exit="ไม่ถึงราคา Limit/Stop")
                return True
            return False
        p.update(status="open", fill_time=int(b["time"].iat[filled]))
        entry = lim
        p["entry_ref"] = lim
        start = filled  # SL/TP can already be hit in the fill bar
    risk = abs(entry - p["sl"])
    if risk <= 0:
        p.update(status="unscorable")
        return True
    for r in b.iloc[start:].itertuples():
        if buy:
            sl_hit, tp_hit = r.low <= p["sl"], r.high >= p["tp"]
        else:
            sl_hit, tp_hit = r.high + spr >= p["sl"], r.low + spr <= p["tp"]
        if sl_hit or tp_hit:
            win = tp_hit and not sl_hit
            p.update(status="done", exit="TP" if win else "SL", exit_time=int(r.time),
                     result_r=round(abs(p["tp"] - entry) / risk if win else -1.0, 2))
            return True
    if now - p["time"] > TIMEOUT and len(b):
        last = float(b["close"].iat[-1]) + (0 if buy else spr)
        p.update(status="done", exit="หมดเวลา 24 ชม.", exit_time=int(b["time"].iat[-1]),
                 result_r=round(((last - entry) if buy else (entry - last)) / risk, 2))
        return True
    return False


def evaluate(broker, symbol, now, expiry_min=15):
    """Score open/pending plans with M1 data. Called from the AI thread about once a minute."""
    with _lock:
        plans = _load()
        todo = [p for p in plans if p["status"] in ("open", "pending")]
        if not todo:
            return 0
        changed = 0
        for sym_ in {p.get("symbol") or symbol for p in todo}:  # each plan is scored on its own symbol
            mine = [p for p in todo if (p.get("symbol") or symbol) == sym_]
            t_from = min(p["time"] for p in mine) - 60
            bars = broker.rates_range(sym_, "M1", t_from, now + 60)
            if bars is None or not len(bars):
                continue
            bars = bars[bars["time"] + 60 <= now]  # closed M1 bars only
            changed += sum(1 for p in mine if _score(p, bars, now, expiry_min))
        if changed:
            _save(plans)
        return changed


def _agg(rows):
    done = [p for p in rows if p["status"] == "done" and p["result_r"] is not None]
    wins = sum(1 for p in done if p["result_r"] > 0)
    tot = sum(p["result_r"] for p in done)
    return {"n": len(done), "wins": wins, "win_rate": round(wins / len(done) * 100, 1) if done else None,
            "avg_r": round(tot / len(done), 3) if done else None, "total_r": round(tot, 2)}


def lane_stats(days=30, now=None):
    """Results per lane, split into Live (executed) and Shadow / blocked plans."""
    now = now or time.time()
    act = [p for p in _load() if p["time"] >= now - days * 86400 and p["action"] in ("BUY", "SELL")]
    out = {}
    for lane in sorted({p.get("lane", "AI") for p in act}):
        rows = [p for p in act if p.get("lane", "AI") == lane]
        out[lane] = {"all": _agg(rows), "live": _agg([p for p in rows if p["executed"]]),
                     "shadow": _agg([p for p in rows if p.get("origin") == "shadow"]),
                     "blocked": _agg([p for p in rows if not p["valid"]]),
                     # context gate verdict on every plan (shadow too): does the gate pick the losers?
                     "gate_flagged": _agg([p for p in rows if p.get("gate")]),
                     "gate_clear": _agg([p for p in rows if "gate" in p and not p.get("gate")]),
                     "open": sum(1 for p in rows if p["status"] in ("open", "pending")), "plans": len(rows)}
    return out


def stats(days=30, now=None, lane="AI"):
    now = now or time.time()
    plans = [p for p in _load() if p["time"] >= now - days * 86400 and (lane is None or p.get("lane", "AI") == lane)]
    act = [p for p in plans if p["action"] in ("BUY", "SELL")]
    out = {
        "total_plans": len(plans), "wait": sum(1 for p in plans if p["action"] == "WAIT"),
        "open": sum(1 for p in act if p["status"] in ("open", "pending")),
        "expired": sum(1 for p in act if p["status"] == "expired"),
        "all": _agg(act), "executed": _agg([p for p in act if p["executed"]]),
        "valid_only": _agg([p for p in act if p["valid"]]),
        "rejected": _agg([p for p in act if not p["valid"]]),
        "by_confidence": [], "by_liquidity": {}, "by_session": {}, "by_source": {},
    }
    for lo, hi in BUCKETS:
        out["by_confidence"].append({"range": f"{lo}-{min(hi, 100)}",
                                     **_agg([p for p in act if lo <= p["confidence"] < hi])})
    for key, field in (("by_liquidity", "liq_alignment"), ("by_session", "session"), ("by_source", "source")):
        for v in sorted({str(p.get(field)) for p in act}):
            out[key][v] = _agg([p for p in act if str(p.get(field)) == v])
    # smallest confidence threshold whose plans (conf >= threshold) are profitable on >= 20 results
    sugg = None
    for th in (50, 55, 60, 65, 70, 75, 80, 85):
        a = _agg([p for p in act if p["confidence"] >= th and p["valid"]])
        if a["n"] >= 20 and a["avg_r"] is not None and a["avg_r"] > 0:
            sugg = {"min_conf": th, **a}
            break
    out["suggested_min_conf"] = sugg
    out["note"] = ("คะแนนจากราคาจริง M1 – นับทุกแผนแม้ไม่ได้ส่งออเดอร์ · SL/TP ชนในแท่งเดียวกันนับเป็นแพ้ · "
                   "ต้องมีผลอย่างน้อย 20 แผนก่อนเชื่อตัวเลข")
    return out


def recent(limit=50, lane="AI"):
    return [p for p in reversed(_load()) if lane is None or p.get("lane", "AI") == lane][:limit]


def summary_for_ai(now=None):
    """Compact track record that is sent to the AI with every analysis."""
    s = stats(days=14, now=now)
    if not s["all"]["n"]:
        return "ยังไม่มีผลแผนที่ปิดแล้ว (ระบบเพิ่งเริ่มเก็บ)"
    done = [p for p in recent(200) if p["status"] == "done"][:10]
    return {
        "last_14d_all_plans": s["all"],
        "by_confidence": [b for b in s["by_confidence"] if b["n"]],
        "by_liquidity_alignment": s["by_liquidity"],
        "by_session": s["by_session"],
        "last_10_results": [{"action": p["action"], "conf": p["confidence"], "session": p["session"],
                             "liq": p["liq_alignment"], "r": p["result_r"], "exit": p["exit"]} for p in done],
        "how_to_use": "ถ้ากลุ่มไหน avg_r ติดลบต่อเนื่อง (เช่น session หรือระดับความมั่นใจ) ให้ระวัง/ลดความมั่นใจในแบบเดียวกัน",
    }
