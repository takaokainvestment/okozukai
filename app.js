const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbzhW-fIs8mFCym2o3WcoEGkiVbbJl2_6PbMhhmWKsXcdQ5aB-HPE19QNxM2ctFGaOt_/exec";

// ===== util =====
const el = (id)=>document.getElementById(id);
const fmtYen = (n)=>"¥ " + Math.round(n).toLocaleString("ja-JP");
const fmtDelta = (n)=> (n>=0?"+":"") + Math.round(n).toLocaleString("ja-JP") + "円";
const clamp100 = (v)=> Math.max(0, Math.round(Number(v||0)/100)*100);

// ===== DOM (match your HTML) =====
const totalMoney = el("totalMoney");
const monthDeltaEl = el("monthDelta");
const todayStatusEl = el("todayStatus");
const editLabel = el("editLabel");

const pickDate = el("pickDate");
const goToday = el("goToday");

const lunchHome = el("lunchHome");
const lunchOut = el("lunchOut");
const dinnerHome = el("dinnerHome");
const dinnerOut = el("dinnerOut");

const lunchBonusInput = el("lunchBonusInput");
const dinnerBonusInput = el("dinnerBonusInput");

const prevMonth = el("prevMonth");
const nextMonth = el("nextMonth");
const calTitle = el("calTitle");
const calendar = el("calendar");

// Trend (match your HTML)
const trendCanvas = el("trend");
const rangeButtons = document.querySelectorAll('button[data-range]');

// Settings modal (already in your HTML)
const openSettings = el("openSettings");
const closeSettings = el("closeSettings");
const settingsOverlay = el("settingsOverlay");
const settingsModal = el("settingsModal");
const pinInput = el("pinInput");
const newPinInput = el("newPinInput");
const saveSettingsBtn = el("saveSettings");
const resetPinLocalBtn = el("resetPinLocal");
const settingsStatus = el("settingsStatus");

// ===== state =====
let PIN = localStorage.getItem("okozukai_pin") || "";

let settings = { lunch_bonus: 500, dinner_bonus: 500, timezone: "Asia/Tokyo" };
let today = "";
let ym = "";
let editingDate = "";
let monthCursor = ""; // YYYY-MM
let calData = {};     // date -> { lunch, dinner, total }

// trend
let currentRangeDays = 30;
let seriesDebounceTimer = null;

// ===== API =====
async function apiGet(path, params={}){
  const url = new URL(GAS_WEBAPP_URL);
  url.searchParams.set("path", path);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { method:"GET" });
  return res.json();
}

async function apiSetMeal({date, meal, mode, amount}) {
  const url = new URL(GAS_WEBAPP_URL);
  url.searchParams.set("path", "setMeal");
  url.searchParams.set("pin", PIN);
  url.searchParams.set("date", date);
  url.searchParams.set("meal", meal); // lunch / dinner
  url.searchParams.set("mode", mode); // home / out

  if (amount !== undefined && amount !== null) {
    url.searchParams.set("amount", String(amount));
  }

  // ★ 追加：軽量モード
  url.searchParams.set("lite", "1");

  const res = await fetch(url.toString(), { method: "GET" });
  return res.json();
}

// ===== UI helpers =====
function setActiveBtn_(meal, mode){
  const on = (btn)=>btn && btn.classList.add("active");
  const off = (btn)=>btn && btn.classList.remove("active");

  if (meal==="lunch"){
    off(lunchHome); off(lunchOut);
    on(mode==="home"?lunchHome:lunchOut);
  } else {
    off(dinnerHome); off(dinnerOut);
    on(mode==="home"?dinnerHome:dinnerOut);
  }
}

function updateHeader_(){
  if (editLabel) editLabel.textContent = `今日：${today}（編集中：${editingDate}）`;
}

function highlightActiveCell_(){
  if (!calendar) return;
  calendar.querySelectorAll(".calCell").forEach(c=>{
    c.classList.toggle("active", c.dataset.date === editingDate);
    c.classList.toggle("today", c.dataset.date === today);
  });
}

