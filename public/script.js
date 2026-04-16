// ── Auth guard ────────────────────────────────────────────────────────────────
const doctorEmail = localStorage.getItem("doctor");
if (!doctorEmail) window.location.href = "login.html";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const form              = document.getElementById("watchForm");
const statusMsg         = document.getElementById("statusMsg");
const watchesList       = document.getElementById("watchesList");
const doctorEmailText   = document.getElementById("doctorEmailText");
const submitBtn         = document.getElementById("submitBtn");
const cancelEditBtn     = document.getElementById("cancelEditBtn");
const formTitle         = document.getElementById("formTitle");
const watchIDInput      = document.getElementById("watchID");
const nameInput         = document.getElementById("name");
const emailInput        = document.getElementById("email");
const ageInput          = document.getElementById("age");
const conditionInput    = document.getElementById("condition");
const phoneInput        = document.getElementById("phone");
const logoutBtn         = document.getElementById("logoutBtn");
const notificationBtn   = document.getElementById("notificationBtn");
const notificationBadge = document.getElementById("notificationBadge");
const notificationPanel = document.getElementById("notificationPanel");
const notificationList  = document.getElementById("notificationList");
const hardwareEndpoint  = document.getElementById("hardwareEndpoint");
const themeToggle       = document.getElementById("themeToggle");

// ── State ─────────────────────────────────────────────────────────────────────
let editingWatchID = null;
let latestWatches  = [];
const remindersCache = {};

// ── Init ──────────────────────────────────────────────────────────────────────
doctorEmailText.textContent = "Signed in as " + doctorEmail;
if (hardwareEndpoint) {
  hardwareEndpoint.textContent = window.location.origin + "/update?watchID=WCH001&hr=75&spo2=98&steps=100";
}

// ── Theme toggle ──────────────────────────────────────────────────────────────
let darkMode = false;
themeToggle.addEventListener("click", () => {
  darkMode = !darkMode;
  document.body.classList.toggle("dark", darkMode);
  themeToggle.textContent = darkMode ? "☀️" : "🌙";
});

// ── Logout ────────────────────────────────────────────────────────────────────
logoutBtn.addEventListener("click", () => {
  localStorage.removeItem("doctor");
  window.location.href = "login.html";
});

// ── Notifications toggle ──────────────────────────────────────────────────────
notificationBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  notificationPanel.classList.toggle("open");
});

document.addEventListener("click", (e) => {
  if (!notificationPanel.contains(e.target) && !notificationBtn.contains(e.target)) {
    notificationPanel.classList.remove("open");
  }
});

