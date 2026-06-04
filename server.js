const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE     = path.join(__dirname, "data.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");

/* ---------- הגדרות ---------- */
const CONFIG = {
  businessName:  process.env.BUSINESS_NAME  || "העסק שלי",
  prizeText:     process.env.PRIZE_TEXT     || "פרס שווה במיוחד 🎁",
  channelUrl:    process.env.CHANNEL_URL    || "https://whatsapp.com/channel/test",
  clientName:    process.env.CLIENT_NAME    || "שם הלקוח",
  clientPhone:   process.env.CLIENT_PHONE   || "972586904058",
  contactPrefix: process.env.CONTACT_PREFIX || "הגרלה",
  adminUser:     process.env.ADMIN_USER     || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin1234",
};

try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  Object.assign(CONFIG, saved);
} catch {}

/* ---------- אחסון ---------- */
function readEntries() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}
function writeEntries(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

/* ---------- נירמול טלפון ---------- */
function normalizePhone(raw) {
  let p = String(raw).replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "972" + p.slice(1);
  return p;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "raffle-secret-key-2024",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 שעות
}));

/* ============================================================
   צד ציבורי
   ============================================================ */
app.get("/api/config", (req, res) => {
  res.json({
    businessName: CONFIG.businessName,
    prizeText:    CONFIG.prizeText,
    channelUrl:   CONFIG.channelUrl,
    clientName:   CONFIG.clientName,
    clientPhone:  CONFIG.clientPhone,
  });
});

app.post("/api/enter", (req, res) => {
  const { name, phone, consent, ref } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "יש למלא שם וטלפון" });
  if (!consent)        return res.status(400).json({ error: "יש לאשר את התקנון" });

  const cleanPhone = normalizePhone(phone);
  if (cleanPhone.length < 11) return res.status(400).json({ error: "מספר טלפון לא תקין" });

  const entries = readEntries();
  if (entries.some((e) => e.phone === cleanPhone)) {
    return res.json({ ok: true, duplicate: true, phone: cleanPhone });
  }

  const cleanRef = ref ? normalizePhone(String(ref)) : null;
  entries.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name).trim().slice(0, 80),
    phone: cleanPhone,
    referredBy: (cleanRef && cleanRef !== cleanPhone) ? cleanRef : null,
    createdAt: new Date().toISOString(),
  });
  writeEntries(entries);
  res.json({ ok: true, phone: cleanPhone });
});

// ספירת הפניות של משתתף
app.get("/api/referrals/:phone", (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const entries = readEntries();
  const count = entries.filter(e => e.referredBy === phone).length;
  res.json({ count });
});

// בדיקת כרטיסים ציבורית לפי טלפון
app.get("/api/tickets/:phone", (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const entries = readEntries();
  const me = entries.find(e => e.phone === phone);
  if (!me) return res.json({ found: false });
  const referrals = entries.filter(e => e.referredBy === phone).length;
  res.json({ found: true, name: me.name, tickets: 1 + referrals, referrals });
});

app.get("/contact.vcf", (req, res) => {
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0",
    `N:;${CONFIG.clientName};;;`,
    `FN:${CONFIG.clientName}`,
    `TEL;TYPE=CELL:+${CONFIG.clientPhone}`,
    "END:VCARD", "",
  ].join("\r\n");
  res.setHeader("Content-Type", "text/vcard; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="contact.vcf"');
  res.send(vcf);
});

/* ============================================================
   התחברות
   ============================================================ */
app.get("/admin/login", (req, res) => {
  if (req.session.admin) return res.redirect("/admin");
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.post("/admin/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (user === CONFIG.adminUser && pass === CONFIG.adminPassword) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "שגיאה" });
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/admin/login");
});

/* ---------- middleware הגנה ---------- */
function auth(req, res, next) {
  if (req.session.admin) return next();
  res.redirect("/admin/login");
}

/* ============================================================
   אזור ניהול
   ============================================================ */
app.get("/admin", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin.html"));
});

app.get("/admin/api/entries", auth, (req, res) => {
  res.json(readEntries().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.delete("/admin/api/entries/:id", auth, (req, res) => {
  writeEntries(readEntries().filter((e) => e.id !== req.params.id));
  res.json({ ok: true });
});

app.get("/admin/api/draw", auth, (req, res) => {
  const entries = readEntries();
  if (!entries.length) return res.json({ winner: null });

  // בניית "קלפי הגרלה" משוקללים — כרטיס אחד לכל הפניה
  const refMap = {};
  for (const e of entries) {
    if (e.referredBy) refMap[e.referredBy] = (refMap[e.referredBy] || 0) + 1;
  }
  const pool = [];
  for (const e of entries) {
    const tickets = 1 + (refMap[e.phone] || 0);
    for (let i = 0; i < tickets; i++) pool.push(e);
  }
  const winner = pool[Math.floor(Math.random() * pool.length)];
  const winnerTickets = 1 + (refMap[winner.phone] || 0);
  res.json({ winner: { ...winner, tickets: winnerTickets } });
});

app.get("/admin/api/settings", auth, (req, res) => {
  res.json({
    businessName:  CONFIG.businessName,
    prizeText:     CONFIG.prizeText,
    channelUrl:    CONFIG.channelUrl,
    clientName:    CONFIG.clientName,
    clientPhone:   CONFIG.clientPhone,
    contactPrefix: CONFIG.contactPrefix,
    adminPassword: CONFIG.adminPassword,
  });
});

app.post("/admin/api/settings", auth, (req, res) => {
  const allowed = ["businessName","prizeText","channelUrl","clientName","clientPhone","contactPrefix","adminPassword"];
  for (const key of allowed) {
    if (req.body[key] !== undefined && String(req.body[key]).trim() !== "") {
      CONFIG[key] = String(req.body[key]).trim();
    }
  }
  if (req.body.clientPhone) CONFIG.clientPhone = normalizePhone(CONFIG.clientPhone);

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(
    Object.fromEntries(allowed.map(k => [k, CONFIG[k]])), null, 2
  ));
  res.json({ ok: true });
});

app.get("/admin/export.vcf", auth, (req, res) => {
  const entries = readEntries();
  const vcf = entries.map((e) => [
    "BEGIN:VCARD", "VERSION:3.0",
    `N:;${CONFIG.contactPrefix} ${e.name};;;`,
    `FN:${CONFIG.contactPrefix} ${e.name}`,
    `TEL;TYPE=CELL:+${e.phone}`,
    "END:VCARD",
  ].join("\r\n")).join("\r\n");
  res.setHeader("Content-Type", "text/vcard; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="raffle-contacts.vcf"');
  res.send(vcf + "\r\n");
});

app.get("/admin/export.csv", auth, (req, res) => {
  const entries = readEntries();
  const rows = [["שם", "טלפון", "תאריך"]].concat(
    entries.map((e) => [e.name, e.phone, new Date(e.createdAt).toLocaleString("he-IL")])
  );
  const csv = "﻿" + rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="raffle-entries.csv"');
  res.send(csv);
});

app.listen(PORT, () => console.log(`Raffle app running on http://localhost:${PORT}`));
