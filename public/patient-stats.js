// ── Auth guard ────────────────────────────────────────────────────────────────
const doctorEmail = localStorage.getItem("doctor");
if (!doctorEmail) window.location.href = "login.html";

const params  = new URLSearchParams(window.location.search);
const watchID = (params.get("watchID") || "").trim().toUpperCase();
if (!watchID) window.location.href = "dashboard.html";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const pageTitle      = document.getElementById("pageTitle");
const watchInfo      = document.getElementById("watchInfo");
const backBtn        = document.getElementById("backBtn");
const patientDetailsEl = document.getElementById("patientDetails");
const snapshotCards  = document.getElementById("snapshotCards");
const metricSelect   = document.getElementById("metricSelect");
const lineChart      = document.getElementById("lineChart");
const chatLog        = document.getElementById("chatLog");
const chatInput      = document.getElementById("chatInput");
const chatSendBtn    = document.getElementById("chatSendBtn");

let profileData = null;

// ── Back ──────────────────────────────────────────────────────────────────────
backBtn.addEventListener("click", () => { window.location.href = "dashboard.html"; });

// ── Metric selector ───────────────────────────────────────────────────────────
metricSelect.addEventListener("change", () => {
  if (profileData) renderChart(profileData.readings || [], metricSelect.value);
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

function riskLabel(readings) {
  const c = criticalCount(readings);
  if (c >= 5) return "High";
  if (c >= 2) return "Medium";
  return "Low";
}

// ── Render: patient details ───────────────────────────────────────────────────
function renderPatientDetails(profile) {
  const fields = [
    ["Patient Name", profile.name],
    ["Watch ID",     profile.watchID],
    ["Email",        profile.email],
    ["Age",          profile.age],
    ["Condition",    profile.condition],
    ["Phone",        profile.phone],
    ["Doctor",       profile.doctorEmail]
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
  const risk   = riskLabel(readings);
  const cCount = criticalCount(readings);

  const cards = [
    ["Latest HR",        latest ? valueOrDash(latest.hr)   : "-",  latest && Number(latest.hr)   > 120],
    ["Latest SpO2",      latest ? valueOrDash(latest.spo2) : "-",  latest && Number(latest.spo2) < 90 ],
    ["Average HR",       avg.hr,                                    false],
    ["Average SpO2",     avg.spo2,                                  false],
    ["Average Steps",    avg.steps,                                 false],
    ["Critical Entries", cCount,                                    cCount > 0],
    ["Risk Level",       risk,                                      risk === "High"],
    ["Last Updated",     latest ? formatTime(latest.time) : "-",   false]
  ];

  snapshotCards.innerHTML = "";
  cards.forEach(([label, value, bad]) => {
    const card = document.createElement("div");
    card.className = "metric-card";
    card.innerHTML = `<h4>${label}</h4><p class="${bad ? "metric-bad" : ""}">${value}</p>`;
    snapshotCards.appendChild(card);
  });
}

// ── Render: chart ─────────────────────────────────────────────────────────────
function renderChart(readings, metric) {
  const last30 = readings.slice(-30);
  if (!last30.length) {
    lineChart.innerHTML = "<text x='50%' y='50%' text-anchor='middle' fill='#6b7280' font-size='16'>No data yet</text>";
    return;
  }

  const values = last30.map((r) => Number(r[metric]) || 0);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * 780 + 10;
    const y = 260 - ((v - min) / (max - min)) * 240;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const color = metric === "spo2" ? "#1d4ed8" : metric === "steps" ? "#0f766e" : "#be123c";

  lineChart.innerHTML = `
    <polyline fill="none" stroke="${color}" stroke-width="3" points="${points}"/>
    <text x="14" y="20" fill="#6b7280" font-size="12">Min: ${min.toFixed(1)}</text>
    <text x="14" y="38" fill="#6b7280" font-size="12">Max: ${max.toFixed(1)}</text>`;
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function pushChatMessage(sender, text) {
  const row = document.createElement("div");
  row.className = "chat-msg";
  row.innerHTML = `<strong>${sender}</strong> ${text}`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function buildContext() {
  if (!profileData || !profileData.readings || !profileData.readings.length) {
    return "No patient data available.";
  }
  const latest   = profileData.latest || {};
  const readings = profileData.readings.slice(-5);
  const history  = readings.map((r) =>
    `HR:${r.hr}, SpO2:${r.spo2}, Steps:${r.steps}, Status:${r.status}`
  ).join("\n");

  return `Patient: ${profileData.profile.name}
Age: ${profileData.profile.age}
Condition: ${profileData.profile.condition}

Latest:
HR: ${latest.hr}, SpO2: ${latest.spo2}, Steps: ${latest.steps}, Status: ${latest.status}

Recent (last 5):
${history}`;
}

function localFallback(q) {
  if (!profileData) return "Patient data is still loading.";
  const lq      = q.toLowerCase();
  const latest  = profileData.latest || {};
  const readings = profileData.readings || [];
  const avg     = computeAverages(readings);
  const risk    = riskLabel(readings);
  const cCount  = criticalCount(readings);

  if (lq.includes("latest") || lq.includes("current") || lq.includes("vital")) {
    return `Latest → HR: ${latest.hr}, SpO₂: ${latest.spo2}, Steps: ${latest.steps}, Status: ${valueOrDash(latest.status)}.`;
  }
  if (lq.includes("risk") || lq.includes("critical")) {
    return `Risk level: ${risk}. Critical entries: ${cCount}.`;
  }
  if (lq.includes("summary") || lq.includes("average")) {
    return `Avg HR: ${avg.hr}, Avg SpO₂: ${avg.spo2}, Avg Steps: ${avg.steps}.`;
  }
  if (lq.includes("patient") || lq.includes("detail")) {
    return `${valueOrDash(profileData.profile.name)}, age ${valueOrDash(profileData.profile.age)}, condition: ${valueOrDash(profileData.profile.condition)}.`;
  }
  if (lq.includes("next") || lq.includes("plan") || lq.includes("care")) {
    return "Next steps: verify medication adherence, recheck vitals in 30 min, escalate if trend worsens.";
  }
  return "Ask about latest vitals, risk level, patient summary, or care plan.";
}

async function onSendChat() {
  const text = chatInput.value.trim();
  if (!text) return;

  if (!profileData) {
    pushChatMessage("Bot:", "⚠️ Patient data is still loading. Please wait a moment.");
    return;
  }

  pushChatMessage("You:", text);
  chatInput.value = "";

  try {
    const res    = await fetch("/aiChat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ role: "doctor", question: text, context: buildContext() })
    });
    const result = await res.json();
    pushChatMessage("Bot:", result.success && result.answer ? result.answer : localFallback(text));
  } catch {
    pushChatMessage("Bot:", localFallback(text));
  }
}

// ── Load profile ──────────────────────────────────────────────────────────────
async function loadProfile() {
  try {
    const res    = await fetch(
      "/patientProfile/" + encodeURIComponent(watchID) +
      "?doctorEmail="    + encodeURIComponent(doctorEmail)
    );
    const result = await res.json();

    if (!res.ok || !result.success) {
      watchInfo.textContent = result.message || "Unable to load patient profile.";
      return;
    }

    profileData = result;

    pageTitle.textContent = valueOrDash(result.profile.name) + " – Statistics";
    watchInfo.textContent = "Watch: " + result.profile.watchID +
      " | Last update: " + formatTime(result.latest ? result.latest.time : null);

    renderPatientDetails(result.profile);
    renderSnapshot(result.latest, result.readings || []);
    renderChart(result.readings || [], metricSelect.value);

    pushChatMessage("Bot:", "Data loaded. Ask about vitals, risk level, summary, or care plan.");
  } catch (err) {
    watchInfo.textContent = "Server error loading profile.";
    console.error(err);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadProfile();
setInterval(loadProfile, 15000);
