/* AI Trader Dashboard – frontend (vanilla JS) */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const TFS = ["M1", "M5", "M15", "M30", "H1", "H4"];
const TF_SEC = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const WD = ["จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส.", "อา."];
const S = { page: "dash", tf: "M5", side: "BUY", status: null, strategies: {}, dashDays: 90, charts: {}, priceLines: [] };

/* ---------------- helpers ---------------- */
// API token is put into index.html by the server; every /api call must send it
const API_TOKEN = (document.querySelector('meta[name="ait-token"]') || {}).content || "";
async function api(path, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}), "X-AIT-Token": API_TOKEN } };
  if (o.body && typeof o.body !== "string") { o.body = JSON.stringify(o.body); o.headers["content-type"] = "application/json"; }
  const r = await fetch("/api/" + path, o);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data.detail;
    const msg = d && d.violations ? d.violations.join("\n") : (typeof d === "string" ? d : r.statusText);
    throw new Error(msg);
  }
  return data;
}
const money = (v, d = 2) => (v === null || v === undefined || isNaN(v)) ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 2) => (v > 0 ? "+" : "") + money(v, d);
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
const pad = (n) => String(n).padStart(2, "0");
function ftime(ts, withDate = true) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withDate ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${t}` : t;
}
const fday = (ts) => { const d = new Date(ts * 1000); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`; };
function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms); }
function confirmClick(btn, label, fn) {
  // two-step button instead of browser dialogs
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; fn(); return; }
  btn.dataset.orig = btn.textContent; btn.dataset.armed = 1; btn.textContent = label;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; } }, 4000);
}
function table(cols, rows, empty = "ไม่มีข้อมูล") {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  return `<table><thead><tr>${cols.map((c) => `<th class="${c.n ? "n" : ""}">${c.h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cols.map((c) => `<td class="${c.n ? "n" : ""} ${c.cls ? c.cls(r) : ""}">${c.f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
const sideTag = (s) => `<span class="tag ${s === "BUY" ? "buy" : "sell"}">${esc(s)}</span>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// only http(s) links from external feeds (blocks javascript: URLs)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
const numTxt = (v) => (v === null || v === undefined || v === "" || isNaN(v) ? "—" : esc(Number(v)));

if (window.Chart) {
  Chart.defaults.color = "#8b98a8";
  Chart.defaults.borderColor = "#233040";
  Chart.defaults.font.family = "'IBM Plex Sans Thai', system-ui";
}
function chartjs(id, cfg) {
  if (!window.Chart) return;
  if (S.charts[id]) S.charts[id].destroy();
  S.charts[id] = new Chart($("#" + id), cfg);
}
const barColors = (arr) => arr.map((v) => (v >= 0 ? "#22c58b" : "#f0566a"));

/* ---------------- navigation ---------------- */
$$(".nav").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));
function go(page) {
  S.page = page;
  $$(".nav").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + page));
  ({ dash: loadDash, term: loadTerminal, journal: loadJournal, ai: loadAI, risk: loadRisk })[page]();
}

/* ---------------- header / status ---------------- */
async function refreshHeader() {
  try {
    const [st, tk] = await Promise.all([api("status"), api("tick")]);
    S.status = st;
    const b = $("#modeBadge");
    b.className = "badge " + (!st.connected ? "off" : st.mode === "live" ? "live" : "demo");
    b.textContent = !st.connected ? "OFFLINE" : st.mode.toUpperCase();
    $("#demoBanner").classList.toggle("show", st.mode === "demo");
    $("#sym").textContent = st.symbol;
    if (tk) {
      const prev = S.lastBid; S.lastBid = tk.bid;
      const el = $("#bid"); el.textContent = money(tk.bid);
      el.className = "px " + (prev ? cls(tk.bid - prev) : "");
      $("#ask").textContent = money(tk.ask); $("#spread").textContent = money(tk.spread);
      $("#srvTime").textContent = ftime(tk.time);
    }
    const kb = $("#killBtn");
    kb.classList.toggle("on", st.kill_switch);
    kb.textContent = st.kill_switch ? "KILL SWITCH: ON" : "KILL SWITCH";
    const kbn = $("#killBanner");
    kbn.classList.toggle("show", st.kill_switch);
    kbn.textContent = st.kill_switch ? `⛔ Kill Switch เปิดอยู่ – ${st.kill_reason || ""} ` + (st.kill_auto ? "(ระบบจะปลดล็อกเองเมื่อขึ้นวันใหม่ตามเวลา Server หรือกดปลดเองที่หน้า Risk)" : "(ไปที่ Risk เพื่อปลดล็อก)") : "";
  } catch (e) {
    $("#modeBadge").className = "badge off"; $("#modeBadge").textContent = "OFFLINE";
  }
}
$("#killBtn").addEventListener("click", (e) => toggleKill(e.currentTarget));
async function toggleKill(btn) {
  const on = S.status && S.status.kill_switch;
  confirmClick(btn, on ? "ยืนยันปลดล็อก?" : "ยืนยัน STOP ทั้งหมด?", async () => {
    try {
      if (on) { await api("kill/release", { method: "POST" }); toast("ปลด Kill Switch แล้ว"); }
      else { const r = await api("kill", { method: "POST", body: { reason: "กดจาก Dashboard" } }); toast(`Kill Switch ON – ปิด ${r.closed.length} รายการ`); }
    } catch (err) { toast(err.message); }
    await refreshHeader(); if (S.page === "risk") loadRisk();
  });
}

/* ---------------- DASHBOARD ---------------- */
$$("#dashRange button").forEach((b) => b.addEventListener("click", () => {
  $$("#dashRange button").forEach((x) => x.classList.toggle("on", x === b));
  S.dashDays = +b.dataset.d; loadDashStats();
}));
async function loadDash() { await Promise.all([loadDashLive(), loadDashStats()]); }
async function loadDashLive() {
  try {
    const d = await api("account");
    const a = d.account, t = d.today;
    $("#kBal").textContent = money(a.balance); $("#kCur").textContent = `${a.currency} · ${a.server} · #${a.login}`;
    $("#kEq").textContent = money(a.equity); $("#hdrEq").textContent = money(a.equity);
    $("#kMl").textContent = a.margin_level ? `Margin level ${money(a.margin_level, 0)}%` : "ไม่มีมาร์จิ้นใช้งาน";
    $("#kCredit").textContent = money(a.credit); $("#kFree").textContent = money(a.margin_free);
    $("#kFloat").textContent = signed(t.floating_pl); $("#kFloat").className = "value " + cls(t.floating_pl);
    $("#kOpen").textContent = `${t.open_positions} positions`;
    $("#kToday").textContent = signed(t.day_pl); $("#kToday").className = "value " + cls(t.day_pl);
    $("#kOrders").textContent = `ปิดแล้ว ${signed(t.closed_pl)} · ${t.orders_today} ออเดอร์`;
    $("#kLossUsed").textContent = t.loss_limit ? `${t.loss_used_pct}%` : "ไม่จำกัด";
    $("#kLossBar").style.width = Math.min(100, t.loss_used_pct) + "%";
    $("#goals").innerHTML = Object.entries({ daily: "รายวัน", weekly: "รายสัปดาห์", monthly: "รายเดือน" }).map(([k, name]) => {
      const g = d.goals[k]; const pct = g.goal > 0 ? Math.max(0, Math.min(100, (g.pnl / g.goal) * 100)) : 0;
      return `<div class="goal-row"><div class="top"><span>${name}</span><span class="num"><b class="${cls(g.pnl)}">${signed(g.pnl)}</b> / ${money(g.goal, 0)}</span></div>
        <div class="prog"><i style="width:${pct}%"></i></div><div class="muted" style="font-size:12px">${pct.toFixed(0)}% ของเป้า</div></div>`;
    }).join("");
    const ps = await api("positions");
    $("#dashPositions").innerHTML = table([
      { h: "ฝั่ง", f: (p) => sideTag(p.side) }, { h: "Lot", n: 1, f: (p) => p.volume },
      { h: "ที่มา", f: (p) => esc(p.source) }, { h: "P/L", n: 1, f: (p) => signed(p.profit), cls: (p) => cls(p.profit) },
    ], ps, "ไม่มีออเดอร์ที่เปิดอยู่");
  } catch (e) { console.warn(e); }
}
async function loadDashStats() {
  const r = await api("analytics?days=" + S.dashDays);
  const s = r.summary, dd = r.drawdown, c = r.consistency;
  $("#sWr").textContent = s.win_rate + "%"; $("#sWl").textContent = `${s.wins}W / ${s.losses}L`;
  $("#sPf").textContent = s.profit_factor ?? "—"; $("#sPay").textContent = `Payoff ${s.payoff ?? "—"}`;
  $("#sDd").textContent = money(dd.max_dd); $("#sDdp").textContent = `${dd.max_dd_pct}% · ตอนนี้ ${money(dd.current_dd)}`;
  $("#sNet").textContent = signed(s.net); $("#sNet").className = "value " + cls(s.net); $("#sTr").textContent = `${s.trades} trades`;
  $("#sExp").textContent = signed(s.expectancy); $("#sAvg").textContent = `W ${money(s.avg_win)} / L ${money(s.avg_loss)}`;
  $("#sGreen").textContent = c.days ? c.green_pct + "%" : "—"; $("#sGreenSub").textContent = c.days ? `${c.green_days}/${c.days} วัน` : "";
  const curve = r.curve;
  chartjs("cEquity", {
    type: "line",
    data: { labels: curve.map((p) => ftime(p.time)), datasets: [{ data: curve.map((p) => p.balance), borderColor: "#e8b64c", borderWidth: 2, pointRadius: 0, fill: { target: "origin", above: "rgba(232,182,76,.08)" }, tension: 0.15 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: false } }, interaction: { intersect: false, mode: "index" } },
  });
  const days = r.daily.slice(-45);
  chartjs("cDaily", {
    type: "bar",
    data: { labels: days.map((d) => fday(d.day)), datasets: [{ data: days.map((d) => d.pnl), backgroundColor: barColors(days.map((d) => d.pnl)), borderRadius: 3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (ctx) => `${days[ctx.dataIndex].trades} trades, ${days[ctx.dataIndex].wins} wins` } } } },
  });
}

/* ---------------- TERMINAL ---------------- */
$("#tfSeg").innerHTML = TFS.map((t) => `<button data-tf="${t}" class="${t === S.tf ? "on" : ""}">${t}</button>`).join("");
$$("#tfSeg button").forEach((b) => b.addEventListener("click", () => {
  S.tf = b.dataset.tf; $$("#tfSeg button").forEach((x) => x.classList.toggle("on", x === b)); loadChart(true);
}));
["#optEma", "#optBb", "#optSig", "#optTrades", "#optSigFilter"].forEach((id) => $(id).addEventListener("change", () => loadChart(false)));