// 未入力＝null、外食＝0、自炊＝正
function todayStatusText_(){
  const st = calData[today];
  const lunchMissing = !st || st.lunch === null;
  const dinnerMissing = !st || st.dinner === null;

  if (lunchMissing && dinnerMissing) return "昼・夜 未入力";
  if (lunchMissing) return "昼 未入力（夜は入力済み）";
  if (dinnerMissing) return "夜 未入力（昼は入力済み）";
  return "昼・夜 入力済み";
}

function setEditingDate_(d){
  editingDate = d;
  if (pickDate) pickDate.value = d;
  updateHeader_();
  highlightActiveCell_();

  const st = calData[d];
  if (st){
    setActiveBtn_("lunch", (st.lunch !== null && st.lunch > 0) ? "home" : "out");
    setActiveBtn_("dinner", (st.dinner !== null && st.dinner > 0) ? "home" : "out");
  } else {
    setActiveBtn_("lunch", "out");
    setActiveBtn_("dinner", "out");
  }
}

// 1セルだけ更新（全再描画しない）
function updateCalendarCell_(d){
  if (!calendar) return;
  const cell = calendar.querySelector(`.calCell[data-date="${d}"]`);
  if (!cell) return;

  const st = calData[d] || { lunch:null, dinner:null, total:0 };

  const dotL = cell.querySelector(".dot.lunch");
  const dotD = cell.querySelector(".dot.dinner");
  const badge = cell.querySelector(".dayTotal");

  const lunchClass = (st.lunch !== null ? (st.lunch > 0 ? "on" : "off") : "off");
  const dinnerClass = (st.dinner !== null ? (st.dinner > 0 ? "on" : "off") : "off");

  if (dotL) dotL.className = `dot lunch ${lunchClass}`;
  if (dotD) dotD.className = `dot dinner ${dinnerClass}`;

  const total = Number(st.total || 0);
  const sign = total > 0 ? "+" : "";
  if (badge){
    badge.textContent = `${sign}${Math.round(total)}`;
    badge.style.opacity = (total === 0 ? "0.55" : "1");
  }

  highlightActiveCell_();
}

// ===== fetch & render =====
async function refreshSummary_(){
  const s = await apiGet("summary");
  if (!s.ok) throw new Error(s.error || "summary failed");

  today = s.today;
  ym = s.ym;
  settings = s.settings || settings;

  if (totalMoney) totalMoney.textContent = fmtYen(s.total);
  if (monthDeltaEl) monthDeltaEl.textContent = fmtDelta(s.monthDelta);

  if (todayStatusEl) todayStatusEl.textContent = "—";

  // 金額入力の初期値（端末ローカル優先→なければsettings）
  const localLunch = localStorage.getItem("okozukai_lunch_default");
  const localDinner = localStorage.getItem("okozukai_dinner_default");

  if (lunchBonusInput) lunchBonusInput.value = String(clamp100(localLunch ?? settings.lunch_bonus ?? 500));
  if (dinnerBonusInput) dinnerBonusInput.value = String(clamp100(localDinner ?? settings.dinner_bonus ?? 500));

  updateHeader_();
}

async function refreshCalendar_(){
  const res = await apiGet("calendar", { month: monthCursor });
  if (!res.ok) throw new Error(res.error || "calendar failed");
  calData = res.days || {};
  renderCalendar_();

  if (todayStatusEl){
    if (monthCursor === today.slice(0,7)) todayStatusEl.textContent = todayStatusText_();
    else todayStatusEl.textContent = "（今月カレンダー外）";
  }
}