// ── Add / Edit patient form ───────────────────────────────────────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  statusMsg.textContent = "";

  const payload = {
    watchID:     watchIDInput.value.trim().toUpperCase(),
    name:        nameInput.value.trim(),
    email:       emailInput.value.trim(),
    age:         ageInput.value.trim(),
    condition:   conditionInput.value.trim(),
    phone:       phoneInput.value.trim(),
    doctorEmail: doctorEmail
  };

  if (!payload.watchID || !payload.name || !payload.email) {
    statusMsg.textContent = "Please fill Watch ID, Patient Name and Email.";
    statusMsg.style.color = "var(--rose)";
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = "Saving…";

  const endpoint = editingWatchID ? "/updatePatient" : "/addPatient";
  const method   = editingWatchID ? "PUT" : "POST";
  if (editingWatchID) payload.watchID = editingWatchID;

  try {
    const res    = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload)
    });
    const result = await res.json();

    if (!res.ok || !result.success) {
      statusMsg.textContent = result.message || "Unable to save.";
      statusMsg.style.color = "var(--rose)";
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
      return;
    }

    statusMsg.textContent = result.message;
    statusMsg.style.color = "var(--green)";
    resetEditMode();
    await loadDoctorWatches();
    await loadNotifications();
  } catch {
    statusMsg.textContent = "Server error. Please try again.";
    statusMsg.style.color = "var(--rose)";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

cancelEditBtn.addEventListener("click", () => {
  resetEditMode();
  statusMsg.textContent = "Edit cancelled.";
  statusMsg.style.color = "var(--muted)";
});

// ── Edit helpers ──────────────────────────────────────────────────────────────
function resetEditMode() {
  editingWatchID        = null;
  form.reset();
  watchIDInput.disabled = false;
  submitBtn.textContent = "＋ Add Watch Link";
  formTitle.textContent = "Add Watch & Link Patient";
  cancelEditBtn.style.display = "none";
}

function startEdit(watch) {
  editingWatchID              = watch.watchID;
  watchIDInput.value          = watch.watchID;
  watchIDInput.disabled       = true;
  nameInput.value             = watch.name      === "-" ? "" : watch.name;
  emailInput.value            = watch.email     === "-" ? "" : watch.email;
  ageInput.value              = watch.age       === "-" ? "" : watch.age;
  conditionInput.value        = watch.condition === "-" ? "" : watch.condition;
  phoneInput.value            = watch.phone     === "-" ? "" : watch.phone;
  submitBtn.textContent       = "✓ Update Patient";
  formTitle.textContent       = "Edit Linked Patient";
  cancelEditBtn.style.display = "inline-flex";
  statusMsg.textContent       = "Editing watch: " + watch.watchID;
  statusMsg.style.color       = "var(--amber)";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openStats(watchID) {
  window.location.href = "patient-stats.html?watchID=" + encodeURIComponent(watchID);
}

// ── Reminders ─────────────────────────────────────────────────────────────────
async function fetchRemindersForWatch(watchID) {
  try {
    const res    = await fetch("/getReminders?watch_id=" + encodeURIComponent(watchID));
    const result = await res.json();
    if (!res.ok || !result.success) return remindersCache[watchID] || [];
    remindersCache[watchID] = result.reminders || [];
    return remindersCache[watchID];
  } catch {
    return remindersCache[watchID] || [];
  }
}

function renderReminderList(listEl, reminders) {
  listEl.innerHTML = "";
  if (!reminders.length) {
    listEl.innerHTML = "<li class='reminder-empty'>No reminders yet.</li>";
    return;
  }
  reminders.forEach((item) => {
    const li = document.createElement("li");
    li.className   = "reminder-chip";
    li.textContent = `${item.time || "--:--"} – ${item.medicine_name || "Medicine"} (${item.repeat_days || "-"})`;
    listEl.appendChild(li);
  });
}

function buildReminderForm(watchID, listEl, statusEl) {
  const frm = document.createElement("form");
  frm.className = "reminder-form";
  frm.innerHTML = `
    <input name="medicine" placeholder="Medicine Name" required>
    <input name="time" type="time" required>
    <div class="repeat-days">
      <label><input type="checkbox" value="Mon"> Mon</label>
      <label><input type="checkbox" value="Tue"> Tue</label>
      <label><input type="checkbox" value="Wed"> Wed</label>
      <label><input type="checkbox" value="Thu"> Thu</label>
      <label><input type="checkbox" value="Fri"> Fri</label>
      <label><input type="checkbox" value="Sat"> Sat</label>
      <label><input type="checkbox" value="Sun"> Sun</label>
    </div>
    <div class="reminder-actions">
      <button type="submit">Save Reminder</button>
      <button type="button" class="secondary-btn rem-cancel">Close</button>
    </div>`;

  frm.querySelector(".rem-cancel").addEventListener("click", () => { frm.style.display = "none"; });

  frm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = frm.querySelector("button[type=submit]");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    const days = Array.from(frm.querySelectorAll(".repeat-days input:checked")).map(cb => cb.value);
    const payload = {
      watch_id:      watchID,
      medicine_name: frm.querySelector("[name=medicine]").value.trim(),
      time:          frm.querySelector("[name=time]").value,
      repeat_days:   days.join(",")
    };

    try {
      const res    = await fetch("/addReminder", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload)
      });
      const result = await res.json();
      if (!res.ok || !result.success) {
        statusEl.textContent = result.message || "Unable to save reminder.";
        return;
      }
      frm.reset();
      statusEl.textContent = "✓ Reminder added.";
      renderReminderList(listEl, await fetchRemindersForWatch(watchID));
    } catch {
      statusEl.textContent = "Server error.";
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Reminder";
    }
  });

  frm.style.display = "none";
  return frm;
}

function createReminderCell(watch) {
  const cell    = document.createElement("td");
  cell.className = "reminders-cell";

  const header   = document.createElement("div");
  header.className = "reminder-head";
  const title    = document.createElement("strong");
  title.textContent = "Reminders";
  title.style.fontSize = "12px";
  title.style.color = "var(--muted)";
  header.appendChild(title);

  const list     = document.createElement("ul");
  list.className  = "reminder-list";

  const statusEl = document.createElement("p");
  statusEl.className = "reminder-status";

  const frm      = buildReminderForm(watch.watchID, list, statusEl);

  const toggleForm = async () => {
    const isHidden = frm.style.display === "none" || frm.style.display === "";
    frm.style.display = isHidden ? "flex" : "none";
    if (isHidden) renderReminderList(list, await fetchRemindersForWatch(watch.watchID));
  };

  cell.appendChild(header);
  cell.appendChild(list);
  cell.appendChild(frm);
  cell.appendChild(statusEl);

  fetchRemindersForWatch(watch.watchID).then((data) => renderReminderList(list, data));

  return { cell, toggleForm };
}

// ── Connectivity ──────────────────────────────────────────────────────────────
function connLabel(readings) {
  if (!Array.isArray(readings) || !readings.length) return { text: "Not connected", cls: "conn-offline" };
  const latest = readings[readings.length - 1];
  const ageMs  = Date.now() - new Date(latest.time).getTime();
  if (isNaN(ageMs))    return { text: "Unknown", cls: "conn-offline" };
  if (ageMs <= 75000)  return { text: "Live",    cls: "conn-live" };
  if (ageMs <= 300000) return { text: "Idle",    cls: "conn-idle" };
  return                      { text: "Offline", cls: "conn-offline" };
}