function initChart() {
  if (S.lw || !window.LightweightCharts) return;
  const el = $("#tvchart");
  const c = LightweightCharts.createChart(el, {
    layout: { background: { color: "#121821" }, textColor: "#8b98a8", fontFamily: "JetBrains Mono" },
    grid: { vertLines: { color: "#1a2430" }, horzLines: { color: "#1a2430" } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#233040" },
    rightPriceScale: { borderColor: "#233040" }, crosshair: { mode: 0 },
    autoSize: true,
  });
  S.lw = {
    chart: c,
    candles: c.addCandlestickSeries({ upColor: "#22c58b", downColor: "#f0566a", wickUpColor: "#22c58b", wickDownColor: "#f0566a", borderVisible: false }),
    ema20: c.addLineSeries({ color: "#4c9aff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    ema50: c.addLineSeries({ color: "#e8b64c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    ema200: c.addLineSeries({ color: "#b07cff", lineWidth: 2, priceLineVisible: false, lastValueVisible: false }),
    bbu: c.addLineSeries({ color: "rgba(139,152,168,.6)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }),
    bbm: c.addLineSeries({ color: "rgba(139,152,168,.4)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    bbl: c.addLineSeries({ color: "rgba(139,152,168,.6)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }),
  };
  c.subscribeClick((p) => {  // click on chart = fill pending price
    if (!p.point) return;
    const price = S.lw.candles.coordinateToPrice(p.point.y);
    if ($("#oKind").value !== "MARKET" && price) $("#oPrice").value = price.toFixed(2);
  });
}
function line(key, rows) { return rows.filter((r) => r[key] !== null).map((r) => ({ time: r.time, value: r[key] })); }

async function loadChart(fit) {
  initChart(); if (!S.lw) return;
  const d = await api(`rates?tf=${S.tf}&count=800&signals=${$("#optSig").checked}`);
  const rows = d.candles; S.candles = rows;
  S.lw.candles.setData(rows.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close })));
  const ema = $("#optEma").checked, bb = $("#optBb").checked;
  S.lw.ema20.setData(ema ? line("ema20", rows) : []); S.lw.ema50.setData(ema ? line("ema50", rows) : []); S.lw.ema200.setData(ema ? line("ema200", rows) : []);
  S.lw.bbu.setData(bb ? line("bb_up", rows) : []); S.lw.bbm.setData(bb ? line("bb_mid", rows) : []); S.lw.bbl.setData(bb ? line("bb_lo", rows) : []);
  const markers = [];
  const sf = $("#optSigFilter").value;
  if ($("#optSig").checked) d.signals.filter((s) => !sf || s.strategy === sf).forEach((s) => markers.push({
    time: s.time, position: s.side === "BUY" ? "belowBar" : "aboveBar", color: s.side === "BUY" ? "#22c58b" : "#f0566a",
    shape: s.side === "BUY" ? "arrowUp" : "arrowDown", text: s.strategy,
  }));
  if ($("#optTrades").checked && rows.length) {
    const t0 = rows[0].time, sec = TF_SEC[S.tf];
    const j = await api(`journal?days=30&date_from=${t0}`);
    j.trades.forEach((t) => {
      markers.push({ time: Math.floor(t.open_time / sec) * sec, position: "inBar", color: "#4c9aff", shape: "circle", text: `${t.side === "BUY" ? "B" : "S"} ${t.volume}` });
      if (t.close_time) markers.push({ time: Math.floor(t.close_time / sec) * sec, position: "inBar", color: t.profit >= 0 ? "#22c58b" : "#f0566a", shape: "square", text: signed(t.profit, 0) });
    });
  }
  const times = new Set(rows.map((r) => r.time));
  S.lw.candles.setMarkers(markers.filter((m) => times.has(m.time)).sort((a, b) => a.time - b.time));
  if (fit) S.lw.chart.timeScale().setVisibleLogicalRange({ from: rows.length - 160, to: rows.length + 5 });
}
async function tickChart() {
  if (!S.lw || !S.candles) return;
  const d = await api(`rates?tf=${S.tf}&count=250&signals=false`);
  const last = d.candles.slice(-2);
  last.forEach((r) => S.lw.candles.update({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close }));
}
async function loadTrading() {
  const [ps, os] = await Promise.all([api("positions"), api("orders")]);
  $("#posTable").innerHTML = table([
    { h: "Ticket", f: (p) => p.ticket }, { h: "เวลา", f: (p) => ftime(p.time) }, { h: "ฝั่ง", f: (p) => sideTag(p.side) },
    { h: "Lot", n: 1, f: (p) => p.volume }, { h: "เปิด", n: 1, f: (p) => money(p.price_open) }, { h: "SL", n: 1, f: (p) => p.sl ? money(p.sl) : "—" },
    { h: "TP", n: 1, f: (p) => p.tp ? money(p.tp) : "—" }, { h: "ที่มา", f: (p) => esc(p.source) },
    { h: "P/L", n: 1, f: (p) => signed(p.profit), cls: (p) => cls(p.profit) },
    { h: "", f: (p) => `<button class="btn sm danger" data-close="${p.ticket}">ปิด</button>` },
  ], ps, "ไม่มี Position");
  $("#ordTable").innerHTML = table([
    { h: "Ticket", f: (o) => o.ticket }, { h: "ประเภท", f: (o) => esc(o.type) }, { h: "Lot", n: 1, f: (o) => o.volume },
    { h: "ราคา", n: 1, f: (o) => money(o.price) }, { h: "SL", n: 1, f: (o) => o.sl ? money(o.sl) : "—" }, { h: "TP", n: 1, f: (o) => o.tp ? money(o.tp) : "—" },
    { h: "", f: (o) => `<button class="btn sm" data-cancel="${o.ticket}">ยกเลิก</button>` },
  ], os, "ไม่มี Pending Order");
  if (S.lw) {
    S.priceLines.forEach((pl) => S.lw.candles.removePriceLine(pl)); S.priceLines = [];
    const add = (price, color, title, style = 0) => price && S.priceLines.push(S.lw.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    ps.forEach((p) => { add(p.price_open, "#4c9aff", `${p.side} ${p.volume}`); add(p.sl, "#f0566a", "SL", 2); add(p.tp, "#22c58b", "TP", 2); });
    os.forEach((o) => add(o.price, "#e8b64c", o.type, 1));
  }
}
document.addEventListener("click", async (e) => {
  const c = e.target.closest("[data-close]"), x = e.target.closest("[data-cancel]");
  try {
    if (c) confirmClick(c, "ยืนยัน?", async () => { const r = await api(`position/${c.dataset.close}/close`, { method: "POST" }); toast(r.message || "ปิดแล้ว"); loadTrading(); });
    if (x) { const r = await api(`order/${x.dataset.cancel}`, { method: "DELETE" }); toast(r.message || "ยกเลิกแล้ว"); loadTrading(); }
  } catch (err) { toast(err.message); }
});
$("#closeAll").addEventListener("click", (e) => confirmClick(e.currentTarget, "ยืนยันปิดทั้งหมด?", async () => {
  const r = await api("close_all", { method: "POST" }); toast(`ปิด/ยกเลิก ${r.length} รายการ`); loadTrading();
}));

/* order form */
function setSide(side) {
  S.side = side;
  $(".side-toggle .b").classList.toggle("on", side === "BUY"); $(".side-toggle .s").classList.toggle("on", side === "SELL");
  const btn = $("#oSend"); btn.className = "btn mt " + (side === "BUY" ? "buy" : "sell"); btn.textContent = "ส่งคำสั่ง " + side;
}
$$(".side-toggle button").forEach((b) => b.addEventListener("click", () => setSide(b.dataset.side)));
$("#oKind").addEventListener("change", () => { const m = $("#oKind").value === "MARKET"; $("#oPrice").disabled = m; $("#oPrice").placeholder = m ? "market" : "คลิกบนกราฟได้"; });
function entryPrice() {
  if ($("#oKind").value !== "MARKET") return parseFloat($("#oPrice").value) || null;
  if (!S.status) return null;
  return null; // server uses live bid/ask
}
$("#oAuto").addEventListener("click", async () => {
  const dist = parseFloat($("#oSlDist").value), rr = parseFloat($("#oRR").value) || 2;
  if (!dist) return toast("ใส่ระยะ SL ($) ก่อน");
  let e = entryPrice();
  if (!e) { const t = await api("tick"); e = S.side === "BUY" ? t.ask : t.bid; }
  const k = S.side === "BUY" ? 1 : -1;
  $("#oSl").value = (e - k * dist).toFixed(2); $("#oTp").value = (e + k * dist * rr).toFixed(2);
  runCalc(true);
});
async function runCalc(setLot) {
  try {
    const body = { side: S.side, entry: entryPrice(), sl: $("#oSl").value, tp: $("#oTp").value, risk_pct: $("#oRisk").value };
    if (!setLot || S.lotMode === "fixed") body.lot = $("#oLot").value;
    const r = await api("calc", { method: "POST", body });
    if (r.error) { $("#oCalc").innerHTML = `<div class="neg">${esc(r.error)}</div>`; return; }
    if (setLot) $("#oLot").value = r.lot;
    $("#oCalc").innerHTML = `
      <div><span class="muted">ราคาเข้า</span><span class="num">${money(r.entry)}</span></div>
      <div><span class="muted">Lot</span><span class="num">${r.lot}${r.raw_lot !== undefined ? ` <span class="muted">(คำนวณได้ ${r.raw_lot})</span>` : S.lotMode === "fixed" ? ' <span class="muted">(Lot คงที่)</span>' : ""}</span></div>
      <div><span class="muted">ความเสี่ยง</span><span class="num neg">-${money(r.risk_money)} (${r.risk_pct}%)</span></div>
      <div><span class="muted">ผลตอบแทนถ้าถึง TP</span><span class="num pos">${r.reward_money !== undefined ? "+" + money(r.reward_money) : "—"}</span></div>
      <div><span class="muted">Risk : Reward</span><span class="num">${r.rr ? "1 : " + r.rr : "—"}</span></div>`;
  } catch (e) { $("#oCalc").innerHTML = `<div class="neg">${esc(e.message)}</div>`; }
}
$("#oCalcBtn").addEventListener("click", () => runCalc(true));
["#oLot", "#oSl", "#oTp"].forEach((id) => $(id).addEventListener("change", () => runCalc(false)));
$("#oLot").addEventListener("input", () => (S.lotTouched = true));
$("#oSend").addEventListener("click", (e) => {
  const lot = $("#oLot").value, kind = $("#oKind").value;
  confirmClick(e.currentTarget, `ยืนยัน ${kind} ${S.side} ${lot} lot`, async () => {
    $("#oMsg").innerHTML = "";
    try {
      const r = await api("order", { method: "POST", body: { side: S.side, kind, volume: lot, price: $("#oPrice").value, sl: $("#oSl").value, tp: $("#oTp").value, strategy: $("#oStrat").value } });
      $("#oMsg").innerHTML = `<div class="ok">✓ ${esc(r.message)} #${esc(r.order)}</div>`; loadTrading();
    } catch (err) { $("#oMsg").innerHTML = `<div class="err">✗ ${esc(err.message)}</div>`; }
  });
});
function useSignal(s) {
  go("term"); setSide(s.side); $("#oKind").value = "MARKET"; $("#oKind").dispatchEvent(new Event("change"));
  $("#oSl").value = s.sl; $("#oTp").value = s.tp; $("#oStrat").value = s.strategy; runCalc(true);
  toast(`โหลดสัญญาณ ${s.strategy} ${s.side} เข้าแบบฟอร์มแล้ว – ตรวจสอบก่อนส่ง`);
}
async function loadTerminal() {
  initChart(); await Promise.all([loadChart(true), loadTrading()]);
  try {
    const r = await api("risk"); $("#oRisk").value = r.config.risk_per_trade_pct;
    S.lotMode = r.config.lot_mode; S.defLot = r.config.default_lot;
    if (!S.lotTouched) $("#oLot").value = r.config.lot_mode === "fixed" ? r.config.default_lot : $("#oLot").value;
  } catch (e) {}
}

/* ---------------- JOURNAL ---------------- */
function jQuery() {
  const q = new URLSearchParams({ days: 365 });
  const f = $("#jFrom").value, t = $("#jTo").value;
  if (f) q.set("date_from", Date.parse(f + "T00:00:00Z") / 1000);
  if (t) q.set("date_to", Date.parse(t + "T23:59:59Z") / 1000);
  const h1 = $("#jH1").value, h2 = $("#jH2").value;
  if (h1 !== "" && h2 !== "") { q.set("hour_from", h1); q.set("hour_to", h2); }
  [["source", "#jSource"], ["strategy", "#jStrat"], ["side", "#jSide"], ["result", "#jRes"]].forEach(([k, id]) => $(id).value && q.set(k, $(id).value));
  return q.toString();
}
async function loadJournal() {
  const d = await api("journal?" + jQuery());
  const fill = (id, arr) => { const cur = $(id).value; $(id).innerHTML = `<option value="">ทั้งหมด</option>` + arr.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join(""); };
  fill("#jSource", d.sources); fill("#jStrat", d.strategies);
  const s = d.summary;
  const k = (l, v, c = "") => `<div class="card kpi"><div class="label">${l}</div><div class="value ${c}">${v}</div></div>`;
  $("#jSummary").innerHTML = k("จำนวนไม้ (ปิดแล้ว)", s.trades) + k("Win Rate", s.win_rate + "%") + k("Net", signed(s.net), cls(s.net)) +
    k("Profit Factor", s.profit_factor ?? "—") + k("เฉลี่ย ชนะ / แพ้", `${money(s.avg_win, 0)} / ${money(s.avg_loss, 0)}`) + k("แพ้ติดกันสูงสุด", s.max_consec_losses);
  $("#jTable").innerHTML = table([
    { h: "เปิด", f: (t) => ftime(t.open_time) }, { h: "ฝั่ง", f: (t) => sideTag(t.side) }, { h: "Lot", n: 1, f: (t) => t.volume },
    { h: "ราคาเปิด", n: 1, f: (t) => money(t.open_price) }, { h: "ปิด", f: (t) => ftime(t.close_time) }, { h: "ราคาปิด", n: 1, f: (t) => t.close_price ? money(t.close_price) : "—" },
    { h: "ระยะ ($)", n: 1, f: (t) => t.points ?? "—", cls: (t) => cls(t.points) }, { h: "กำไร", n: 1, f: (t) => t.status === "open" ? "เปิดอยู่" : signed(t.profit), cls: (t) => cls(t.profit) },
    { h: "ที่มา", f: (t) => `<span class="tag">${esc(t.source)}</span>` }, { h: "กลยุทธ์", f: (t) => esc(t.strategy) }, { h: "ออกโดย", f: (t) => esc(t.exit_reason) },
    { h: "นาน (นาที)", n: 1, f: (t) => t.duration_min ?? "—" },
    { h: "โน้ต", f: (t) => `<input class="note-in" data-note="${t.position_id}" value="${esc(t.note)}" placeholder="+ โน้ต">` },
  ], d.trades, "ไม่พบออเดอร์ตามเงื่อนไข");
}
$("#jApply").addEventListener("click", loadJournal);
$("#jReset").addEventListener("click", () => { ["#jFrom", "#jTo", "#jH1", "#jH2", "#jSource", "#jStrat", "#jSide", "#jRes"].forEach((i) => ($(i).value = "")); loadJournal(); });
$("#jCsv").addEventListener("click", () => { window.location.href = "/api/journal.csv?" + jQuery() + "&token=" + encodeURIComponent(API_TOKEN); });
document.addEventListener("change", async (e) => {
  const n = e.target.closest("[data-note]");
  if (n) { await api(`journal/${n.dataset.note}/note`, { method: "POST", body: { note: n.value } }); toast("บันทึกโน้ตแล้ว"); }
});

/* ---------------- AI & ANALYTICS ---------------- */
async function loadSignals() {
  const d = await api("signals"); S.strategies = d.strategies;
  $("#scanInfo").textContent = d.last_scan ? `สแกน ${d.tf} ล่าสุด ${new Date(d.last_scan * 1000).toLocaleTimeString()}` : "ยังไม่ได้สแกน";
  const row = (s) => `<div class="sig">${sideTag(s.side)}<div><b>${esc(s.name || S.strategies[s.strategy] || s.strategy)}</b> <span class="num">@ ${money(s.entry)}</span>
    <div class="why">SL ${money(s.sl)} · TP ${money(s.tp)} · ${esc(s.reason)}</div></div><button class="btn sm" data-use='${esc(JSON.stringify(s))}'>ใช้</button></div>`;
  $("#sigLatest").innerHTML = d.latest.length ? d.latest.map(row).join("") : `<div class="empty">ยังไม่มีสัญญาณใหม่ใน 2 แท่งล่าสุด – Scanner ทำงานอยู่เบื้องหลัง</div>`;
  $("#sigHistory").innerHTML = table([
    { h: "แท่ง", f: (s) => ftime(s.time) }, { h: "กลยุทธ์", f: (s) => esc(s.strategy) }, { h: "ฝั่ง", f: (s) => sideTag(s.side) },
    { h: "Entry", n: 1, f: (s) => money(s.entry) }, { h: "SL", n: 1, f: (s) => money(s.sl) }, { h: "TP", n: 1, f: (s) => money(s.tp) },
    { h: "", f: (s) => `<button class="btn sm" data-use='${esc(JSON.stringify(s))}'>ใช้</button>` },
  ], d.history, "ยังไม่มีประวัติสัญญาณในเซสชันนี้");
}
document.addEventListener("click", (e) => { const u = e.target.closest("[data-use]"); if (u) useSignal(JSON.parse(u.dataset.use)); });

async function runBacktest() {
  $("#btTable").innerHTML = `<div class="empty">กำลังทดสอบ…</div>`;
  const d = await api(`backtest?tf=${$("#btTf").value}&count=${$("#btBars").value}`);
  const rows = Object.entries(d.results).map(([k, v]) => ({ k, ...v }));
  $("#btTable").innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">${d.bars} แท่ง ${d.tf} · ${ftime(d.from)} → ${ftime(d.to)}</div>` + table([
    { h: "กลยุทธ์", f: (r) => `<b>${r.k}</b> <span class="muted">${esc(r.name)}</span>` }, { h: "สัญญาณ", n: 1, f: (r) => r.signals },
    { h: "Win Rate", n: 1, f: (r) => r.win_rate + "%" }, { h: "Profit Factor", n: 1, f: (r) => r.profit_factor ?? "—", cls: (r) => cls((r.profit_factor ?? 1) - 1) },
    { h: "รวม (R)", n: 1, f: (r) => signed(r.total_r), cls: (r) => cls(r.total_r) }, { h: "Expectancy (R/ไม้)", n: 1, f: (r) => signed(r.expectancy_r, 3), cls: (r) => cls(r.expectancy_r) },
    { h: "Max DD (R)", n: 1, f: (r) => money(r.max_dd_r) },
  ], rows);
}
$("#btRun").addEventListener("click", runBacktest);

async function loadPerf() {
  const r = await api("analytics?days=90");
  const rows = [...Object.entries(r.by_strategy).map(([k, v]) => ({ k, ...v }))].sort((a, b) => b.net - a.net);
  $("#perfStrat").innerHTML = table([
    { h: "กลยุทธ์ / EA", f: (x) => esc(x.k) }, { h: "ไม้", n: 1, f: (x) => x.trades }, { h: "Win%", n: 1, f: (x) => x.win_rate },
    { h: "PF", n: 1, f: (x) => x.profit_factor ?? "—" }, { h: "Net", n: 1, f: (x) => signed(x.net), cls: (x) => cls(x.net) },
    { h: "Exp./ไม้", n: 1, f: (x) => signed(x.expectancy), cls: (x) => cls(x.expectancy) }, { h: "แพ้ติด", n: 1, f: (x) => x.max_consec_losses },
  ], rows);
  const c = r.consistency, s = r.summary, dd = r.drawdown;
  const li = (l, v) => `<div class="calc" style="margin:0 0 6px"><div><span class="muted">${l}</span><span class="num">${v}</span></div></div>`;
  $("#consist").innerHTML = c.days ? [
    li("วันเทรดทั้งหมด / วันที่กำไร", `${c.days} / ${c.green_days} (${c.green_pct}%)`),
    li("กำไรเฉลี่ยต่อวัน ± SD", `${signed(c.avg_day)} ± ${money(c.std_day)}`),
    li("วันดีที่สุด / แย่ที่สุด", `${signed(c.best_day)} / ${signed(c.worst_day)}`),
    li("สัดส่วนกำไรจากวันที่ดีที่สุด", c.best_day_share_pct !== null ? c.best_day_share_pct + "% (ยิ่งต่ำยิ่งสม่ำเสมอ)" : "—"),
    li("Sharpe (รายวัน, annualized)", c.sharpe_daily_ann ?? "—"),
    li("Max Drawdown", `${money(dd.max_dd)} (${dd.max_dd_pct}%)`),
    li("ขาดทุนใหญ่สุด / แพ้ติดกันสูงสุด", `${signed(s.largest_loss)} / ${s.max_consec_losses} ไม้`),
    li("ถือออเดอร์เฉลี่ย", `${s.avg_duration_min} นาที`),
  ].join("") : `<div class="empty">ยังไม่มีข้อมูล</div>`;
  chartjs("cHour", { type: "bar", data: { labels: r.by_hour.map((h) => pad(h.hour)), datasets: [{ data: r.by_hour.map((h) => h.pnl), backgroundColor: barColors(r.by_hour.map((h) => h.pnl)), borderRadius: 3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } } });
  chartjs("cWd", { type: "bar", data: { labels: r.by_weekday.map((w) => WD[w.wd]), datasets: [{ data: r.by_weekday.map((w) => w.pnl), backgroundColor: barColors(r.by_weekday.map((w) => w.pnl)), borderRadius: 3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } } });
}
function mdLite(t) {
  // tiny markdown renderer for AI answers: headings, bold, bullets
  return esc(t).split("\n").map((l) => {
    let x = l.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*\*/g, "");
    if (/^#{1,4}\s/.test(x)) return `<div style="font-weight:700;margin-top:6px">${x.replace(/^#{1,4}\s/, "")}</div>`;
    if (/^\s*[-•*]\s/.test(x)) return `<div style="padding-left:14px;text-indent:-10px">• ${x.replace(/^\s*[-•*]\s/, "")}</div>`;
    return x.trim() ? `<div>${x}</div>` : `<div style="height:6px"></div>`;
  }).join("");
}
function showPlan(p) {
  S.aiPlan = p;
  if (!p) { $("#aiPlan").style.display = "none"; $("#aiPlanRow").style.display = "none"; return; }
  $("#aiPlan").style.display = "block";
  const act = p.action === "BUY" ? '<b class="pos">BUY</b>' : p.action === "SELL" ? '<b class="neg">SELL</b>' : '<b>WAIT</b>';
  $("#aiPlan").innerHTML = `<div><span class="muted">แผน AI (${p.source === "rules" ? "จากกฎ" : p.source === "openai" ? "ChatGPT" : "Claude"})</span><span>${act} ${p.action !== "WAIT" ? esc(p.order_type) : ""}</span></div>` +
    (p.action !== "WAIT" ? `<div><span class="muted">เข้า</span><span class="num">${p.entry ? money(p.entry) : "Market ≈ " + money(p.entry_ref)}</span></div>
     <div><span class="muted">SL / TP</span><span class="num">${money(p.sl)} / ${p.tp ? money(p.tp) : "—"}${p.rr ? ` (R:R 1:${numTxt(p.rr)})` : ""}</span></div>
     <div><span class="muted">ความมั่นใจ</span><span class="num">${numTxt(p.confidence)}%</span></div>` : "") +
    `<div style="display:block;color:var(--muted);font-size:12px;margin-top:4px">${esc(p.reason || "")}${p.problem ? ` · <span class="neg">${esc(p.problem)}</span>` : ""}</div>`;
  const extra = [...(p.liq_notes || []).filter((n) => !n.startsWith("⚠")), ...(p.warnings || [])];
  if (extra.length) $("#aiPlan").innerHTML += `<div style="display:block;font-size:12px;margin-top:4px">${extra.map((n) => `<div class="${n.startsWith("⚠") ? "neg" : "muted"}">💧 ${esc(n)}</div>`).join("")}</div>`;
  const can = p.action !== "WAIT" && p.valid;
  $("#aiPlanRow").style.display = can ? "flex" : "none";
  if (can) { $("#aiExec").className = "btn " + (p.action === "BUY" ? "buy" : "sell"); $("#aiExec").textContent = `ส่งออเดอร์ ${p.action} ตามแผน AI`; $("#aiExec").style.flex = "1"; }
}
$("#aiBtn").addEventListener("click", async () => {
  $("#aiOut").textContent = "AI กำลังวิเคราะห์…"; $("#aiNote").textContent = ""; $("#aiExecMsg").innerHTML = ""; showPlan(null);
  try {
    const r = await api("ai/analyze", { method: "POST", body: { question: $("#aiQ").value } });
    $("#aiOut").innerHTML = mdLite(r.text.replace(/```json[\s\S]*?```/g, "").trim());
    $("#aiNote").textContent = r.source === "closed" ? "ตลาดปิด – ไม่ได้ส่งข้อมูลไปถาม AI" :
      (r.source === "claude" || r.source === "openai" ? `วิเคราะห์โดย ${r.model}` : "วิเคราะห์จากกฎ (rule-based)") + (r.note ? " · " + r.note : "");
    showPlan(r.plan);
  } catch (e) { $("#aiOut").textContent = "ผิดพลาด: " + e.message; }
});
$("#aiExec").addEventListener("click", (e) => confirmClick(e.currentTarget, "ยืนยันส่งออเดอร์?", async () => {
  try {
    const r = await api("ai/execute", { method: "POST", body: { plan: S.aiPlan } });
    $("#aiExecMsg").innerHTML = `<div class="ok">✓ ${esc(r.message)} #${esc(r.order)}</div>`;
  } catch (err) { $("#aiExecMsg").innerHTML = `<div class="err">✗ ${esc(err.message)}</div>`; }
}));
async function loadAIState() {
  const s = await api("ai/state");
  $("#aiAuto").checked = s.ai_auto; $("#aiInt").value = s.interval_min; $("#aiConf").value = s.min_conf;
  $("#aiLiq").value = s.liquidity_mode || "block"; $("#aiExp").value = s.limit_expiry_min ?? 45;
  $("#aiRev").value = s.review_mode || "shadow"; $("#aiRevR").value = s.review_trigger_r ?? 0.5; $("#aiRevConf").value = s.review_min_conf ?? 60;
  $("#laneGate").value = s.gate_mode || "block";
  loadAIReviews().catch(() => {});
  loadAIJournal().catch(() => {});
  try { const rg = await api("regime"); $("#aiAutoInfo").dataset.reg = rg.label; } catch (e) {}
  $("#aiAutoInfo").innerHTML = (s.has_key ? `ใช้ ${s.provider === "openai" ? "ChatGPT" : "Claude"} วิเคราะห์` : "ยังไม่มี API Key → ใช้แผนจากกฎ (ใส่ Key ได้ที่ Risk & Settings)") +
    (s.last_run ? ` · ครั้งล่าสุด ${new Date(s.last_run * 1000).toLocaleTimeString()}: ${s.last ? esc(s.last.action) + (s.last.confidence ? " " + numTxt(s.last.confidence) + "%" : "") : "-"}` : "") +
    ` · ผลการส่งดูได้ที่หน้า Risk → Auto-Trade ล่าสุด`;
  if (s.last && !S.aiPlan) showPlan(s.last);
}
$("#aiSave").addEventListener("click", async () => {
  await api("settings", { method: "POST", body: { scanner: { ai_auto: $("#aiAuto").checked, ai_interval_min: Math.max(1, +$("#aiInt").value || 15), ai_min_conf: +$("#aiConf").value || 65, ai_liquidity_mode: $("#aiLiq").value, ai_limit_expiry_min: Math.max(0, +$("#aiExp").value || 0),
    ai_review_mode: $("#aiRev").value, ai_review_trigger_r: Math.max(0.1, +$("#aiRevR").value || 0.5), ai_review_min_conf: +$("#aiRevConf").value || 60,
    lane_gate_mode: $("#laneGate").value } } });
  toast("บันทึก AI Auto-Trade แล้ว"); loadAIState(); refreshAutoBadge();
});
async function loadAIJournal() {
  const d = await api("ai/journal?days=30&limit=15"), s = d.stats;
  const fmtR = (v) => (v === null || v === undefined ? "—" : `<span class="${cls(v)}">${signed(v, 2)}R</span>`);
  const a = s.all;
  $("#aiJrInfo").innerHTML = `30 วัน: ${s.total_plans} แผน (WAIT ${s.wait}) · ปิดผลแล้ว ${a.n} · ชนะ ${a.win_rate ?? "—"}% · เฉลี่ย ${fmtR(a.avg_r)} · รอผล ${s.open} · Limit ไม่ถึงราคา ${s.expired}` +
    (s.suggested_min_conf ? ` · <b>แนะนำความมั่นใจ ≥ ${s.suggested_min_conf.min_conf}</b> (${s.suggested_min_conf.n} แผน, เฉลี่ย ${signed(s.suggested_min_conf.avg_r, 2)}R)` : " · ยังไม่มีข้อมูลพอแนะนำเกณฑ์ (ต้อง ≥ 20 แผนที่ปิดผล)") +
    `<br>${esc(s.note)}`;
  const grp = (label, o) => ({ g: label, ...o });
  const rows = [...s.by_confidence.map((b) => grp("ความมั่นใจ " + b.range, b)),
    ...Object.entries(s.by_liquidity).map(([k, v]) => grp("Liquidity: " + ({ with: "ตาม sweep", against: "สวน sweep", mixed: "ปนกัน", none: "ไม่มี sweep" }[k] || k), v)),
    grp("ส่งออเดอร์จริง", s.executed), grp("ถูกระบบปฏิเสธ", s.rejected)].filter((r) => r.n);
  $("#aiJrConf").innerHTML = table([{ h: "กลุ่ม", f: (r) => esc(r.g) }, { h: "ปิดผล", n: 1, f: (r) => r.n }, { h: "ชนะ %", n: 1, f: (r) => r.win_rate ?? "—" },
    { h: "เฉลี่ย", n: 1, f: (r) => fmtR(r.avg_r) }, { h: "รวม", n: 1, f: (r) => fmtR(r.total_r) }], rows, "ยังไม่มีแผนที่ปิดผล – ระบบเริ่มเก็บแล้ว");
  const st = { open: "รอผล", pending: "รอเข้า", done: "ปิดผล", expired: "ไม่ถึงราคา", wait: "WAIT", unscorable: "ใช้ไม่ได้" };
  $("#aiJrRecent").innerHTML = table([{ h: "เวลา", f: (p) => ftime(p.time) }, { h: "แผน", f: (p) => p.action === "WAIT" ? "WAIT" : sideTag(p.action) + " " + esc(p.order_type) },
    { h: "มั่นใจ", n: 1, f: (p) => numTxt(p.confidence) }, { h: "Liquidity", f: (p) => esc(p.liq_alignment || "—") },
    { h: "ส่งจริง", f: (p) => (p.executed ? "✓" : p.valid || p.action === "WAIT" ? "" : `<span class="muted" title="${esc(p.problem)}">ปฏิเสธ</span>`) },
    { h: "สถานะ", f: (p) => esc(st[p.status] || p.status) + (p.exit ? " · " + esc(p.exit) : "") }, { h: "ผล", n: 1, f: (p) => fmtR(p.result_r) }],
    d.recent, "ยังไม่มีแผน");
}
async function loadAIReviews() {
  const d = await api("ai/reviews?days=30&limit=15"), s = d.stats;
  const fmtR = (v) => (v === null || v === undefined ? "—" : `<span class="${cls(v)}">${signed(v, 2)}R</span>`);
  $("#aiRvInfo").innerHTML = `30 วัน: รีวิว ${s.reviews} ครั้ง · ปิดผลแล้ว ${s.all.n} · AI ช่วย ${s.all.helped} / แย่ลง ${s.all.hurt} · gain เฉลี่ย ${fmtR(s.all.avg_gain_r)} · <b>${esc(s.verdict)}</b>`;
  const rows = Object.entries(s.by_action).map(([k, v]) => ({ k, ...v })).filter((r) => r.n);
  const recent = d.recent.map((r) => `<tr><td>${ftime(r.time)}</td><td>${esc(r.lane)} ${sideTag(r.side)}</td><td class="n">${signed(r.r_at, 2)}R</td>
    <td><b>${esc(r.ai_action || r.action)}</b>${r.new_sl ? " SL→" + esc(r.new_sl) : ""}${r.new_tp ? " TP→" + esc(r.new_tp) : ""} <span class="muted">${numTxt(r.confidence)}%</span>${r.problem ? ` <span class="neg" title="${esc(r.problem)}">ปฏิเสธ</span>` : ""}</td>
    <td>${r.executed ? "✓ ทำแล้ว" : esc(r.mode)}</td><td class="n">${fmtR(r.decision_r)} / ${fmtR(r.baseline_r)}</td><td class="n">${fmtR(r.gain_r)}</td>
    <td style="white-space:normal;font-size:12px" class="muted">${esc(r.reason)}</td></tr>`).join("");
  $("#aiRvTable").innerHTML = (rows.length ? table([{ h: "การตัดสินใจ", f: (r) => esc(r.k) }, { h: "ปิดผล", n: 1, f: (r) => r.n },
    { h: "ผล AI", n: 1, f: (r) => fmtR(r.avg_decision_r) }, { h: "ถ้าปล่อยไว้", n: 1, f: (r) => fmtR(r.avg_baseline_r) },
    { h: "gain เฉลี่ย", n: 1, f: (r) => fmtR(r.avg_gain_r) }], rows) : "") +
    (recent ? `<table class="mt"><thead><tr><th>เวลา</th><th>ไม้</th><th class="n">ตอนรีวิว</th><th>AI ตัดสินใจ</th><th>โหมด</th><th class="n">ผล AI / ปล่อยไว้</th><th class="n">gain</th><th>เหตุผล</th></tr></thead><tbody>${recent}</tbody></table>`
      : `<div class="empty">ยังไม่มีไม้ที่ผิดทางถึงเกณฑ์</div>`);
}
$("#aiRvRefresh").addEventListener("click", () => loadAIReviews().catch((e) => toast(e.message)));
$("#aiJrRefresh").addEventListener("click", () => loadAIJournal().catch((e) => toast(e.message)));
async function loadLanes() {
  const d = await api("lanes?days=30");
  const L = d.limits;
  $("#lnInfo").innerHTML = `โควตาต่อเลน: ${L.lane_max_positions} ไม้พร้อมกัน · เว้น ${L.lane_cooldown_min} นาที · ${L.lane_max_orders_day} ไม้/วัน · ขาดทุนไม่เกิน ${L.lane_max_daily_loss_pct}%/วัน` +
    ` · ความเสี่ยงรวมที่เปิดอยู่ตอนนี้ ${d.open_risk_pct ?? "—"}% (เพดาน ${L.max_total_open_risk_pct}%) · Position รวมสูงสุด ${L.max_open_positions}`;
  const fmtR = (v) => (v === null || v === undefined ? "—" : `<span class="${cls(v)}">${signed(v, 2)}R</span>`);
  const res = (o) => (o && o.n ? `${o.n} · ${o.win_rate}% · ${fmtR(o.avg_r)}` : "—");
  const badge = (m) => `<span class="tag ${m === "live" ? "buy" : m === "shadow" ? "" : "sell"}">${{ live: "LIVE", shadow: "SHADOW", off: "ปิด" }[m] || esc(m)}</span>`;
  $("#lnTable").innerHTML = table([
    { h: "เลน", f: (x) => `<b>${esc(x.lane)}</b> <span class="muted">${esc(x.name)}</span>` }, { h: "Symbol", f: (x) => esc(x.symbol || "") }, { h: "โหมด", f: (x) => badge(x.mode) },
    { h: "วันนี้ (เปิด/ไม้/P&L)", f: (x) => `${x.status.open + x.status.pending} / ${x.status.orders_today} / <span class="${cls(x.status.day_pl)}">${signed(x.status.day_pl)}</span>` },
    { h: "Shadow (แผน·ชนะ·เฉลี่ย)", f: (x) => res(x.results && x.results.shadow) },
    { h: "Live (ไม้·ชนะ·เฉลี่ย)", f: (x) => res(x.results && x.results.live) },
    { h: "ถูกบล็อก (ถ้าเข้าจะได้)", f: (x) => res(x.results && x.results.blocked) },
    { h: "ตัวกรองบริบท: ติดธง / ผ่าน", f: (x) => `${res(x.results && x.results.gate_flagged)} <span class="muted">/</span> ${res(x.results && x.results.gate_clear)}` },
  ], d.lanes);
}
$("#lnRefresh").addEventListener("click", () => loadLanes().catch((e) => toast(e.message)));
async function loadAI() { await Promise.all([loadLanes().catch(() => {}), loadSignals(), loadAIState(), loadNews(), loadPerf(), runBacktest(), loadOptimizer(), runGiveBack()]); }


/* ---------------- ADAPTIVE OPTIMIZER ---------------- */
const CONF = { "สูง": "h", "กลาง": "m", "ต่ำ": "l" };
const fmtR = (v) => (v === null || v === undefined) ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(3);
const plabel = (k) => (S.optLabels && S.optLabels[k]) || k;
async function loadOptimizer() {
  const d = await api("optimize"); S.optLabels = d.labels;
  $("#opProg").style.display = d.running ? "block" : "none";
  $("#opBar").style.width = d.progress + "%"; $("#opStage").textContent = `${d.stage} · ${d.progress}%`;
  $("#opRun").disabled = d.running;
  if (d.error) $("#opMeta").innerHTML = `<span class="neg">ผิดพลาด: ${esc(d.error)}</span>`;
  const r = d.result;
  if (r && !d.error) {
    const m = r.meta;
    $("#opMeta").textContent = `ผลล่าสุด: ${m.symbol} ${m.tf} · ${m.bars.toLocaleString()} แท่ง (${ftime(m.from)} → ${ftime(m.to)}) · ต้นทุน ${m.cost}/ไม้ · ทดสอบ ${m.combos_tested} ชุดพารามิเตอร์ · รันเมื่อ ${m.run_time ? new Date(m.run_time * 1000).toLocaleString() : "-"}`;
    renderRecs(r.recommendations);
    renderOptTable(r.strategies);
  }
  renderHistory(d.history);
  const p = await api("strategy_params");
  $("#opParams").innerHTML = table([
    { h: "กลยุทธ์", f: (x) => `<b>${x.code}</b>${x.custom ? ' <span class="tag buy">ปรับแล้ว</span>' : ""}` },
    { h: "พารามิเตอร์", f: (x) => Object.entries(x.params).map(([k, v]) => `${plabel(k)} <b class="mono">${v}</b>`).join(" · ") },
    { h: "", f: (x) => x.custom ? `<button class="btn sm" data-preset="${x.code}">ค่าเริ่มต้น</button>` : "" },
  ], Object.entries(p).map(([code, v]) => ({ code, ...v })));
  if (d.running) { clearTimeout(S.optTimer); S.optTimer = setTimeout(loadOptimizer, 1500); }
}
function renderRecs(recs) {
  if (!recs.length) {
    $("#opRecs").innerHTML = `<div class="empty">ไม่มีข้อเสนอที่ผ่านเกณฑ์ – ค่าปัจจุบันดีพอแล้ว หรือหลักฐานยังไม่พอจะเปลี่ยน (ซึ่งดีกว่าการปรับตามข้อมูลที่ไม่น่าเชื่อถือ)</div>`;
    $("#opApplyRow").style.display = "none"; return;
  }
  $("#opRecs").innerHTML = recs.map((x) => {
    const chg = Object.entries(x.changes || {}).map(([k, v]) => `${plabel(k)}: <span class="muted">${v[0]}</span> → <b>${v[1]}</b>`).join(" &nbsp;·&nbsp; ");
    const cb = x.type === "warning" ? `<span style="color:var(--amber)">!</span>` : `<input type="checkbox" data-rec="${x.id}" ${x.confidence === "สูง" ? "checked" : ""}>`;
    return `<div class="rec ${x.type}">${cb}<div><div class="head">${esc(x.title)}
      ${x.type !== "warning" ? `<span class="conf ${CONF[x.confidence] || "l"}">ความมั่นใจ ${x.confidence}</span>` : ""}
      ${x.expected_gain_r ? `<span class="muted" style="font-weight:400;font-size:12px">คาดว่าดีขึ้น ${fmtR(x.expected_gain_r)}R/ไม้</span>` : ""}</div>
      ${chg ? `<div class="chg">${chg}</div>` : ""}<ul>${x.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div></div>`;
  }).join("");
  $("#opApplyRow").style.display = recs.some((x) => x.type !== "warning") ? "flex" : "none";
}
function renderOptTable(s) {
  const rows = Object.entries(s).map(([code, v]) => ({ code, ...v }));
  const verdict = (x) => {
    if (x.current_oos.trades < 20) return `<span class="muted">ข้อมูลน้อย</span>`;
    if (x.current_oos.exp_r > 0 && x.current_windows_positive >= 3) return `<span class="pos">มี edge</span>`;
    if (x.current_oos.exp_r > 0) return `<span style="color:var(--amber)">บวกแต่ไม่นิ่ง</span>`;
    return `<span class="neg">ไม่มี edge</span>`;
  };
  $("#opTable").innerHTML = table([
    { h: "กลยุทธ์", f: (x) => `<b>${x.code}</b> <span class="muted">${esc(x.name)}</span>` },
    { h: "ค่าปัจจุบัน OOS (R/ไม้)", n: 1, f: (x) => fmtR(x.current_oos.exp_r), cls: (x) => cls(x.current_oos.exp_r) },
    { h: "ไม้", n: 1, f: (x) => x.current_oos.trades },
    { h: "PF", n: 1, f: (x) => x.current_oos.pf ?? "—" },
    { h: "ช่วงที่กำไร", n: 1, f: (x) => `${x.current_windows_positive}/${x.n_windows}` },
    { h: "WF-จูน OOS", n: 1, f: (x) => fmtR(x.wf_oos.exp_r), cls: (x) => cls(x.wf_oos.exp_r) },
    { h: "ค่าเสนอ (ข้อมูลเก่าที่ไม่เคยเห็น)", n: 1, f: (x) => Object.keys(x.changed).length ? `${fmtR(x.proposed_older_oos.exp_r)} <span class="muted">(${x.proposed_older_oos.trades})</span>` : "ไม่เปลี่ยน", cls: (x) => cls(x.proposed_older_oos.exp_r) },
    { h: "ความนิ่ง", n: 1, f: (x) => x.stability_pct + "%" },
    { h: "ผลจริง (Journal)", n: 1, f: (x) => x.live.trades ? `${signed(x.live.net)} <span class="muted">(${x.live.trades})</span>` : "—", cls: (x) => cls(x.live.net) },
    { h: "สรุป", f: verdict },
  ], rows);
}
function renderHistory(h) {
  $("#opHist").innerHTML = table([
    { h: "เวลา", f: (x) => new Date(x.time * 1000).toLocaleString() },
    { h: "รายการ", f: (x) => esc(x.title) + (x.rolled_back ? ' <span class="tag">ย้อนกลับแล้ว</span>' : "") },
    { h: "", f: (x) => x.rolled_back ? "" : `<button class="btn sm" data-rollback="${x.id}">ย้อนกลับ</button>` },
  ], h, "ยังไม่มีการปรับ");
}
$("#opRun").addEventListener("click", async () => {
  try {
    await api("optimize/run", { method: "POST", body: { tf: $("#opTf").value, bars: +$("#opBars").value, max_combos: +$("#opCombos").value, cost: $("#opCost").value } });
    toast("เริ่ม Optimizer แล้ว"); loadOptimizer();
  } catch (e) { toast(e.message); }
});
$("#opApply").addEventListener("click", (e) => {
  const ids = $$("[data-rec]").filter((c) => c.checked).map((c) => c.dataset.rec);
  if (!ids.length) return toast("ยังไม่ได้เลือกรายการ");
  confirmClick(e.currentTarget, `ยืนยัน Apply ${ids.length} รายการ`, async () => {
    try {
      const r = await api("optimize/apply", { method: "POST", body: { ids } });
      $("#opMsg").innerHTML = `<span class="ok">ปรับแล้ว ${r.applied.length} รายการ – Scanner จะใช้ค่าใหม่ในรอบถัดไป</span>`;
      loadOptimizer(); runBacktest();
    } catch (err) { toast(err.message); }
  });
});
document.addEventListener("click", (e) => {
  const rb = e.target.closest("[data-rollback]"), ps = e.target.closest("[data-preset]");
  if (rb) confirmClick(rb, "ยืนยัน?", async () => { try { await api("optimize/rollback", { method: "POST", body: { id: rb.dataset.rollback } }); toast("ย้อนกลับแล้ว"); loadOptimizer(); } catch (err) { toast(err.message); } });
  if (ps) confirmClick(ps, "ยืนยัน?", async () => { await api(`strategy_params/${ps.dataset.preset}/reset`, { method: "POST" }); toast("คืนค่าเริ่มต้นแล้ว"); loadOptimizer(); });
});


/* ---------------- TRADE MANAGER & GIVE-BACK ---------------- */
async function loadTM() {
  const d = await api("trade_manager"); const c = d.config;
  $("#tmEnabled").checked = c.enabled; $("#tmBe").checked = c.be_enabled; $("#tmBeTrig").value = c.be_trigger_atr; $("#tmBeLock").value = c.be_lock;
  $("#tmTrail").checked = c.trail_enabled; $("#tmTrStart").value = c.trail_start_atr; $("#tmTrDist").value = c.trail_dist_atr;
  $("#tmPartial").checked = c.partial_enabled; $("#tmPtAtr").value = c.partial_atr; $("#tmPtPct").value = c.partial_pct; $("#tmTf").value = c.atr_tf;
  $("#tmSources").innerHTML = d.sources.map((s) => `<label class="switch"><input type="checkbox" data-tms="${esc(s)}" ${c.sources.includes(s) ? "checked" : ""}>${esc(s)}</label>`).join("");
}
$("#tmSave").addEventListener("click", async () => {
  const n = (id) => parseFloat($(id).value) || 0;
  const body = { enabled: $("#tmEnabled").checked, be_enabled: $("#tmBe").checked, be_trigger_atr: n("#tmBeTrig"), be_lock: n("#tmBeLock"),
    trail_enabled: $("#tmTrail").checked, trail_start_atr: n("#tmTrStart"), trail_dist_atr: n("#tmTrDist"),
    partial_enabled: $("#tmPartial").checked, partial_atr: n("#tmPtAtr"), partial_pct: Math.min(90, Math.max(10, n("#tmPtPct"))), atr_tf: $("#tmTf").value,
    sources: $$("[data-tms]").filter((c) => c.checked).map((c) => c.dataset.tms) };
  if (body.trail_enabled && body.trail_dist_atr <= 0) return toast("ระยะ Trailing ต้องมากกว่า 0");
  await api("trade_manager", { method: "POST", body }); $("#tmMsg").innerHTML = `<span class="ok">บันทึกแล้ว</span>`;
});
async function runGiveBack() {
  $("#gbWhatif").innerHTML = `<div class="empty">กำลังไล่ราคา M1…</div>`;
  const q = new URLSearchParams({ days: $("#gbDays").value }); if ($("#gbSource").value) q.set("source", $("#gbSource").value);
  const d = await api("giveback?" + q);
  if (!d.trades && !d.summary) { $("#gbWhatif").innerHTML = `<div class="empty">${esc(d.error || "ไม่มีออเดอร์ที่ปิดแล้วในช่วงนี้")}</div>`; $("#gbSummary").innerHTML = ""; $("#gbRed").innerHTML = ""; return; }
  const cur = $("#gbSource").value;
  $("#gbSource").innerHTML = `<option value="">ทุกที่มา</option>` + (S.gbSources = cur ? (S.gbSources || d.sources) : d.sources).map((s) => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("");
  const s = d.summary;
  const k = (l, v, sub = "", c = "") => `<div class="card kpi"><div class="label">${l}</div><div class="value ${c}">${v}</div><div class="sub">${sub}</div></div>`;
  $("#gbSummary").innerHTML = k("ออเดอร์ที่วิเคราะห์", s.trades, `Net จริง ${signed(s.actual_net)}`) +
    k("กำไรสูงสุดเฉลี่ย (MFE)", "$" + money(s.avg_mfe), `${s.avg_mfe_atr} ATR`) + k("ติดลบสูงสุดเฉลี่ย (MAE)", "$" + money(s.avg_mae)) +
    k("เก็บกำไรได้จริง", s.capture_pct !== null ? s.capture_pct + "%" : "—", "ของ MFE โดยเฉลี่ย", cls((s.capture_pct ?? 0) - 40)) +
    k("กำไรที่คืนตลาดรวม", "$" + money(s.given_back_money), "MFE − กำไรที่ได้จริง", "neg") +
    k("เคยกำไร ≥1 ATR แต่จบขาดทุน", s.red_after_green, `เสียรวม ${money(s.red_after_green_money)}`, s.red_after_green ? "neg" : "");
  $("#gbWhatif").innerHTML = table([
    { h: "ชุดการตั้งค่า", f: (w) => `${esc(w.label)}${w.key === d.best ? ' <span class="tag buy">ดีที่สุด</span>' : ""}` },
    { h: "Net จำลอง", n: 1, f: (w) => signed(w.net), cls: (w) => cls(w.net) },
    { h: "ต่างจากจริง", n: 1, f: (w) => signed(w.delta), cls: (w) => cls(w.delta) },
    { h: "Win Rate", n: 1, f: (w) => w.win_rate + "%" },
    { h: "ถูกปิดก่อนด้วย SL ที่เลื่อน", n: 1, f: (w) => w.stopped_early },
    { h: "", f: (w) => w.key === "current" ? `<span class="muted">ใช้อยู่</span>` : `<button class="btn sm" data-tmpreset="${w.key}">ใช้ชุดนี้</button>` },
  ], [{ key: "actual", label: "ผลจริง (ไม่มี BE/Trailing เพิ่ม)", net: s.actual_net, delta: 0, win_rate: "—", stopped_early: 0 }, ...d.whatif]
    .map((w) => w.key === "actual" ? { ...w, _a: 1 } : w)).replace(/<button class="btn sm" data-tmpreset="actual">ใช้ชุดนี้<\/button>/, "");
  $("#gbRed").innerHTML = table([
    { h: "เปิด", f: (x) => ftime(x.open_time) }, { h: "ฝั่ง", f: (x) => sideTag(x.side) }, { h: "ที่มา", f: (x) => esc(x.source) },
    { h: "เคยกำไรสูงสุด", n: 1, f: (x) => `$${money(x.mfe)} <span class="muted">(${x.mfe_atr} ATR ≈ ${money(x.mfe_money)})</span>` },
    { h: "ปิดจริง", n: 1, f: (x) => signed(x.profit), cls: (x) => cls(x.profit) },
  ], d.red_after_green, "ไม่มี");
}
$("#gbRun").addEventListener("click", () => runGiveBack().catch((e) => toast(e.message)));
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tmpreset]");
  if (b) confirmClick(b, "ยืนยัน?", async () => {
    await api("trade_manager/preset", { method: "POST", body: { key: b.dataset.tmpreset } });
    toast("ตั้งค่า Trade Manager ตามชุดนี้แล้ว (ดู/ปรับต่อได้ที่หน้า Risk & Settings)"); runGiveBack();
  });
});


/* ---------------- DIAGNOSTICS ---------------- */
async function loadDiag() {
  const d = await api("diagnostics");
  const bad = d.checks.filter((c) => !c.ok);
  $("#diagSum").innerHTML = d.ready ? `<span class="pos">✓ พร้อมออกไม้อัตโนมัติ – รอสัญญาณใหม่จาก Scanner (เห็นสัญญาณแล้ว ${d.signals_seen} ครั้งในรอบนี้)</span>`
    : `<span class="neg">มี ${bad.length} ข้อที่ทำให้ไม่ออกไม้</span>` + (d.scan_error ? ` · Scanner error: ${esc(d.scan_error)}` : "");
  $("#diagChecks").innerHTML = d.checks.map((c) => `<div class="chk ${c.ok ? "ok" : "bad"}"><span class="i">${c.ok ? "✓" : "✗"}</span>
    <div><b>${esc(c.name)}</b> <span class="muted">${esc(c.detail)}</span>${c.ok ? "" : `<div class="fix">→ ${esc(c.fix)}</div>`}</div></div>`).join("");
  const R = { sent: '<span class="pos">ส่งแล้ว</span>', blocked: '<span class="neg">ถูกบล็อก</span>', rejected: '<span class="neg">MT5 ปฏิเสธ</span>', skip: '<span class="muted">ข้าม</span>' };
  $("#diagLog").innerHTML = table([
    { h: "เวลา", f: (x) => new Date(x.time * 1000).toLocaleTimeString() }, { h: "สัญญาณ", f: (x) => `${esc(x.strategy)} ${sideTag(x.side)}` },
    { h: "ผล", f: (x) => R[x.result] || esc(x.result) }, { h: "รายละเอียด", f: (x) => `<span style="white-space:normal">${esc(x.detail)}</span>` },
  ], d.auto_log, "ยังไม่มีสัญญาณใหม่ตั้งแต่เปิดโปรแกรม (Scanner ดูเฉพาะ 2 แท่งล่าสุดที่ปิดแล้ว)");
}
async function refreshAutoBadge() {
  try {
    const st = await api("settings"); const sc = st.scanner;
    const on = (sc.enabled && sc.auto_trade && Object.values(sc.auto_trade_strategies).some(Boolean)) || sc.ai_auto;
    try {
      const rg = await api("regime");
      const rb = $("#regBadge"); rb.textContent = "ตลาด: " + rg.label; rb.title = rg.advice || "";
      rb.className = "badge " + (rg.regime && rg.regime.startsWith("TREND") ? "live" : rg.regime === "RANGE" ? "demo" : "off");
    } catch (e) {}
    const b = $("#autoBadge"); b.className = "badge " + (on ? "live" : "off"); b.textContent = on ? "AUTO ON" : "AUTO OFF";
  } catch (e) {}
}
$("#autoBadge").addEventListener("click", () => go("risk"));
$("#diagRefresh").addEventListener("click", () => loadDiag());
$("#diagEnable").addEventListener("click", async (e) => {
  // on a REAL account the server asks for a second click to confirm
  const btn = e.currentTarget, live = btn.dataset.live === "1";
  if (!btn.dataset.orig) btn.dataset.orig = btn.textContent;
  try {
    await api("autotrade/enable_all", { method: "POST", body: live ? { confirm_live: true } : {} });
    delete btn.dataset.live; btn.textContent = btn.dataset.orig;
    toast("เปิด Auto-Trade ทุกกลยุทธ์แล้ว"); loadDiag(); loadRisk(); refreshAutoBadge();
  } catch (err) {
    if (!live && /บัญชีจริง/.test(err.message)) {
      btn.dataset.live = "1"; btn.textContent = "⚠ ยืนยัน: เปิด Auto-Trade ด้วยเงินจริง"; toast(err.message, 5000);
      setTimeout(() => { delete btn.dataset.live; btn.textContent = btn.dataset.orig; }, 8000);
    } else toast("ผิดพลาด: " + err.message, 5000);
  }
});
$("#diagTest").addEventListener("click", (e) => confirmClick(e.currentTarget, "ยืนยันส่ง BUY 0.01?", async () => {
  try {
    const r = await api("diagnostics/test_order", { method: "POST" });
    toast(r.open.ok ? (r.mode === "live" ? `✓ ส่งออเดอร์เข้า MT5 ได้ (#${r.open.order}) และปิดแล้ว – การเชื่อมต่อ MT5 ปกติ` : `⚠ ส่งได้แต่เป็นโหมดจำลอง (DEMO SIMULATOR) – ออเดอร์ไม่ได้เข้า MT5 จริง`) : `✗ MT5 ตอบกลับ ${r.open.retcode}: ${r.open.message}`, 6000);
  } catch (err) { toast("✗ " + err.message, 6000); }
  loadDiag();
}));


/* ---------------- NEWS ---------------- */
const lt = (utc) => new Date(utc * 1000).toLocaleString("th-TH", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
async function loadNews(refresh = false) {
  const d = await api("news" + (refresh ? "?refresh=true" : ""));
  const c = d.config; S.news = d;
  $("#newsInfo").innerHTML = `เวลาในตาราง = เวลาเครื่องคุณ (และเวลา Server) · อัปเดตล่าสุด ${d.fetched_at ? new Date(d.fetched_at * 1000).toLocaleTimeString() : "-"}` + (d.error ? ` · <span class="neg">${esc(d.error)}</span>` : "");
  const biasHtml = d.bias ? `<div class="banner show" style="color:var(--text)">📰 ผลข่าวล่าสุดต่อทอง: <b class="${d.bias.bias === "BUY" ? "pos" : d.bias.bias === "SELL" ? "neg" : ""}">${d.bias.bias === "BUY" ? "หนุนทองขึ้น" : d.bias.bias === "SELL" ? "กดทองลง" : "ผสม"}</b> · ${d.bias.events.map(esc).join(" | ")}</div>` : "";
  $("#newsBlock").innerHTML = biasHtml + (d.blackout ? `<div class="banner red show">⏸ ${esc(d.blackout)} – Auto-Trade/AI พักชั่วคราว</div>`
    : d.next_block ? `<div class="muted" style="font-size:13px">ข่าวแรงถัดไป: <b>${esc(d.next_block.currency)} ${esc(d.next_block.title)}</b> ${lt(d.next_block.time_utc)} (อีก ${d.next_block.minutes_until} นาที) – ${c.block_auto ? `จะพัก Auto ${c.block_before_min} นาทีก่อน ถึง ${c.block_after_min} นาทีหลัง` : "เทรดช่วงข่าวได้ (AI ใช้ผลข่าวช่วยตัดสิน)"}</div>` : "");
  const now = Date.now() / 1000;
  const rows = d.events.filter((e) => c.currencies.includes(e.currency));
  $("#newsTable").innerHTML = rows.length ? `<table><thead><tr><th>เวลา (ไทย)</th><th>Server</th><th>สกุล</th><th>ระดับ</th><th>ข่าว</th><th class="n">คาด</th><th class="n">ก่อน</th><th class="n">จริง</th><th>อ่านผล → ทอง</th></tr></thead><tbody>${rows.map((e) =>
    `<tr class="${e.time_utc < now ? "past" : e.minutes_until <= 60 ? "soon" : ""}"><td>${lt(e.time_utc)}</td><td class="mono">${ftime(e.time_server, false)}</td><td>${esc(e.currency)}</td><td><span class="imp ${esc(e.impact)}">${esc(e.impact)}</span></td><td style="white-space:normal">${esc(e.title)}</td><td class="n">${esc(e.forecast)}</td><td class="n">${esc(e.previous)}</td><td class="n">${esc(e.actual || "")}</td><td>${e.reading ? `<span class="${e.reading.gold_bias === "BUY" ? "pos" : e.reading.gold_bias === "SELL" ? "neg" : "muted"}">${esc(e.reading.usd)} · ${esc(e.reading.gold)}</span>` : ""}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty">${d.error ? "ดึงปฏิทินไม่สำเร็จ" : "ไม่มีข่าวในสัปดาห์นี้ตามสกุลที่เลือก"}</div>`;
  $("#newsHead").innerHTML = d.headlines.length ? d.headlines.map((x) => `<div><span class="muted mono">${x.time_utc ? new Date(x.time_utc * 1000).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : ""}</span> ${x.link ? `<a href="${safeUrl(x.link)}" target="_blank" rel="noopener noreferrer" style="color:var(--text)">${esc(x.title)}</a>` : esc(x.title)}</div>`).join("")
    : `<div class="empty">${esc(d.headline_error || "ยังไม่มีพาดหัว")}</div>`;
  $("#nwCur").value = c.currencies.join(","); $("#nwBefore").value = c.block_before_min; $("#nwAfter").value = c.block_after_min;
  $("#nwHigh").checked = c.block_impacts.includes("High"); $("#nwMed").checked = c.block_impacts.includes("Medium");
  $("#nwAuto").checked = c.block_auto; $("#nwManual").checked = c.block_manual;
}
$("#newsRefresh").addEventListener("click", () => { toast("กำลังดึงข่าว…"); loadNews(true).catch((e) => toast(e.message)); });
$("#nwSave").addEventListener("click", async () => {
  const imp = []; if ($("#nwHigh").checked) imp.push("High"); if ($("#nwMed").checked) imp.push("Medium");
  const cur = $("#nwCur").value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  await api("news/config", { method: "POST", body: { currencies: cur.length ? cur : ["USD"], block_impacts: imp,
    impacts: [...new Set(["High", "Medium", ...imp])], block_before_min: +$("#nwBefore").value || 0, block_after_min: +$("#nwAfter").value || 0,
    block_auto: $("#nwAuto").checked, block_manual: $("#nwManual").checked } });
  toast("บันทึกการตั้งค่าข่าวแล้ว"); loadNews();
});

/* ---------------- RISK & SETTINGS ---------------- */
const RF = { rDefLot: "default_lot", rMaxLot: "max_lot", rRisk: "risk_per_trade_pct", rDayPct: "max_daily_loss_pct", rDayMoney: "max_daily_loss_money", rMaxOrders: "max_orders_per_day", rMaxPos: "max_open_positions", rSameSide: "max_same_side", rSameCool: "same_side_cooldown_min", rLaneMax: "lane_max_positions", rLaneCool: "lane_cooldown_min", rLaneOrders: "lane_max_orders_day", rLaneLoss: "lane_max_daily_loss_pct", rTotRisk: "max_total_open_risk_pct", rSpread: "max_spread" };
async function loadSymbols() {
  const d = await api("symbols");
  const names = Object.keys(d.symbols);
  if (!names.length) { $("#symBox").innerHTML = `<div class="muted">ยังไม่มี – พิมพ์ชื่อแล้วกด "เพิ่ม"</div>`; return; }
  const sel = (n, k, m) => `<select data-sym="${esc(n)}" data-code="${esc(k)}">${["off", "shadow", "live"].map((x) => `<option value="${x}" ${x === m ? "selected" : ""}>${{ off: "ปิด", shadow: "Shadow", live: "Live" }[x]}</option>`).join("")}</select>`;
  $("#symBox").innerHTML = names.map((n) => {
    const c = d.symbols[n], t = c.tick;
    return `<div class="calc" style="margin-bottom:8px"><div><label class="switch" style="margin:0"><input type="checkbox" data-sym-en="${esc(n)}" ${c.enabled ? "checked" : ""}><b>${esc(n)}</b></label>
      <span class="muted" style="font-size:12px">${c.broker_symbol ? "โบรก: " + esc(c.broker_symbol) : "<span class='neg'>โบรกไม่มี Symbol นี้</span>"}${t ? ` · ราคา ${money(t.bid)} · spread ${money(t.spread)}` : ""}${c.contract_size ? ` · 1 lot = ${esc(c.contract_size)}` : ""}${c.scan && c.scan.error ? ` · <span class="neg">${esc(c.scan.error)}</span>` : c.scan && c.scan.last_scan ? ` · สแกนล่าสุด ${new Date(c.scan.last_scan * 1000).toLocaleTimeString()}` : ""}</span></div>
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:6px">${Object.entries(c.modes).map(([k, m]) => `<div style="min-width:120px"><label>${esc(k)}</label>${sel(n, k, m)}</div>`).join("")}
        <div style="max-width:120px"><label>Spread สูงสุด</label><input type="number" step="0.5" data-sym-spr="${esc(n)}" value="${esc(c.max_spread)}"></div>
        <div style="max-width:140px"><label>ความเสี่ยงเปิดอยู่สูงสุด %</label><input type="number" step="0.5" data-sym-risk="${esc(n)}" value="${esc(c.max_risk_pct)}"></div>
        <div class="actions"><button class="btn sm primary" data-sym-save="${esc(n)}">บันทึก ${esc(n)}</button></div></div></div>`;
  }).join("");
}
async function saveSymbol(n, extra = {}) {
  const modes = {}; $$(`[data-sym="${n}"]`).forEach((s) => (modes[s.dataset.code] = s.value));
  const body = { enabled: $(`[data-sym-en="${n}"]`) ? $(`[data-sym-en="${n}"]`).checked : true, modes,
    max_spread: +($(`[data-sym-spr="${n}"]`) || {}).value || 30, max_risk_pct: +($(`[data-sym-risk="${n}"]`) || {}).value || 6, ...extra };
  try { await api("symbols/" + encodeURIComponent(n), { method: "POST", body }); toast(`บันทึก ${n} แล้ว`); loadSymbols(); }
  catch (err) {
    if (/ยืนยัน/.test(err.message) && !extra.confirm_live) { toast(err.message + " – กดบันทึกอีกครั้งภายใน 8 วินาที", 6000); S.symConfirm = n; setTimeout(() => (S.symConfirm = null), 8000); }
    else toast("ผิดพลาด: " + err.message, 5000);
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sym-save]"); if (!b) return;
  const n = b.dataset.symSave; saveSymbol(n, S.symConfirm === n ? { confirm_live: true } : {});
});
$("#symAdd").addEventListener("click", async () => {
  const n = $("#symNew").value.trim().toUpperCase(); if (!n) return;
  try { await api("symbols/" + encodeURIComponent(n), { method: "POST", body: { enabled: true } }); $("#symNew").value = ""; toast(`เพิ่ม ${n} (ทุกเลนเป็น Shadow)`); loadSymbols(); }
  catch (err) { toast("ผิดพลาด: " + err.message, 5000); }
});
async function loadRisk(full = true) {
  loadSymbols().catch(() => {});
  const [r, st] = await Promise.all([api("risk"), api("settings")]);
  if (full) loadTM().catch(() => {});
  loadDiag().catch(() => {});
  const c = r.config, t = r.today;
  Object.entries(RF).forEach(([id, k]) => ($("#" + id).value = c[k]));
  $("#rLotMode").value = c.lot_mode || "risk";
  $("#rAutoRel").checked = c.auto_release_new_day !== false;
  $("#rReqSl").checked = c.require_sl; $("#rAutoKill").checked = c.auto_kill_on_daily_loss;
  $("#killBig").classList.toggle("on", c.kill_switch); $("#killBig").textContent = c.kill_switch ? "RESUME" : "STOP";
  $("#killState").innerHTML = c.kill_switch ? `<b class="neg">หยุดระบบอยู่</b> – ${esc(c.kill_switch_reason)}<br>${new Date(c.kill_switch_time * 1000).toLocaleString()}` + (c.kill_switch_auto && c.auto_release_new_day !== false ? `<br><span style="font-size:12px">ปลดล็อกอัตโนมัติเมื่อขึ้นวันใหม่ (เวลา Server)</span>` : `<br><span style="font-size:12px">ต้องกด RESUME เพื่อปลดล็อก</span>`) : "ระบบทำงานปกติ";
  const li = (l, v, x = "") => `<div class="calc" style="margin:0 0 6px"><div><span class="muted">${l}</span><span class="num ${x}">${v}</span></div></div>`;
  $("#riskToday").innerHTML = li("Balance ต้นวัน", money(t.day_start_balance)) + li("P/L วันนี้ (ปิด + ลอย)", signed(t.day_pl), cls(t.day_pl)) +
    li("ลิมิตขาดทุนวันนี้", t.loss_limit ? "-" + money(t.loss_limit) : "ไม่จำกัด") +
    `<div class="prog risk"><i style="width:${Math.min(100, t.loss_used_pct)}%"></i></div><div class="muted" style="font-size:12px;margin-bottom:8px">ใช้ไป ${t.loss_used_pct}%</div>` +
    li("ออเดอร์วันนี้", `${t.orders_today} / ${c.max_orders_per_day || "∞"}`) + li("Position เปิดอยู่", `${t.open_positions} / ${c.max_open_positions || "∞"}`);
  $("#events").innerHTML = r.events.length ? r.events.map((e) => `<div class="${e.level}"><span class="muted mono">${new Date(e.time * 1000).toLocaleTimeString()}</span> ${esc(e.msg)}</div>`).join("") : `<div class="empty">ยังไม่มีเหตุการณ์</div>`;
  // scanner
  const sc = st.scanner;
  $("#scEnabled").checked = sc.enabled; $("#scRegime").checked = sc.regime_filter !== false; $("#scInt").value = sc.interval_sec; $("#scAuto").checked = sc.auto_trade;
  $("#scTable").innerHTML = Object.entries(st.strategies).map(([k, n]) => `<tr><td><b>${k}</b> <span class="muted">${n}</span></td>
    <td><input type="checkbox" data-sc="${k}" ${sc.strategies[k] ? "checked" : ""}></td><td><input type="checkbox" data-at="${k}" ${sc.auto_trade_strategies[k] ? "checked" : ""}></td></tr>`).join("");
  // ea map
  $("#eaTable").innerHTML = Object.entries(st.ea_map).map(([m, n]) => eaRow(m, n)).join("");
  // settings
  const s = st.settings;
  $("#stSym").value = s.symbol; $("#stTf").value = s.timeframe; $("#stGd").value = s.goals.daily; $("#stGw").value = s.goals.weekly; $("#stGm").value = s.goals.monthly;
  $("#stMagic").value = s.dashboard_magic; $("#stAs").value = s.asian_session.start_hour; $("#stAe").value = s.asian_session.end_hour;
  $("#stProv").value = s.ai.provider || "anthropic"; showKey("#stOKey", s.ai.openai_api_key, "sk-..."); $("#stOModel").value = s.ai.openai_model || "gpt-6.1-sol";
  showKey("#stKey", s.ai.anthropic_api_key, "sk-ant-..."); $("#stModel").value = s.ai.model; $("#stWs").value = s.ai.anthropic_workspace_id || ""; $("#stNews").value = s.ai.news_note || "";
  $("#oStrat").innerHTML = `<option value="MANUAL">Manual</option>` + Object.entries(st.strategies).map(([k, n]) => `<option value="${k}">${n}</option>`).join("");
}
// a saved key is never shown or re-sent: the field stays empty (empty = keep the saved key)
function showKey(sel, masked, ph) {
  const el = $(sel); el.value = "";
  el.placeholder = masked ? "✓ บันทึกไว้แล้ว – เว้นว่างไว้ = ใช้ Key เดิม" : ph;
  const btn = document.querySelector(`[data-clear-key="${sel === "#stKey" ? "anthropic_api_key" : "openai_api_key"}"]`);
  if (btn) btn.style.display = masked ? "" : "none";
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-clear-key]"); if (!b) return;
  confirmClick(b, "ยืนยันลบ?", async () => {
    try { await api("settings", { method: "POST", body: { clear_keys: [b.dataset.clearKey] } }); toast("ลบ Key แล้ว"); loadRisk(); }
    catch (err) { toast("ผิดพลาด: " + err.message, 5000); }
  });
});
const eaRow = (m = "", n = "") => `<tr><td><input class="ea-m" value="${esc(m)}" style="width:110px"></td><td><input class="ea-n" value="${esc(n)}"></td><td><button class="btn sm" onclick="this.closest('tr').remove()">ลบ</button></td></tr>`;
$("#eaAdd").addEventListener("click", () => $("#eaTable").insertAdjacentHTML("beforeend", eaRow()));
$("#eaSave").addEventListener("click", async () => {
  const map = {}; $$("#eaTable tr").forEach((tr) => { const m = tr.querySelector(".ea-m").value.trim(), n = tr.querySelector(".ea-n").value.trim(); if (m !== "" && n) map[m] = n; });
  await api("settings", { method: "POST", body: { ea_map: map } }); $("#eaMsg").innerHTML = `<span class="ok">บันทึกแล้ว</span>`;
});
$("#killBig").addEventListener("click", (e) => toggleKill(e.currentTarget));
$("#rSave").addEventListener("click", async () => {
  const body = { auto_release_new_day: $("#rAutoRel").checked, lot_mode: $("#rLotMode").value, require_sl: $("#rReqSl").checked, auto_kill_on_daily_loss: $("#rAutoKill").checked };
  Object.entries(RF).forEach(([id, k]) => (body[k] = parseFloat($("#" + id).value) || 0));
  await api("risk", { method: "POST", body }); $("#rMsg").innerHTML = `<span class="ok">บันทึกแล้ว</span>`; loadRisk();
});
$("#scSave").addEventListener("click", async () => {
  const strategies = {}, auto = {};
  $$("[data-sc]").forEach((c) => (strategies[c.dataset.sc] = c.checked)); $$("[data-at]").forEach((c) => (auto[c.dataset.at] = c.checked));
  await api("settings", { method: "POST", body: { scanner: { regime_filter: $("#scRegime").checked, enabled: $("#scEnabled").checked, interval_sec: Math.max(5, +$("#scInt").value || 30), auto_trade: $("#scAuto").checked, strategies, auto_trade_strategies: auto } } });
  $("#scMsg").innerHTML = `<span class="ok">บันทึกแล้ว</span>`; refreshAutoBadge(); loadDiag();
  if ($("#scAuto").checked) toast("⚠ Auto-Trade เปิดอยู่ – แนะนำทดสอบบนบัญชี Demo ก่อน", 5000);
});
$("#stSave").addEventListener("click", async () => {
  await api("settings", { method: "POST", body: { settings: {
    symbol: $("#stSym").value.trim(), timeframe: $("#stTf").value, dashboard_magic: +$("#stMagic").value,
    goals: { daily: +$("#stGd").value, weekly: +$("#stGw").value, monthly: +$("#stGm").value },
    asian_session: { start_hour: +$("#stAs").value, end_hour: +$("#stAe").value },
    ai: { provider: $("#stProv").value, openai_api_key: $("#stOKey").value, openai_model: $("#stOModel").value.trim(),
      anthropic_api_key: $("#stKey").value, anthropic_workspace_id: $("#stWs").value.trim(), model: $("#stModel").value.trim(), news_note: $("#stNews").value.trim() } } } });
  $("#stMsg").innerHTML = `<span class="ok">บันทึกแล้ว</span>`; refreshHeader();
});

