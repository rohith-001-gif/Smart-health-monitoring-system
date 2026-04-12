// ── Auth guard ────────────────────────────────────────────────────────────────
const sessionRaw = localStorage.getItem("patientSession");
const session    = sessionRaw ? JSON.parse(sessionRaw) : null;
if (!session || !session.watchID || !session.email) window.location.href = "login.html";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const portalTitle      = document.getElementById("portalTitle");
const portalInfo       = document.getElementById("portalInfo");
const patientDetailsEl = document.getElementById("patientDetails");
const snapshotCards    = document.getElementById("snapshotCards");
const metricSelect     = document.getElementById("metricSelect");
const lineChart        = document.getElementById("lineChart");
const logoutPatientBtn = document.getElementById("logoutPatientBtn");
const chatLog          = document.getElementById("chatLog");
const chatInput        = document.getElementById("chatInput");
const chatSendBtn      = document.getElementById("chatSendBtn");
const reminderList     = document.getElementById("reminderList");

let portalData = null;

// ── Logout ────────────────────────────────────────────────────────────────────
logoutPatientBtn.addEventListener("click", () => {
  localStorage.removeItem("patientSession");
  window.location.href = "login.html";
});

// ── Metric selector ───────────────────────────────────────────────────────────
metricSelect.addEventListener("change", () => {
  if (portalData) renderChart(portalData.readings || [], metricSelect.value);
});

// ── Chat ──────────────────────────────────────────────────────────────────────
chatSendBtn.addEventListener("click", onSendChat);
chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") onSendChat(); });

// ── Utilities ─────────────────────────────────────────────────────────────────
function valueOrDash(v) {
  return (v === null || v === undefined || v === "") ? "-" : String(v);
}

function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return isNaN(d) ? "-" : d.toLocaleString();
}

function computeAverages(readings) {
  if (!readings.length) return { hr: "0", spo2: "0", steps: 0 };
  const sum = readings.reduce((a, r) => {
    a.hr    += Number(r.hr)    || 0;
    a.spo2  += Number(r.spo2)  || 0;
    a.steps += Number(r.steps) || 0;
    return a;
  }, { hr: 0, spo2: 0, steps: 0 });
  return {
    hr:    (sum.hr    / readings.length).toFixed(1),
    spo2:  (sum.spo2  / readings.length).toFixed(1),
    steps: Math.round(sum.steps / readings.length)
  };
}

function criticalCount(readings) {
  return readings.filter((r) =>
    Number(r.hr) > 120 || Number(r.spo2) < 90 || String(r.status || "").toLowerCase().includes("critical")
  ).length;
}

// ── Render: patient details ───────────────────────────────────────────────────
function renderPatientDetails(profile) {
  const fields = [
    ["Patient Name", profile.name],
    ["Watch ID",     profile.watchID],
    ["Email",        profile.email],
    ["Age",          profile.age],
    ["Condition",    profile.condition],
    ["Phone",        profile.phone]
  ];
  patientDetailsEl.innerHTML = "";
  fields.forEach(([label, value]) => {
    const box = document.createElement("div");
    box.innerHTML = `<label>${label}</label><strong>${valueOrDash(value)}</strong>`;
    patientDetailsEl.appendChild(box);
  });
}

// ── Render: snapshot cards ────────────────────────────────────────────────────
function renderSnapshot(latest, readings) {
  const avg    = computeAverages(readings);
  const cCount = criticalCount(readings);

  const cards = [
    ["Latest HR",       latest ? valueOrDash(latest.hr)    : "-",  latest && Number(latest.hr)   > 120],
    ["Latest SpO₂",    latest ? valueOrDash(latest.spo2)  : "-",  latest && Number(latest.spo2) < 90 ],
    ["Latest Steps",   latest ? valueOrDash(latest.steps) : "-",  false],
    ["Average HR",     avg.hr,                                      false],
    ["Average SpO₂",  avg.spo2,                                    false],
    ["Average Steps",  avg.steps,                                   false],
    ["Critical Entries", cCount,                                    cCount > 0],
    ["Last Updated",   latest ? formatTime(latest.time) : "-",     false]
  ];

  snapshotCards.innerHTML = "";
  cards.forEach(([label, value, bad]) => {
    const card = document.createElement("div");
    card.className = "metric-card";
    card.innerHTML = `<h4>${label}</h4><p class="${bad ? "metric-bad" : ""}">${value}</p>`;
    snapshotCards.appendChild(card);
  });
}

