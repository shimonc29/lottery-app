/**
 * דף הגרלה + דאשבורד ניהול
 * אין כאן שום חיבור לוואטסאפ - הכל מבוסס לינקים וטופס.
 * אחסון: קובץ data.json מקומי (קל מאוד להחליף ל-Postgres בהמשך).
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/* ============================================================
   הגדרות - מומלץ להזין ב-Replit תחת "Secrets" (Environment variables).
   מה שלא מוגדר שם, ייקח את ברירת המחדל שכאן.
   ============================================================ */
const CONFIG = {
  businessName:  process.env.BUSINESS_NAME  || "העסק שלי",
  prizeText:     process.env.PRIZE_TEXT     || "פרס שווה במיוחד 🎁",
  channelUrl:    process.env.CHANNEL_URL    || "https://whatsapp.com/channel/test",
  clientName:    process.env.CLIENT_NAME    || "שם הלקוח",
  clientPhone:   process.env.CLIENT_PHONE   || "972586904058",
  contactPrefix: process.env.CONTACT_PREFIX || "הגרלה",        // קידומת לשם איש הקשר בייצוא (לניקוי קל בהמשך)
  adminUser:     process.env.ADMIN_USER     || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "changeme123",  // !!! חובה לשנות !!!
};

const DATA_FILE = path.join(__dirname, "data.json");

/* ---------- אחסון JSON פשוט ---------- */
function readEntries() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return []; }
}
function writeEntries(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

/* ---------- נירמול מספר טלפון ישראלי לפורמט בינלאומי ---------- */
function normalizePhone(raw) {
  let p = String(raw).replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "972" + p.slice(1); // 05X... -> 9725X...
  return p;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ============================================================
   צד ציבורי
   ============================================================ */

// הגדרות ציבוריות לדף הנחיתה
app.get("/api/config", (req, res) => {
  res.json({
    businessName: CONFIG.businessName,
    prizeText:    CONFIG.prizeText,
    channelUrl:   CONFIG.channelUrl,
    clientName:   CONFIG.clientName,
    clientPhone:  CONFIG.clientPhone,
  });
});

// כניסה להגרלה
app.post("/api/enter", (req, res) => {
  const { name, phone, consent } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "יש למלא שם וטלפון" });
  if (!consent)        return res.status(400).json({ error: "יש לאשר את התקנון" });

  const cleanPhone = normalizePhone(phone);
  if (cleanPhone.length < 11) return res.status(400).json({ error: "מספר טלפון לא תקין" });

  const entries = readEntries();
  if (entries.some((e) => e.phone === cleanPhone)) {
    return res.json({ ok: true, duplicate: true });
  }
  entries.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name).trim().slice(0, 80),
    phone: cleanPhone,
    createdAt: new Date().toISOString(),
  });
  writeEntries(entries);
  res.json({ ok: true });
});

// vCard של הלקוח - שלב "שמירת המספר" בלחיצה אחת
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
   אזור ניהול (מוגן בסיסמה)
   ============================================================ */
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const [type, b64] = h.split(" ");
  if (type === "Basic" && b64) {
    const [u, p] = Buffer.from(b64, "base64").toString().split(":");
    if (u === CONFIG.adminUser && p === CONFIG.adminPassword) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
  res.status(401).send("דרושה הזדהות");
}

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

// הגרלת זוכה אקראי
app.get("/admin/api/draw", auth, (req, res) => {
  const entries = readEntries();
  if (!entries.length) return res.json({ winner: null });
  res.json({ winner: entries[Math.floor(Math.random() * entries.length)] });
});

// ייצוא כל המשתתפים כ-vCard אחד - לייבוא מרוכז לטלפון של הלקוח
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

// ייצוא CSV (לאקסל)
app.get("/admin/export.csv", auth, (req, res) => {
  const entries = readEntries();
  const rows = [["שם", "טלפון", "תאריך"]].concat(
    entries.map((e) => [e.name, e.phone, new Date(e.createdAt).toLocaleString("he-IL")])
  );
  const csv = "\uFEFF" + rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="raffle-entries.csv"');
  res.send(csv);
});

app.listen(PORT, () => console.log(`Raffle app running on http://localhost:${PORT}`));