$("#stTest").addEventListener("click", async () => {
  $("#stTestOut").innerHTML = `<div class="muted">กำลังทดสอบ… (กดบันทึกก่อน ถ้าเพิ่งใส่ Key)</div>`;
  try {
    const r = await api("ai/test", { method: "POST" });
    $("#stTestOut").innerHTML = `<div class="muted" style="font-size:12px">ผู้ให้บริการ: ${r.provider === "openai" ? "ChatGPT (OpenAI)" : "Claude (Anthropic)"}</div>` +
      r.steps.map((s) => `<div class="chk ${s.ok ? "ok" : "bad"}"><span class="i">${s.ok ? "✓" : "✗"}</span><div><b>${esc(s.name)}</b> <span class="muted">${esc(s.detail)}</span></div></div>`).join("");
  } catch (e) { $("#stTestOut").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
});

/* ---------------- loops ---------------- */
async function boot() {
  await refreshHeader();
  try { await loadRisk(); } catch (e) {}  // fills strategy dropdowns etc.
  go("dash");
  setInterval(refreshHeader, 2000);
  refreshAutoBadge(); setInterval(refreshAutoBadge, 10000);
  setInterval(() => {
    if (document.hidden) return;
    if (S.page === "dash") loadDashLive();
    if (S.page === "term") { tickChart().catch(() => {}); loadTrading().catch(() => {}); }
  }, 3000);
  setInterval(() => {
    if (document.hidden) return;
    if (S.page === "term") loadChart(false).catch(() => {});
    if (S.page === "ai") loadSignals().catch(() => {});
    const editing = document.activeElement && document.activeElement.matches("#page-risk input, #page-risk select");
    if (S.page === "risk" && !editing) loadRisk(false).catch(() => {});
  }, 30000);
}
boot();
