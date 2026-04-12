// ── Auth guard ────────────────────────────────────────────────────────────────
const doctorEmail = localStorage.getItem("doctor");
if (!doctorEmail) window.location.href = "login.html";

const params  = new URLSearchParams(window.location.search);
const watchID = (params.get("watchID") || "").trim().toUpperCase();
if (!watchID) window.location.href = "dashboard.html";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const pageTitle       = document.getElementById("pageTitle");
const watchInfo       = document.getElementById("watchInfo");
const backBtn         = document.getElementById("backBtn");
const patientDetailsEl = document.getElementById("patientDetails");
const snapshotCards   = document.getElementById("snapshotCards");
const metricSelect    = document.getElementById("metricSelect");
const lineChart       = document.getElementById("lineChart");
const chatLog         = document.getElementById("chatLog");
const chatInput       = document.getElementById("chatInput");
const chatSendBtn     = document.getElementById("chatSendBtn");

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
    ["Latest HR",       latest ? valueOrDash(latest.hr)   : "-",  latest && Number(latest.hr)   > 120],
    ["Latest SpO₂",    latest ? valueOrDash(latest.spo2) : "-",  latest && Number(latest.spo2) < 90 ],
    ["Average HR",      avg.hr,                                    false],
    ["Average SpO₂",   avg.spo2,                                  false],
    ["Average Steps",   avg.steps,                                 false],
    ["Critical Entries", cCount,                                   cCount > 0],
    ["Risk Level",      risk,                                      risk === "High"],
    ["Last Updated",    latest ? formatTime(latest.time) : "-",   false]
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
    lineChart.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="#4d5a8a" font-size="15" font-family="DM Sans,sans-serif">No data yet</text>`;
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
  const areaPath = `M${pts[0][0]},${H} ` + pts.map(p => `L${p[0]},${p[1]}`).join(" ") + ` L${pts[pts.length-1][0]},${H} Z`;

  const colors = {
    hr:    { stroke: "#ff6b8a", fill: "rgba(255,107,138,0.08)" },
    spo2:  { stroke: "#4f7cff", fill: "rgba(79,124,255,0.08)" },
    steps: { stroke: "#0ef2a0", fill: "rgba(14,242,160,0.08)" }
  };
  const c = colors[metric] || colors.hr;

  const dotsHTML = pts.map(([x, y], i) =>
    `<circle cx="${x}" cy="${y}" r="${i === pts.length - 1 ? 6 : 3}" fill="${c.stroke}" opacity="${i === pts.length - 1 ? 1 : 0.4}"/>`
  ).join("");

  lineChart.innerHTML = `
    <defs>
      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${c.stroke}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${c.stroke}" stop-opacity="0"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
        <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <path d="${areaPath}" fill="url(#chartGrad)"/>
    <polyline fill="none" stroke="${c.stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${pointStr}" filter="url(#glow)"/>
    ${dotsHTML}
    <text x="${PAD}" y="20" fill="#4d5a8a" font-size="11" font-family="DM Mono,monospace">Min: ${min.toFixed(1)}</text>
    <text x="${PAD}" y="36" fill="#4d5a8a" font-size="11" font-family="DM Mono,monospace">Max: ${max.toFixed(1)}</text>
  `;
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function pushChatMessage(sender, text) {
  const row = document.createElement("div");
  row.className = "chat-msg";
  row.innerHTML = `<strong>${sender}</strong>${text}`;
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
  chatSendBtn.disabled = true;

  try {
    const res    = await fetch("/aiChat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ role: "doctor", question: text, context: buildContext(), watchID })
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

    pageTitle.textContent = "📊 " + valueOrDash(result.profile.name) + " – Statistics";
    watchInfo.textContent = "Watch: " + result.profile.watchID +
      " | Last update: " + formatTime(result.latest ? result.latest.time : null);

    renderPatientDetails(result.profile);
    renderSnapshot(result.latest, result.readings || []);
    renderChart(result.readings || [], metricSelect.value);

    // Update hero banner
    if (window.__updatePatientHero) {
      window.__updatePatientHero(result.profile, result.readings || [], riskLabel(result.readings || []));
    }

    if (chatLog.children.length === 0) {
      pushChatMessage("Bot:", "Data loaded. Ask about vitals, risk level, summary, or care plan.");
    }
  } catch (err) {
    watchInfo.textContent = "Server error loading profile.";
    console.error(err);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadProfile();
setInterval(loadProfile, 15000);