function renderCalendar_(){
  if (!calendar) return;

  calendar.innerHTML = "";
  if (calTitle) calTitle.textContent = monthCursor;

  const [Y,M] = monthCursor.split("-").map(Number);
  const first = new Date(Y, M-1, 1);
  const last = new Date(Y, M, 0);

  const startDow = first.getDay(); // 0=Sun
  const daysInMonth = last.getDate();

  // blank cells
  for (let i=0; i<startDow; i++){
    const blank = document.createElement("div");
    blank.className = "calCell";
    blank.style.visibility = "hidden";
    calendar.appendChild(blank);
  }

  for (let day=1; day<=daysInMonth; day++){
    const d = `${Y}-${String(M).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const cell = document.createElement("div");
    cell.className = "calCell";
    cell.dataset.date = d;

    const num = document.createElement("div");
    num.className = "calDayNum";
    num.textContent = String(day);
    cell.appendChild(num);

    const st = calData[d] || { lunch: null, dinner: null, total: 0 };

    const dotL = document.createElement("div");
    dotL.className = `dot lunch ${st.lunch !== null ? (st.lunch > 0 ? "on" : "off") : "off"}`;
    cell.appendChild(dotL);

    const dotD = document.createElement("div");
    dotD.className = `dot dinner ${st.dinner !== null ? (st.dinner > 0 ? "on" : "off") : "off"}`;
    cell.appendChild(dotD);

    const total = Number(st.total || 0);
    const badge = document.createElement("div");
    badge.className = "dayTotal";
    const sign = total > 0 ? "+" : "";
    badge.textContent = `${sign}${Math.round(total)}`;
    badge.style.opacity = (total === 0 ? "0.55" : "1");
    cell.appendChild(badge);

    cell.addEventListener("click", ()=> setEditingDate_(d));
    calendar.appendChild(cell);
  }

  highlightActiveCell_();
}

// ===== trend =====
function scheduleSeriesRefresh_(days){
  currentRangeDays = days;
  if (seriesDebounceTimer) clearTimeout(seriesDebounceTimer);
  seriesDebounceTimer = setTimeout(()=> {
    refreshSeries_(currentRangeDays).catch(()=>{});
  }, 1500);
}

async function refreshSeries_(days){
  if (!trendCanvas) return;
  const res = await apiGet("series", { days: days === 0 ? 0 : days });
  if (!res.ok) throw new Error(res.error || "series failed");
  drawTrend_(res.series || []);
}

function drawTrend_(series){
  if (!trendCanvas) return;
  const ctx = trendCanvas.getContext("2d");

  const cssW = trendCanvas.clientWidth || 520;
  const cssH = 180;
  const dpr = window.devicePixelRatio || 1;

  trendCanvas.width  = Math.floor(cssW * dpr);
  trendCanvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, cssW, cssH);

  if (!series || series.length < 2){
    ctx.fillStyle = "#6b7280";
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    ctx.fillText("データがまだありません", 12, 28);
    return;
  }

  const vals = series.map(p => Number(p.total || 0));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = (max - min) || 1;

  const padL = 14, padR = 14, padT = 22, padB = 18;
  const x0 = padL, y0 = padT, x1 = cssW - padR, y1 = cssH - padB;

  const yOf = (v) => y1 - (y1 - y0) * ((v - min) / range);
  const xOf = (i, N) => x0 + (x1 - x0) * (N === 1 ? 0 : (i / (N - 1)));

  const lastV = vals[vals.length - 1];
  ctx.fillStyle = "#111827";
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.fillText(`現在: ${Math.round(lastV).toLocaleString("ja-JP")}円`, x0, 14);

  // bottom axis
  ctx.strokeStyle = "rgba(17,24,39,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // guides (max and half)
  const maxV = max;
  const midV = min + range/2;
  ctx.font = "11px system-ui, -apple-system, sans-serif";
  ctx.fillStyle = "rgba(17,24,39,0.65)";
  ctx.strokeStyle = "rgba(17,24,39,0.10)";
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x0, yOf(maxV));
  ctx.lineTo(x1, yOf(maxV));
  ctx.stroke();
  ctx.fillText(`${Math.round(maxV).toLocaleString("ja-JP")}円`, x0, yOf(maxV)-4);

  ctx.beginPath();
  ctx.moveTo(x0, yOf(midV));
  ctx.lineTo(x1, yOf(midV));
  ctx.stroke();
  ctx.fillText(`${Math.round(midV).toLocaleString("ja-JP")}円`, x0, yOf(midV)-4);

  // line
  ctx.strokeStyle = "#2f6f62";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const N = vals.length;
  ctx.beginPath();
  for (let i=0; i<N; i++){
    const x = xOf(i, N);
    const y = yOf(vals[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // marker (last point)
  const xLast = xOf(N-1, N);
  const yLast = yOf(lastV);

  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.arc(xLast, yLast, 5.2, 0, Math.PI*2);
  ctx.fill();

  ctx.fillStyle = "#2f6f62";
  ctx.beginPath();
  ctx.arc(xLast, yLast, 3.6, 0, Math.PI*2);
  ctx.fill();
}

// ===== save (fast) =====
const inFlight = new Set(); // グローバルに1回

async function setMeal_(meal, mode){
  // UIは先に即反映
  setActiveBtn_(meal, mode);
  optimisticApply_(meal, mode); // 後述：カレンダー数字も即反映

  const key = `${editingDate}:${meal}`;
  if (inFlight.has(key)) return;     // 連打は無視（ここが最重要）
  inFlight.add(key);

  try{
    // fetch は裏で。待ち時間はUI止めない
    const amount = (mode==="home")
      ? (meal==="lunch" ? clamp100(lunchBonusInput.value) : clamp100(dinnerBonusInput.value))
      : 0;

    const res = await apiSetMeal({ date: editingDate, meal, mode, amount });
    if (!res.ok) throw new Error(res.error || "save failed");

    // 成功したら、必要ならここで正規値に同期（dayだけでOK）
    if (res.day) {
      calData[editingDate] = res.day;
      updateCalendarCell_(editingDate);
    }

    // summary/seriesは毎回即じゃなく、後でまとめて
    scheduleSummaryRefresh_();
    scheduleSeriesRefresh_(currentRangeDays);

  } catch (e){
    // 失敗時だけ戻す
    revertOptimistic_(meal);
    alert("保存に失敗: " + (e?.message || e));
  } finally {
    inFlight.delete(key);
  }
}

function optimisticApply_(meal, mode){
  const st = calData[editingDate] || { lunch:null, dinner:null, total:0 };
  const prev = { ...st };

  // 復元用に保持（失敗時 revert で使う）
  window.__optimisticPrev = window.__optimisticPrev || {};
  window.__optimisticPrev[`${editingDate}:${meal}`] = prev;

  const amount = (mode==="home")
    ? (meal==="lunch" ? clamp100(lunchBonusInput.value) : clamp100(dinnerBonusInput.value))
    : 0;

  if (meal==="lunch") st.lunch = amount;
  else st.dinner = amount;

  st.total = (typeof st.lunch==="number" ? st.lunch : 0) + (typeof st.dinner==="number" ? st.dinner : 0);
  calData[editingDate] = st;

  updateCalendarCell_(editingDate);

  // 通算表示も“仮で”動かしたいならここで差分加算も可能（後述）
}

function revertOptimistic_(meal){
  const key = `${editingDate}:${meal}`;
  const prev = window.__optimisticPrev?.[key];
  if (!prev) return;
  calData[editingDate] = prev;
  updateCalendarCell_(editingDate);
}

// ===== settings modal (local only) =====
function openSettingsModal_(){
  if (pinInput) pinInput.value = PIN || "";
  if (newPinInput) newPinInput.value = "";
  if (settingsStatus) settingsStatus.textContent = "";
  if (settingsOverlay) settingsOverlay.hidden = false;
  if (settingsModal) settingsModal.hidden = false;
}

function closeSettingsModal_(){
  if (settingsOverlay) settingsOverlay.hidden = true;
  if (settingsModal) settingsModal.hidden = true;
}

function bindSettings_(){
  if (openSettings) openSettings.addEventListener("click", openSettingsModal_);
  if (closeSettings) closeSettings.addEventListener("click", closeSettingsModal_);
  if (settingsOverlay) settingsOverlay.addEventListener("click", closeSettingsModal_);

  if (saveSettingsBtn) saveSettingsBtn.addEventListener("click", ()=>{
    // 現在PIN（端末に保存）
    const p = pinInput ? String(pinInput.value || "") : "";
    PIN = p;
    localStorage.setItem("okozukai_pin", PIN);

    // newPinInput は「将来GAS側で変更機能を付ける用」：今は端末保存のみ
    const np = newPinInput ? String(newPinInput.value || "") : "";
    if (np){
      PIN = np;
      localStorage.setItem("okozukai_pin", PIN);
      if (pinInput) pinInput.value = PIN;
    }

    // 金額の“端末デフォルト”も保存
    if (lunchBonusInput) localStorage.setItem("okozukai_lunch_default", String(clamp100(lunchBonusInput.value)));
    if (dinnerBonusInput) localStorage.setItem("okozukai_dinner_default", String(clamp100(dinnerBonusInput.value)));

    if (settingsStatus) settingsStatus.textContent = "保存しました（この端末のブラウザに保存）";
    setTimeout(closeSettingsModal_, 350);
  });

  if (resetPinLocalBtn) resetPinLocalBtn.addEventListener("click", ()=>{
    localStorage.removeItem("okozukai_pin");
    PIN = "";
    if (settingsStatus) settingsStatus.textContent = "この端末のPINを忘れました";
  });
}

// ===== bind =====
function bind_(){
  if (pickDate) pickDate.addEventListener("change", ()=> setEditingDate_(pickDate.value));

  if (goToday) goToday.addEventListener("click", async ()=> {
    monthCursor = today.slice(0,7);
    await refreshCalendar_();
    setEditingDate_(today);
  });

  if (prevMonth) prevMonth.addEventListener("click", async ()=>{
    const [y,m] = monthCursor.split("-").map(Number);
    const d = new Date(y, m-2, 1);
    monthCursor = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    await refreshCalendar_();
  });

  if (nextMonth) nextMonth.addEventListener("click", async ()=>{
    const [y,m] = monthCursor.split("-").map(Number);
    const d = new Date(y, m, 1);
    monthCursor = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    await refreshCalendar_();
  });

  if (lunchHome) lunchHome.addEventListener("click", ()=> setMeal_("lunch", "home"));
  if (lunchOut)  lunchOut.addEventListener("click", ()=> setMeal_("lunch", "out"));
  if (dinnerHome)dinnerHome.addEventListener("click", ()=> setMeal_("dinner", "home"));
  if (dinnerOut) dinnerOut.addEventListener("click", ()=> setMeal_("dinner", "out"));

  // 金額入力：100円単位に丸め＆「入力したら即保存」したいなら autoSave=true
  const autoSave = true;

  if (lunchBonusInput){
    lunchBonusInput.addEventListener("change", ()=>{
      lunchBonusInput.value = String(clamp100(lunchBonusInput.value));
      localStorage.setItem("okozukai_lunch_default", lunchBonusInput.value);
      if (autoSave) setMeal_("lunch", "home"); // 入力しただけで反映
    });
  }
  if (dinnerBonusInput){
    dinnerBonusInput.addEventListener("change", ()=>{
      dinnerBonusInput.value = String(clamp100(dinnerBonusInput.value));
      localStorage.setItem("okozukai_dinner_default", dinnerBonusInput.value);
      if (autoSave) setMeal_("dinner", "home"); // 入力しただけで反映
    });
  }

  // 範囲ボタン（data-range）
  rangeButtons.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const days = Number(btn.dataset.range);
      currentRangeDays = days;
      scheduleSeriesRefresh_(days);

      // 見た目 active（CSSある前提。なければ無視でOK）
      rangeButtons.forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  bindSettings_();
}

// ===== main =====
async function main(){
  if (!GAS_WEBAPP_URL || GAS_WEBAPP_URL.includes("PASTE_YOUR")) {
    alert("app.js の GAS_WEBAPP_URL をGASの /exec URLに置き換えてください。");
    return;
  }

  // promptは出さない（歯車から変更できる）
  // PIN未設定でもGAS側が許可なら動く
  if (!PIN) PIN = "";

  await refreshSummary_();

  monthCursor = today.slice(0,7);
  editingDate = today;
  if (pickDate) pickDate.value = today;

  bind_();

  // 初回：calendarとseriesを並列で取得
  await Promise.all([
    refreshCalendar_(),
    refreshSeries_(currentRangeDays).catch(()=>{})
  ]);

  setEditingDate_(today);
  if (todayStatusEl && monthCursor === today.slice(0,7)) todayStatusEl.textContent = todayStatusText_();
}

main().catch(e=> alert("起動エラー: " + (e?.message || e)));
