const express = require("express");
const path = require("path");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT         = process.env.PORT || 3000;
const CRITICAL_HR  = 120;
const CRITICAL_SPO2 = 90;

const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const GROQ_MODEL   = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();
const MAIL_USER    = process.env.MAIL_USER || "";
const MAIL_PASS    = process.env.MAIL_PASS || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are missing!");
}

const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ─── Nodemailer ───────────────────────────────────────────────────────────────

const transporter = (MAIL_USER && MAIL_PASS)
  ? nodemailer.createTransport({ service: "gmail", auth: { user: MAIL_USER, pass: MAIL_PASS } })
  : null;

// ─── Middleware: require Supabase ─────────────────────────────────────────────

function requireSupabase(req, res, next) {
  if (!supabase) {
    return res.status(500).json({ success: false, message: "Supabase is not configured. Check env vars." });
  }
  next();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isCriticalReading(r) {
  if (!r) return false;
  return Number(r.hr) > CRITICAL_HR
    || Number(r.spo2) < CRITICAL_SPO2
    || String(r.status || "").toLowerCase().includes("critical");
}

function sendCriticalEmail(patient, entry) {
  if (!transporter || !patient) return;
  const to = [];
  const doc = String(patient.doctor_email || "").trim();
  const pat = String(patient.email || "").trim();
  if (doc) to.push(doc);
  if (pat && pat.toLowerCase() !== doc.toLowerCase()) to.push(pat);
  if (!to.length) return;
  transporter.sendMail({
    to: to.join(","),
    subject: "⚠️ Arogya Critical Alert",
    text: `Critical alert for ${patient.name}.\nWatch: ${entry.watch_id}\nHR: ${entry.hr}, SpO2: ${entry.spo2}, Steps: ${entry.steps}\nTime: ${entry.time}`
  }).catch((e) => console.error("Email failed:", e.message));
}

// ─── DB: Doctors ──────────────────────────────────────────────────────────────
// Table: doctors (id, email text unique, password text, created_at)

async function dbGetDoctor(email, password) {
  const { data, error } = await supabase
    .from("doctors")
    .select("email, password")
    .eq("email", email.toLowerCase().trim())
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.password !== password) return null;
  return data;
}

// ─── DB: Patients ─────────────────────────────────────────────────────────────
// Table: patients (watch_id text PK, name, email, doctor_email, age, condition, phone, created_at)