// ── Render: chart (FIX: no hardcoded dasharray) ───────────────────────────────
function renderChart(readings, metric) {
  const last30 = readings.slice(-30);

  if (!last30.length) {
    lineChart.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="15" font-family="Outfit,sans-serif">No data yet</text>`;
    return;
  }

  const values = last30.map((r) => Number(r[metric]) || 0);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }

  const W = 800, H = 280, PAD = 14;

  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * (W - PAD * 2) + PAD;
    const y = (H - PAD * 2) - ((v - min) / (max - min)) * (H - PAD * 2) + PAD;
    return [x.toFixed(1), y.toFixed(1)];
  });

  const pointStr = pts.map(p => p.join(",")).join(" ");

  // Build smooth area fill path
  const areaPath = `M${pts[0][0]},${H} ` + pts.map(p => `L${p[0]},${p[1]}`).join(" ") + ` L${pts[pts.length-1][0]},${H} Z`;

  const colors = {
    hr:    { stroke: "#fb7185", fill: "rgba(251,113,133,0.08)" },
    spo2:  { stroke: "#3b82f6", fill: "rgba(59,130,246,0.08)" },
    steps: { stroke: "#34d399", fill: "rgba(52,211,153,0.08)" }
  };
  const c = colors[metric] || colors.hr;

  // dots
  const dotsHTML = pts.map(([x, y], i) =>
    `<circle cx="${x}" cy="${y}" r="${i === pts.length - 1 ? 5 : 3}" fill="${c.stroke}" opacity="${i === pts.length - 1 ? 1 : 0.4}"/>`
  ).join("");

  lineChart.innerHTML = `
    <defs>
      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${c.stroke}" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="${c.stroke}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#chartGrad)"/>
    <polyline fill="none" stroke="${c.stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${pointStr}"/>
    ${dotsHTML}
    <text x="${PAD}" y="20" fill="#64748b" font-size="11" font-family="Outfit,sans-serif">Min: ${min.toFixed(1)}</text>
    <text x="${PAD}" y="36" fill="#64748b" font-size="11" font-family="Outfit,sans-serif">Max: ${max.toFixed(1)}</text>
  `;
}

// ── Render: reminders ─────────────────────────────────────────────────────────
function renderReminders(reminders) {
  reminderList.innerHTML = "";
  if (!reminders || !reminders.length) {
    reminderList.innerHTML = "<li class='reminder-chip reminder-empty'>No reminders set.</li>";
    return;
  }
  reminders.forEach((item) => {
    const li = document.createElement("li");
    li.className   = "reminder-chip";
    li.textContent = `${item.time || "--:--"} – ${item.medicine_name || "Medicine"} (${item.repeat_days || "-"})`;
    reminderList.appendChild(li);
  });
}

// ── Chat helpers ──────────────────────────────────────────────────────────────
function pushChatMessage(sender, text) {
  const row = document.createElement("div");
  row.className = "chat-msg";
  row.innerHTML = `<strong>${sender}</strong>${text}`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function buildContext() {
  if (!portalData) return "No patient data loaded.";
  const latest = portalData.latest || {};
  const avg    = computeAverages(portalData.readings || []);
  return [
    "Patient: "        + valueOrDash(portalData.profile.name),
    "Age: "            + valueOrDash(portalData.profile.age),
    "Condition: "      + valueOrDash(portalData.profile.condition),
    "Latest HR: "      + valueOrDash(latest.hr),
    "Latest SpO2: "    + valueOrDash(latest.spo2),
    "Latest Steps: "   + valueOrDash(latest.steps),
    "Latest Status: "  + valueOrDash(latest.status),
    "Avg HR: "         + avg.hr,
    "Avg SpO2: "       + avg.spo2,
    "Avg Steps: "      + avg.steps,
    "Critical count: " + criticalCount(portalData.readings || [])
  ].join("\n");
}

function localFallback(q) {
  if (!portalData) return "Data is still loading. Try again in a moment.";
  const latest = portalData.latest || {};
  const lq = q.toLowerCase();
  if (lq.includes("latest") || lq.includes("current")) {
    return `Latest → HR: ${valueOrDash(latest.hr)}, SpO₂: ${valueOrDash(latest.spo2)}, Steps: ${valueOrDash(latest.steps)}.`;
  }
  if (lq.includes("critical") || lq.includes("danger")) {
    return `Critical entries: ${criticalCount(portalData.readings || [])}. Contact your doctor if you feel unwell.`;
  }
  return "I can answer questions about your latest vitals, trends, and when to see a doctor.";
}

async function onSendChat() {
  const text = chatInput.value.trim();
  if (!text) return;

  pushChatMessage("You:", text);
  chatInput.value = "";
  chatSendBtn.disabled = true;

  try {
    const res    = await fetch("/aiChat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ role: "patient", question: text, context: buildContext(), watchID: session.watchID })
    });
    const result = await res.json();
    pushChatMessage("Bot:", result.success && result.answer ? result.answer : localFallback(text));
  } catch {
    pushChatMessage("Bot:", localFallback(text));
  } finally {
    chatSendBtn.disabled = false;
    chatInput.focus();
  }
}

// ── Load portal data ──────────────────────────────────────────────────────────
async function loadPortal() {
  try {
    const res    = await fetch(
      "/patientPortal/" + encodeURIComponent(session.watchID) +
      "?email="         + encodeURIComponent(session.email)
    );
    const result = await res.json();

    if (!res.ok || !result.success) {
      portalInfo.textContent = result.message || "Unable to load portal.";
      return;
    }

    portalData = result;

    portalTitle.textContent = valueOrDash(result.profile.name) + " – Patient Portal";
    portalInfo.textContent  = "Watch: " + result.profile.watchID +
      " | Last update: " + formatTime(result.latest ? result.latest.time : null);

    renderPatientDetails(result.profile);
    renderSnapshot(result.latest, result.readings || []);
    renderChart(result.readings || [], metricSelect.value);
  } catch (err) {
    portalInfo.textContent = "Server error while loading data.";
    console.error(err);
  }
}

async function loadReminders() {
  try {
    const res    = await fetch("/patientReminders?watch_id=" + encodeURIComponent(session.watchID));
    const result = await res.json();
    renderReminders(res.ok && result.success ? (result.reminders || []) : []);
  } catch {
    renderReminders([]);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
pushChatMessage("Bot:", "Hi! Ask me about your latest vitals or trends.");
loadPortal();
loadReminders();
setInterval(loadPortal,    15000);
setInterval(loadReminders, 60000);