async function updateConnectivity(watches) {
  const cells = Array.from(document.querySelectorAll("[data-conn-watch]"));
  if (!cells.length) return;

  const results = await Promise.all(
    watches.map(async (w) => {
      try {
        const res = await fetch("/data/" + encodeURIComponent(w.watchID));
        return { watchID: w.watchID, readings: await res.json() };
      } catch {
        return { watchID: w.watchID, readings: [] };
      }
    })
  );

  const map = {};
  let liveCount = 0;
  results.forEach(({ watchID, readings }) => {
    map[watchID] = connLabel(readings);
    if (map[watchID].cls === "conn-live") liveCount++;
  });

  cells.forEach((cell) => {
    const { text, cls } = map[cell.dataset.connWatch] || { text: "Unknown", cls: "conn-offline" };
    cell.textContent = text;
    cell.className   = "conn-pill " + cls;
  });

  if (window.__updateHeroLive) window.__updateHeroLive(liveCount);
}

// ── Load doctor's watches ─────────────────────────────────────────────────────
async function loadDoctorWatches() {
  try {
    const res    = await fetch("/doctorWatches?doctorEmail=" + encodeURIComponent(doctorEmail));
    const result = await res.json();

    if (!res.ok || !result.success) {
      watchesList.innerHTML = "<p class='subtle'>Unable to load watches: " + (result.message || "server error") + "</p>";
      return;
    }

    latestWatches = result.watches;

    // Update hero stats
    if (window.__updateHeroStats) {
      window.__updateHeroStats(result.watches, 0);
    }

    if (!result.watches.length) {
      watchesList.innerHTML = "<p class='subtle'>No watches linked yet. Add one above.</p>";
      return;
    }

    const table = document.createElement("table");
    table.className = "watches-table";
    table.innerHTML = `<thead><tr>
      <th>Watch ID</th><th>Status</th><th>Patient</th><th>Email</th>
      <th>Age</th><th>Condition</th><th>Phone</th><th>Reminders</th><th>Actions</th>
    </tr></thead>`;

    const tbody = document.createElement("tbody");

    result.watches.forEach((watch) => {
      const row = document.createElement("tr");

      const mkTd = (text) => {
        const td = document.createElement("td");
        td.textContent = text;
        return td;
      };

      const deviceTd = document.createElement("td");
      deviceTd.innerHTML = `<span class="conn-pill conn-loading" data-conn-watch="${watch.watchID}">Checking…</span>`;

      const reminderObj = createReminderCell(watch);

      const actionTd = document.createElement("td");
      actionTd.className = "action-cell";

      const mkBtn = (label, cls, fn) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = cls; b.textContent = label;
        b.addEventListener("click", fn);
        return b;
      };

      actionTd.appendChild(mkBtn("✏️ Edit",       "secondary-btn", () => startEdit(watch)));
      actionTd.appendChild(mkBtn("📊 Stats",      "stats-btn",     () => openStats(watch.watchID)));
      actionTd.appendChild(mkBtn("💊 Reminders",  "secondary-btn", reminderObj.toggleForm));

      row.appendChild(mkTd(watch.watchID));
      row.appendChild(deviceTd);
      row.appendChild(mkTd(watch.name));
      row.appendChild(mkTd(watch.email));
      row.appendChild(mkTd(watch.age));
      row.appendChild(mkTd(watch.condition));
      row.appendChild(mkTd(watch.phone));
      row.appendChild(reminderObj.cell);
      row.appendChild(actionTd);
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    watchesList.innerHTML = "";
    watchesList.appendChild(table);
    updateConnectivity(result.watches);
  } catch (err) {
    watchesList.innerHTML = "<p class='subtle'>Server error while loading watches.</p>";
    console.error(err);
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────
function renderNotifications(notifications) {
  if (!notifications.length) {
    notificationList.innerHTML    = "<li class='notif-empty'>No critical alerts right now. ✓</li>";
    notificationBadge.style.display = "none";

    // Update hero critical count
    if (window.__updateHeroStats) window.__updateHeroStats(latestWatches, 0);
    return;
  }

  notificationBadge.style.display = "inline-flex";
  notificationBadge.textContent    = notifications.length;
  notificationList.innerHTML       = "";

  // Update hero critical count
  if (window.__updateHeroStats) window.__updateHeroStats(latestWatches, notifications.length);

  notifications.forEach((item) => {
    const li = document.createElement("li");
    li.className = "notif-item";
    li.innerHTML = `<strong>${item.patientName}</strong> (${item.watchID})<br>
      HR: ${item.hr} | SpO₂: ${item.spo2}<br>
      <span class="notif-time">${new Date(item.time).toLocaleString()}</span>`;
    notificationList.appendChild(li);
  });
}

async function loadNotifications() {
  try {
    const res    = await fetch("/criticalNotifications?doctorEmail=" + encodeURIComponent(doctorEmail));
    const result = await res.json();
    renderNotifications(result.success ? (result.notifications || []) : []);
  } catch {
    renderNotifications([]);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadDoctorWatches();
loadNotifications();
setInterval(loadNotifications,  15000);
setInterval(() => { if (latestWatches.length) updateConnectivity(latestWatches); }, 20000);