const doctorTab    = document.getElementById("doctorTab");
const patientTab   = document.getElementById("patientTab");
const doctorForm   = document.getElementById("doctorForm");
const patientForm  = document.getElementById("patientForm");
const loginMessage = document.getElementById("loginMessage");

function setMessage(text, type) {
  loginMessage.textContent = text;
  loginMessage.className   = "login-message" + (type ? " " + type : "");
}

function activateTab(tab) {
  const isDoctor = tab === "doctor";
  doctorTab.classList.toggle("active",  isDoctor);
  patientTab.classList.toggle("active", !isDoctor);
  doctorTab.setAttribute("aria-selected",  String(isDoctor));
  patientTab.setAttribute("aria-selected", String(!isDoctor));
  doctorForm.classList.toggle("active",  isDoctor);
  patientForm.classList.toggle("active", !isDoctor);
  document.body.classList.toggle("patient-mode", !isDoctor);
  setMessage("", "");
}

doctorTab.addEventListener("click",  () => activateTab("doctor"));
patientTab.addEventListener("click", () => activateTab("patient"));

// ── Doctor login ──────────────────────────────────────────────────────────────
doctorForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = doctorForm.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  setMessage("", "");

  const email    = document.getElementById("doctorEmail").value.trim();
  const password = document.getElementById("doctorPass").value.trim();

  try {
    const res  = await fetch("/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!data.success) {
      setMessage(data.message || "Invalid credentials.", "error");
      btn.disabled = false;
      btn.textContent = "Sign in as Doctor";
      return;
    }

    localStorage.setItem("doctor", data.doctorEmail || email);
    localStorage.removeItem("patientSession");
    setMessage("Login successful! Redirecting…", "success");
    setTimeout(() => { window.location.href = "dashboard.html"; }, 800);
  } catch {
    setMessage("Server error. Please try again.", "error");
    btn.disabled = false;
    btn.textContent = "Sign in as Doctor";
  }
});

// ── Patient login ─────────────────────────────────────────────────────────────
patientForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = patientForm.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  setMessage("", "");

  const watchID = document.getElementById("patientWatchID").value.trim().toUpperCase();
  const email   = document.getElementById("patientEmail").value.trim();

  try {
    const res  = await fetch("/patientLogin", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ watchID, email })
    });
    const data = await res.json();

    if (!data.success) {
      setMessage(data.message || "Invalid credentials.", "error");
      btn.disabled = false;
      btn.textContent = "Sign in as Patient";
      return;
    }

    localStorage.removeItem("doctor");
    localStorage.setItem("patientSession", JSON.stringify({ watchID, email }));
    setMessage("Login successful! Redirecting…", "success");
    setTimeout(() => { window.location.href = "patient-portal.html"; }, 800);
  } catch {
    setMessage("Server error. Please try again.", "error");
    btn.disabled = false;
    btn.textContent = "Sign in as Patient";
  }
});