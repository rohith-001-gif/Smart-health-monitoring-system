-- ============================================================
-- Arogya – Supabase Table Setup
-- Run this ONCE in Supabase → SQL Editor → New Query
-- ============================================================

-- 1. Doctors
create table if not exists doctors (
  id         bigint generated always as identity primary key,
  email      text unique not null,
  password   text not null,           -- store plaintext for now (upgrade to hashed later)
  created_at timestamptz default now()
);

-- 2. Patients  (replaces patients.json)
create table if not exists patients (
  watch_id     text primary key,      -- e.g. "WCH001", always uppercase
  name         text not null,
  email        text not null,
  doctor_email text not null,
  age          text default '',
  condition    text default '',
  phone        text default '',
  created_at   timestamptz default now()
);

-- 3. Readings  (replaces readings.json)
create table if not exists readings (
  id       bigint generated always as identity primary key,
  watch_id text not null,
  hr       numeric default 0,
  spo2     numeric default 0,
  steps    numeric default 0,
  status   text default 'normal',
  time     timestamptz not null,
  created_at timestamptz default now()
);

-- Index so queries by watch_id + time are fast
create index if not exists idx_readings_watch_time on readings (watch_id, time);

-- 4. Reminders  (already existed — recreate if needed)
create table if not exists reminders (
  id            bigint generated always as identity primary key,
  watch_id      text not null,
  medicine_name text not null,
  time          text not null,         -- e.g. "08:30"
  repeat_days   text not null,         -- e.g. "Daily" or "Mon,Wed,Fri"
  doctor_email  text not null,
  created_at    timestamptz default now()
);

-- ============================================================
-- Add your first doctor account (change the values!)
-- ============================================================
-- insert into doctors (email, password) values ('doctor@example.com', 'yourpassword123');
