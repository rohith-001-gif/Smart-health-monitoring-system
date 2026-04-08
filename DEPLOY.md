# Arogya – Full Deployment Guide
## Supabase + Render + GitHub

---

## STEP 1 — Project folder structure

Your project must look exactly like this:

```
arogya/
├── server.js              ← backend (Node/Express)
├── package.json
├── .env.example           ← commit this (no secrets)
├── .gitignore             ← commit this
├── supabase_setup.sql     ← run once in Supabase, don't need to commit
└── public/                ← all frontend files go here
    ├── login.html
    ├── login.css
    ├── login.js
    ├── dashboard.html
    ├── script.js
    ├── style.css
    ├── patient-portal.html
    ├── patient-portal.js
    ├── patient-stats.html
    └── patient-stats.js
```

server.js serves everything in `public/` as static files automatically.

---

## STEP 2 — Set up Supabase tables

1. Go to https://supabase.com → your project
2. Click **SQL Editor** → **New Query**
3. Paste the entire contents of `supabase_setup.sql` and click **Run**
4. Add your doctor account by running this separately:

```sql
insert into doctors (email, password)
values ('yourdoctor@email.com', 'yourpassword');
```

5. Get your keys: **Project Settings → API**
   - Copy **Project URL** → this is your `SUPABASE_URL`
   - Copy **service_role** key (NOT anon key) → this is your `SUPABASE_SERVICE_ROLE_KEY`

---

## STEP 3 — Set up local .env (for testing on your PC)

Create a file called `.env` in the root of your project (NOT inside public/):

```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIs...
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
MAIL_USER=youremail@gmail.com
MAIL_PASS=your-gmail-app-password
```

Install dotenv for local dev:
```bash
npm install dotenv
```

Then add this as the FIRST line of server.js for local dev only:
```js
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
```

Or just set env vars in your terminal before running:
```bash
export SUPABASE_URL=...
node server.js
```

**NEVER commit .env — it's in .gitignore already.**

---

## STEP 4 — Push to GitHub

```bash
# If you haven't set up git yet:
cd arogya
git init
git add .
git commit -m "Initial commit"

# Create a repo on github.com first, then:
git remote add origin https://github.com/rohith-001-gif/arogya.git
git branch -M main
git push -u origin main

# For future updates:
git add .
git commit -m "your message here"
git push
```

---

## STEP 5 — Deploy on Render

1. Go to https://render.com → **New → Web Service**
2. Connect your GitHub repo
3. Set these settings:
   - **Name:** arogya (or anything)
   - **Branch:** main
   - **Root Directory:** (leave blank)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`

4. Click **Environment** → Add these variables one by one:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | your supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | your service role key |
| `GROQ_API_KEY` | your groq key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` |
| `MAIL_USER` | your gmail (optional) |
| `MAIL_PASS` | gmail app password (optional) |

5. Click **Create Web Service** — Render auto-deploys from GitHub

---

## STEP 6 — Update ESP32 firmware

After Render deploys, your endpoint URL is:
```
https://your-app-name.onrender.com/update?watchID=WCH001&hr=75&spo2=98&steps=200&status=normal
```

Use this in your ESP32 HTTP GET call.

---

## What each env var does

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | ✅ Yes | Connects to your database |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Yes | Full DB access (bypasses RLS) |
| `GROQ_API_KEY` | ⚠️ For chatbot | Powers the AI assistant |
| `GROQ_MODEL` | Optional | AI model name (has default) |
| `MAIL_USER` | Optional | Gmail for critical alerts |
| `MAIL_PASS` | Optional | Gmail App Password |
| `PORT` | Set by Render | Don't set this manually |

---

## Common problems

**Login always fails**
→ Check your `doctors` table has a row with matching email + password
→ Check `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set correctly in Render

**Watches not loading after add**
→ Check Supabase `patients` table exists (run setup SQL again)
→ Check browser console for the actual error message

**Readings not showing**
→ Check ESP32 is hitting `/update` with the correct `watchID` param
→ Check `readings` table in Supabase → Table Editor → see if rows exist

**Render shows "Application failed to respond"**
→ Check Render logs → usually a missing env var
→ Make sure `start command` is `node server.js`

**AI chatbot says "unavailable"**
→ Add `GROQ_API_KEY` in Render environment settings
→ Get a free key at https://console.groq.com/keys