async function dbGetPatient(watch_id) {
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .eq("watch_id", watch_id.toUpperCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function dbGetDoctorPatients(doctor_email) {
  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .eq("doctor_email", doctor_email);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
}

async function dbUpsertPatient(fields) {
  const { error } = await supabase
    .from("patients")
    .upsert([fields], { onConflict: "watch_id" });
  if (error) throw new Error(error.message);
}

// ─── DB: Readings ─────────────────────────────────────────────────────────────
// Table: readings (id bigserial PK, watch_id text, hr numeric, spo2 numeric, steps numeric, status text, time timestamptz)

async function dbFetchReadings(watch_id) {
  const { data, error } = await supabase
    .from("readings")
    .select("watch_id, hr, spo2, steps, status, time")
    .eq("watch_id", watch_id.toUpperCase())
    .order("time", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
}

async function dbInsertReading(entry) {
  const { error } = await supabase.from("readings").insert([entry]);
  if (error) throw new Error(error.message);
}

// ─── DB: Reminders ────────────────────────────────────────────────────────────
// Table: reminders (id bigserial PK, watch_id text, medicine_name text, time text, repeat_days text, doctor_email text, created_at)

async function dbInsertReminder(fields) {
  const { error } = await supabase.from("reminders").insert([fields]);
  if (error) throw new Error(error.message);
}

async function dbFetchReminders(watch_id) {
  const { data, error } = await supabase
    .from("reminders")
    .select("watch_id, medicine_name, time, repeat_days, doctor_email, created_at")
    .eq("watch_id", watch_id.toUpperCase())
    .order("time", { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
}

// ─── Groq AI ──────────────────────────────────────────────────────────────────

async function askGroq(question, contextText, role) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");

  const systemPrompt = role === "doctor"
    ? "You are a concise clinical assistant for doctors. Use only the provided patient data. Give practical guidance. Keep responses under 8 lines."
    : "You are a supportive health assistant for patients. Use simple language. Never diagnose. Advise contacting a doctor for severe values. Keep responses under 8 lines.";

  for (const model of [GROQ_MODEL, "llama-3.1-8b-instant"]) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 300,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Context:\n${contextText}\n\nQuestion:\n${question}` }
        ]
      })
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 404) continue; // try next model
      throw new Error(`Groq ${res.status}: ${body}`);
    }

    const json = await res.json();
    return json?.choices?.[0]?.message?.content || "No response from AI.";
  }

  throw new Error("All Groq models failed");
}

// ════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ── ESP32 data ingestion (GET so ESP32 can use simple HTTP) ──────────────────
app.get("/update", requireSupabase, async (req, res) => {
  const watch_id = String(req.query.watchID || "").trim().toUpperCase();
  if (!watch_id) return res.status(400).send("watchID is required");

  const entry = {
    watch_id,
    hr:     Number(req.query.hr)    || 0,
    spo2:   Number(req.query.spo2)  || 0,
    steps:  Number(req.query.steps) || 0,
    status: String(req.query.status || "normal"),
    time:   new Date().toISOString()
  };

  try {
    await dbInsertReading(entry);
  } catch (err) {
    console.error("Insert reading failed:", err.message);
    return res.status(500).send("DB error: " + err.message);
  }

  if (isCriticalReading(entry)) {
    dbGetPatient(watch_id)
      .then((p) => { if (p) sendCriticalEmail(p, entry); })
      .catch((e) => console.warn("Email lookup failed:", e.message));
  }

  res.send("OK");
});

// ── Readings for a watch ─────────────────────────────────────────────────────
app.get("/data/:watchID", requireSupabase, async (req, res) => {
  const watch_id = String(req.params.watchID || "").trim().toUpperCase();
  try {
    const readings = await dbFetchReadings(watch_id);
    res.json(readings);
  } catch (err) {
    console.error("Fetch readings failed:", err.message);
    res.status(500).json([]);
  }
});

// ── Doctor login ─────────────────────────────────────────────────────────────
app.post("/login", requireSupabase, async (req, res) => {
  const email    = String(req.body.email    || "").trim();
  const password = String(req.body.password || "").trim();

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required" });
  }

  try {
    const doctor = await dbGetDoctor(email, password);
    if (!doctor) return res.json({ success: false, message: "Invalid credentials" });
    return res.json({ success: true, doctorEmail: doctor.email });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ── Patient login ────────────────────────────────────────────────────────────
app.post("/patientLogin", requireSupabase, async (req, res) => {
  const watch_id = String(req.body.watchID || "").trim().toUpperCase();
  const email    = String(req.body.email   || "").trim().toLowerCase();

  if (!watch_id || !email) {
    return res.status(400).json({ success: false, message: "Watch ID and email required" });
  }

  try {
    const patient = await dbGetPatient(watch_id);
    if (!patient) return res.json({ success: false, message: "Watch not found" });
    if (String(patient.email || "").toLowerCase() !== email) {
      return res.json({ success: false, message: "Invalid credentials" });
    }
    return res.json({
      success: true,
      patient: { watchID: watch_id, name: patient.name, email: patient.email }
    });
  } catch (err) {
    console.error("Patient login error:", err.message);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ── Add patient ──────────────────────────────────────────────────────────────
app.post("/addPatient", requireSupabase, async (req, res) => {
  const watch_id     = String(req.body.watchID     || "").trim().toUpperCase();
  const name         = String(req.body.name         || "").trim();
  const email        = String(req.body.email        || "").trim();
  const doctor_email = String(req.body.doctorEmail  || "").trim();
  const age          = String(req.body.age          || "").trim();
  const condition    = String(req.body.condition    || "").trim();
  const phone        = String(req.body.phone        || "").trim();

  if (!watch_id || !name || !email || !doctor_email) {
    return res.status(400).json({ success: false, message: "Watch ID, name, email, and doctor email are required" });
  }

  try {
    const existing = await dbGetPatient(watch_id);
    if (existing && existing.doctor_email && existing.doctor_email !== doctor_email) {
      return res.status(403).json({ success: false, message: "Watch already linked to another doctor" });
    }
    await dbUpsertPatient({ watch_id, name, email, doctor_email, age, condition, phone });
    return res.json({ success: true, message: "Watch linked successfully" });
  } catch (err) {
    console.error("addPatient error:", err.message);
    return res.status(500).json({ success: false, message: "Unable to save: " + err.message });
  }
});

// ── Update patient ───────────────────────────────────────────────────────────
app.put("/updatePatient", requireSupabase, async (req, res) => {
  const watch_id     = String(req.body.watchID     || "").trim().toUpperCase();
  const name         = String(req.body.name         || "").trim();
  const email        = String(req.body.email        || "").trim();
  const doctor_email = String(req.body.doctorEmail  || "").trim();
  const age          = String(req.body.age          || "").trim();
  const condition    = String(req.body.condition    || "").trim();
  const phone        = String(req.body.phone        || "").trim();

  if (!watch_id || !name || !email || !doctor_email) {
    return res.status(400).json({ success: false, message: "Watch ID, name, email, and doctor email are required" });
  }

  try {
    const existing = await dbGetPatient(watch_id);
    if (!existing) return res.status(404).json({ success: false, message: "Watch not found" });
    if (existing.doctor_email && existing.doctor_email !== doctor_email) {
      return res.status(403).json({ success: false, message: "Watch linked to another doctor" });
    }
    await dbUpsertPatient({ watch_id, name, email, doctor_email, age, condition, phone });
    return res.json({ success: true, message: "Patient updated" });
  } catch (err) {
    console.error("updatePatient error:", err.message);
    return res.status(500).json({ success: false, message: "Unable to update: " + err.message });
  }
});

// ── Doctor's linked watches ──────────────────────────────────────────────────
app.get("/doctorWatches", requireSupabase, async (req, res) => {
  const doctor_email = String(req.query.doctorEmail || "").trim();
  if (!doctor_email) return res.status(400).json({ success: false, message: "doctorEmail required" });

  try {
    const rows = await dbGetDoctorPatients(doctor_email);
    const watches = rows.map((p) => ({
      watchID:   p.watch_id,
      name:      p.name      || "-",
      email:     p.email     || "-",
      age:       p.age       || "-",
      condition: p.condition || "-",
      phone:     p.phone     || "-"
    }));
    return res.json({ success: true, watches });
  } catch (err) {
    console.error("doctorWatches error:", err.message);
    return res.status(500).json({ success: false, message: "Unable to load: " + err.message });
  }
});

// ── Patient profile (doctor view) ────────────────────────────────────────────
app.get("/patientProfile/:watchID", requireSupabase, async (req, res) => {
  const watch_id     = String(req.params.watchID    || "").trim().toUpperCase();
  const doctor_email = String(req.query.doctorEmail || "").trim();

  if (!watch_id || !doctor_email) {
    return res.status(400).json({ success: false, message: "watchID and doctorEmail required" });
  }

  try {
    const patient = await dbGetPatient(watch_id);
    if (!patient) return res.status(404).json({ success: false, message: "Patient not found" });
    if (patient.doctor_email && patient.doctor_email !== doctor_email) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const readings = await dbFetchReadings(watch_id);
    const latest   = readings[readings.length - 1] || null;

    return res.json({
      success: true,
      profile: {
        watchID:     watch_id,
        name:        patient.name        || "-",
        email:       patient.email       || "-",
        age:         patient.age         || "-",
        condition:   patient.condition   || "-",
        phone:       patient.phone       || "-",
        doctorEmail: patient.doctor_email || "-"
      },
      latest,
      readings
    });
  } catch (err) {
    console.error("patientProfile error:", err.message);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ── Patient portal (self-view) ───────────────────────────────────────────────
app.get("/patientPortal/:watchID", requireSupabase, async (req, res) => {
  const watch_id = String(req.params.watchID || "").trim().toUpperCase();
  const email    = String(req.query.email    || "").trim();

  if (!watch_id || !email) {
    return res.status(400).json({ success: false, message: "watchID and email required" });
  }

  try {
    const patient = await dbGetPatient(watch_id);
    if (!patient) return res.status(404).json({ success: false, message: "Patient not found" });
    if (String(patient.email || "").toLowerCase() !== email.toLowerCase()) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const readings = await dbFetchReadings(watch_id);
    const latest   = readings[readings.length - 1] || null;

    return res.json({
      success: true,
      profile: {
        watchID:   watch_id,
        name:      patient.name      || "-",
        email:     patient.email     || "-",
        age:       patient.age       || "-",
        condition: patient.condition || "-",
        phone:     patient.phone     || "-"
      },
      latest,
      readings
    });
  } catch (err) {
    console.error("patientPortal error:", err.message);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ── Critical notifications ───────────────────────────────────────────────────
app.get("/criticalNotifications", requireSupabase, async (req, res) => {
  const doctor_email = String(req.query.doctorEmail || "").trim();
  if (!doctor_email) return res.status(400).json({ success: false, message: "doctorEmail required" });

  try {
    const patients = await dbGetDoctorPatients(doctor_email);
    const results  = await Promise.all(
      patients.map(async (p) => {
        const readings = await dbFetchReadings(p.watch_id);
        const latest   = readings[readings.length - 1] || null;
        if (!isCriticalReading(latest)) return null;
        return {
          watchID:     p.watch_id,
          patientName: p.name || "Unknown",
          hr:          Number(latest.hr)   || 0,
          spo2:        Number(latest.spo2) || 0,
          status:      latest.status || "critical",
          time:        latest.time   || new Date().toISOString()
        };
      })
    );
    const notifications = results.filter(Boolean);
    return res.json({ success: true, notifications });
  } catch (err) {
    console.error("criticalNotifications error:", err.message);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ── Add reminder ─────────────────────────────────────────────────────────────
app.post("/addReminder", requireSupabase, async (req, res) => {
  const watch_id      = String(req.body.watch_id    || req.body.watchID || "").trim().toUpperCase();
  const medicine_name = String(req.body.medicine_name || "").trim();
  const time          = String(req.body.time          || "").trim();
  const repeat_days   = String(req.body.repeat_days   || "").trim();
  const doctor_email  = String(req.body.doctor_email  || "").trim();

  if (!watch_id || !medicine_name || !time || !repeat_days || !doctor_email) {
    return res.status(400).json({ success: false, message: "All reminder fields required" });
  }

  try {
    const patient = await dbGetPatient(watch_id);
    if (patient && patient.doctor_email && patient.doctor_email !== doctor_email) {
      return res.status(403).json({ success: false, message: "Watch linked to another doctor" });
    }
    await dbInsertReminder({ watch_id, medicine_name, time, repeat_days, doctor_email });
    return res.json({ success: true, message: "Reminder added" });
  } catch (err) {
    console.error("addReminder error:", err.message);
    return res.status(500).json({ success: false, message: "Unable to add reminder: " + err.message });
  }
});

// ── Get reminders (doctor dashboard) ────────────────────────────────────────
app.get("/getReminders", requireSupabase, async (req, res) => {
  const watch_id = String(req.query.watch_id || "").trim().toUpperCase();
  if (!watch_id) return res.status(400).json({ success: false, message: "watch_id required" });

  try {
    const reminders = await dbFetchReminders(watch_id);
    return res.json({ success: true, reminders });
  } catch (err) {
    console.error("getReminders error:", err.message);
    return res.status(500).json({ success: false, message: "Unable to fetch: " + err.message });
  }
});

// ── Get reminders (patient portal) ──────────────────────────────────────────
app.get("/patientReminders", requireSupabase, async (req, res) => {
  const watch_id = String(req.query.watch_id || "").trim().toUpperCase();
  if (!watch_id) return res.status(400).json({ success: false, message: "watch_id required" });

  try {
    const reminders = await dbFetchReminders(watch_id);
    return res.json({ success: true, reminders });
  } catch (err) {
    console.error("patientReminders error:", err.message);
    return res.status(500).json({ success: false, message: "Unable to fetch: " + err.message });
  }
});

// ── AI Chat ──────────────────────────────────────────────────────────────────
app.post("/aiChat", async (req, res) => {
  const role     = String(req.body.role     || "patient").trim().toLowerCase();
  const question = String(req.body.question || "").trim();
  const context  = String(req.body.context  || "").trim();

  if (!question) return res.status(400).json({ success: false, message: "question required" });

  try {
    const answer = await askGroq(question, context, role === "doctor" ? "doctor" : "patient");
    return res.json({ success: true, answer });
  } catch (err) {
    console.error("AI chat error:", err.message);
    return res.status(500).json({ success: false, message: "AI unavailable: " + err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Arogya server running on port ${PORT}`);
});
