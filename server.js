const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.params.slot + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR      = process.env.RAFFLE_DATA_DIR || UPLOADS_DIR;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE     = path.join(DATA_DIR, "data.json");
const WHATSAPP_INTENTS_FILE = path.join(DATA_DIR, "whatsapp-intents.json");
const SETTINGS_FILE = path.join(UPLOADS_DIR, "settings.json");

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
  drawDate:      process.env.DRAW_DATE      || "ההגרלה תתקיים ביום ראשון 19 ליולי בסטטוס של קרן תכירו",
  heroImage:     process.env.HERO_IMAGE     || "",
  shareMedia:    process.env.SHARE_MEDIA    || "",
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
function readWhatsappIntents() {
  try { return JSON.parse(fs.readFileSync(WHATSAPP_INTENTS_FILE, "utf8")); }
  catch { return []; }
}
function writeWhatsappIntents(list) {
  fs.writeFileSync(WHATSAPP_INTENTS_FILE, JSON.stringify(list, null, 2));
}
function updateWhatsappIntent(phone, updates) {
  const intents = readWhatsappIntents();
  const intent = intents.find((item) => item.phone === phone);
  if (!intent) return null;
  Object.assign(intent, updates, { updatedAt: new Date().toISOString() });
  writeWhatsappIntents(intents);
  return intent;
}
function whatsappIntentState(intent) {
  return intent?.state || (intent ? "awaiting_saved" : null);
}

// Entries created before the WhatsApp approval flow have no status and remain eligible.
function isApprovedEntry(entry) {
  return !entry.status || entry.status === "approved";
}

/* ---------- נירמול טלפון ---------- */
function normalizePhone(raw) {
  let p = String(raw).replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "972" + p.slice(1);
  return p;
}

app.use(express.json({
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));
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
    drawDate:     CONFIG.drawDate,
    heroImage:    CONFIG.heroImage,
    shareMedia:   CONFIG.shareMedia,
    whatsappFlowEnabled: process.env.WHATSAPP_FLOW_ENABLED === "true",
    whatsappKeyword: process.env.WPSENDER_RAFFLE_KEYWORD || "הגרלה",
  });
});

app.post("/api/enter", (req, res) => {
  if (process.env.WHATSAPP_FLOW_ENABLED === "true") {
    return res.status(409).json({ error: "whatsapp_flow_required" });
  }
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
  const count = entries.filter(e => isApprovedEntry(e) && e.referredBy === phone).length;
  res.json({ count });
});

// בדיקת כרטיסים ציבורית לפי טלפון
app.get("/api/tickets/:phone", (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const entries = readEntries();
  const me = entries.find(e => e.phone === phone);
  if (!me) return res.json({ found: false });
  if (!isApprovedEntry(me)) return res.json({ found: false, pending: true });
  const referrals = entries.filter(e => isApprovedEntry(e) && e.referredBy === phone).length;
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
   WPSender integration (disabled unless explicitly enabled)
   ============================================================ */
function hasValidWpsenderSignature(req) {
  const secret = process.env.WPSENDER_WEBHOOK_SECRET;
  const received = req.get("x-webhook-signature") || "";
  if (!secret || !received || !req.rawBody) return false;

  const expected = require("crypto")
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  return expectedBuffer.length === receivedBuffer.length
    && require("crypto").timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function sendViaWpsender(body) {
  const baseUrl = String(process.env.WPSENDER_BASE_URL || "").replace(/\/$/, "");
  const apiKey = process.env.WPSENDER_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("WPSender is not configured");

  const response = await fetch(`${baseUrl}/api/raffle/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`WPSender send failed (${response.status})`);
  return response.json();
}

function getShareMediaUrl() {
  const configured = String(CONFIG.shareMedia || "").trim();
  if (!configured || /^https?:\/\//i.test(configured)) return configured;
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required for relative raffle media");
  return new URL(configured, `${publicBaseUrl}/`).toString();
}

async function sendRaffleContact(phone) {
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0",
    `N:;${CONFIG.clientName};;;`,
    `FN:${CONFIG.clientName}`,
    `TEL;TYPE=CELL:+${CONFIG.clientPhone}`,
    "END:VCARD", "",
  ].join("\r\n");
  await sendViaWpsender({
    to: phone,
    type: "document",
    buffer: Buffer.from(vcf, "utf8").toString("base64"),
    mimetype: "text/vcard",
    fileName: "contact.vcf",
  });
}

async function sendRaffleMedia(phone) {
  if (!CONFIG.shareMedia) throw new Error("Raffle media is not configured");
  const mediaUrl = getShareMediaUrl();
  const extension = path.extname(new URL(mediaUrl).pathname).toLowerCase();
  const imageMimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const videoMimeTypes = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".3gp": "video/3gpp",
  };
  const mimeType = imageMimeTypes[extension] || videoMimeTypes[extension] || "video/mp4";
  await sendViaWpsender({
    to: phone,
    type: mimeType.startsWith("image/") ? "image" : "video",
    mediaUrl,
    mimetype: mimeType.split(";", 1)[0],
    caption: `שתפו בסטטוס כדי להשתתף בהגרלה של ${CONFIG.businessName}`,
  });
}

app.post("/api/integrations/wpsender/events", async (req, res) => {
  if (process.env.WHATSAPP_FLOW_ENABLED !== "true") return res.sendStatus(404);
  if (!hasValidWpsenderSignature(req)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const payload = req.body || {};
  const data = payload.data || {};
  if (payload.userId !== process.env.WPSENDER_USER_ID) {
    return res.status(403).json({ error: "unexpected tenant" });
  }
  const senderJid = String(data.from || "");
  if (!senderJid.endsWith("@s.whatsapp.net")) {
    return res.status(202).json({ ok: true, ignored: true });
  }
  const raffleKeyword = process.env.WPSENDER_RAFFLE_KEYWORD || "הגרלה";
  const inboundText = String(data.text || "").trim();
  const phone = normalizePhone(senderJid.split("@")[0]);
  if (phone.length < 11) return res.status(400).json({ error: "invalid sender phone" });
  const messageId = data.messageId ? String(data.messageId) : null;

  if (payload.event === "message.inbound" && !data.hasMedia) {
    const isRaffleKeyword = inboundText === raffleKeyword
      || inboundText.startsWith(`${raffleKeyword} `);
    let intents = readWhatsappIntents();
    let intent = intents.find((item) => item.phone === phone);
    let intentState = whatsappIntentState(intent);

    if (isRaffleKeyword) {
      if (readEntries().some((entry) => entry.phone === phone)) {
        return res.json({ ok: true, alreadyEntered: true });
      }
      if (intentState === "contact_sent" && intent?.messageId === messageId) {
        try {
          await sendViaWpsender({
            to: phone,
            type: "text",
            message: "איש הקשר נשלח. שמרו אותו בטלפון, וכשסיימתם שלחו כאן את המילה שמרתי.",
          });
          updateWhatsappIntent(phone, { state: "awaiting_saved" });
          return res.status(202).json({ ok: true, contactSent: true, next: "awaiting_saved" });
        } catch {
          return res.status(502).json({ error: "raffle contact instruction failed" });
        }
      }
      if (intent) {
        return res.json({
          ok: true,
          duplicate: intent.messageId === messageId,
          alreadyStarted: intent.messageId !== messageId,
          next: intentState,
        });
      }

      const referralMatch = inboundText.match(/\bref=([+\d()-]+)/i);
      const referredBy = referralMatch ? normalizePhone(referralMatch[1]) : null;
      intent = {
        phone,
        referredBy: referredBy && referredBy !== phone ? referredBy : null,
        messageId,
        state: "sending_contact",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      intents.push(intent);
      writeWhatsappIntents(intents);
      try {
        await sendRaffleContact(phone);
        updateWhatsappIntent(phone, { state: "contact_sent" });
        await sendViaWpsender({
          to: phone,
          type: "text",
          message: "איש הקשר נשלח. שמרו אותו בטלפון, וכשסיימתם שלחו כאן את המילה שמרתי.",
        });
        updateWhatsappIntent(phone, { state: "awaiting_saved" });
        return res.status(202).json({ ok: true, contactSent: true, next: "awaiting_saved" });
      } catch {
        const current = readWhatsappIntents().find((item) => item.phone === phone);
        if (current?.state === "sending_contact") {
          writeWhatsappIntents(readWhatsappIntents().filter((item) => item.phone !== phone));
        }
        return res.status(502).json({ error: "raffle contact delivery failed" });
      }
    }

    if (inboundText === "שמרתי" && intent) {
      if (intentState === "sending_media") {
        return res.json({ ok: true, duplicate: true, next: "sending_media" });
      }
      if (intentState === "media_sent") {
        try {
          await sendViaWpsender({
            to: phone,
            type: "text",
            message: "הקובץ נשלח. העלו אותו לסטטוס, וכשסיימתם שלחו כאן את המילה שיתפתי.",
          });
          updateWhatsappIntent(phone, { state: "awaiting_shared" });
          return res.status(202).json({ ok: true, mediaSent: true, next: "awaiting_shared" });
        } catch {
          return res.status(502).json({ error: "raffle media instruction failed" });
        }
      }
      if (intentState !== "awaiting_saved") {
        return res.json({ ok: true, alreadyAdvanced: true, next: intentState });
      }
      updateWhatsappIntent(phone, { state: "sending_media", messageId });
      try {
        await sendRaffleMedia(phone);
        updateWhatsappIntent(phone, { state: "media_sent" });
        await sendViaWpsender({
          to: phone,
          type: "text",
          message: "הקובץ נשלח. העלו אותו לסטטוס, וכשסיימתם שלחו כאן את המילה שיתפתי.",
        });
        updateWhatsappIntent(phone, { state: "awaiting_shared" });
        return res.status(202).json({ ok: true, mediaSent: true, next: "awaiting_shared" });
      } catch {
        const current = readWhatsappIntents().find((item) => item.phone === phone);
        if (current?.state === "sending_media") {
          updateWhatsappIntent(phone, { state: "awaiting_saved" });
        }
        return res.status(502).json({ error: "raffle media delivery failed" });
      }
    }

    if (inboundText === "שיתפתי" && intent) {
      if (intentState === "sending_proof_prompt") {
        return res.json({ ok: true, duplicate: true, next: "sending_proof_prompt" });
      }
      if (intentState !== "awaiting_shared") {
        return res.json({ ok: true, alreadyAdvanced: true, next: intentState });
      }
      updateWhatsappIntent(phone, { state: "sending_proof_prompt", messageId });
      try {
        await sendViaWpsender({
          to: phone,
          type: "text",
          message: "מצוין! עכשיו אנחנו מחכים לצילום מסך שמראה שהסטטוס פעיל. שלחו אותו כאן לבדיקה.",
        });
        updateWhatsappIntent(phone, { state: "awaiting_proof" });
        return res.status(202).json({ ok: true, next: "awaiting_proof" });
      } catch {
        updateWhatsappIntent(phone, { state: "awaiting_shared" });
        return res.status(502).json({ error: "raffle proof instruction failed" });
      }
    }

    return res.status(202).json({ ok: true, ignored: true });
  }

  if (payload.event !== "message.inbound" || !data.hasMedia || data.mediaType !== "imageMessage") {
    return res.status(202).json({ ok: true, ignored: true });
  }
  if (!messageId) {
    return res.status(400).json({ error: "missing message data" });
  }

  const entries = readEntries();
  if (entries.some((entry) => entry.proofMessageId === messageId)) {
    return res.json({ ok: true, duplicate: true });
  }

  const intents = readWhatsappIntents();
  const intent = intents.find((item) => item.phone === phone);
  if (whatsappIntentState(intent) !== "awaiting_proof") {
    return res.status(202).json({ ok: true, ignored: true });
  }

  const existing = entries.find((entry) => entry.phone === phone);
  const proofReceivedAt = data.timestamp || payload.timestamp || new Date().toISOString();
  if (existing) {
    existing.proofMessageId = messageId;
    existing.proofMimeType = data.mimeType || null;
    existing.proofReceivedAt = proofReceivedAt;
    existing.source = existing.source || "whatsapp";
    if (existing.status && existing.status !== "approved") existing.status = "pending_review";
  } else {
    entries.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(data.senderName || phone).trim().slice(0, 80),
      phone,
      referredBy: intent?.referredBy || null,
      status: "pending_review",
      source: "whatsapp",
      proofMessageId: messageId,
      proofMimeType: data.mimeType || null,
      proofReceivedAt,
      createdAt: new Date().toISOString(),
    });
  }
  writeEntries(entries);
  writeWhatsappIntents(intents.filter((item) => item.phone !== phone));
  try {
    await sendViaWpsender({
      to: phone,
      type: "text",
      message: "קיבלנו את צילום המסך. הוא ממתין לבדיקה, ואחרי האישור נשלח לך את מספר הכרטיסים וקישור השיתוף האישי.",
    });
  } catch (error) {
    console.error("Proof stored, but pending-review message failed:", error.message);
  }
  return res.status(202).json({ ok: true, status: existing?.status || "pending_review" });
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

app.get("/admin/api/entries/:id/proof", auth, async (req, res) => {
  const entry = readEntries().find((item) => item.id === req.params.id);
  if (!entry || !entry.proofMessageId) {
    return res.status(404).json({ error: "proof not found" });
  }
  const baseUrl = String(process.env.WPSENDER_BASE_URL || "").replace(/\/$/, "");
  const apiKey = process.env.WPSENDER_API_KEY;
  if (!baseUrl || !apiKey) {
    return res.status(503).json({ error: "proof service is not configured" });
  }

  try {
    const response = await fetch(
      `${baseUrl}/api/raffle/messages/${encodeURIComponent(entry.proofMessageId)}/media`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return res.status(502).json({ error: "proof service failed" });

    const contentType = response.headers.get("content-type") || entry.proofMimeType || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.status(502).json({ error: "proof service unavailable" });
  }
});

app.post("/admin/api/entries/:id/approve", auth, async (req, res) => {
  const entries = readEntries();
  const entry = entries.find((item) => item.id === req.params.id);
  if (!entry) return res.status(404).json({ error: "entry not found" });
  if (entry.status === "approving") {
    return res.status(409).json({ error: "approval already in progress" });
  }
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!publicBaseUrl) return res.status(503).json({ error: "public URL is not configured" });
  const referrals = entries.filter((item) => isApprovedEntry(item) && item.referredBy === entry.phone).length;
  const tickets = 1 + referrals;
  const previousStatus = entry.status || "pending_review";
  entry.status = "approving";
  writeEntries(entries);
  try {
    await sendViaWpsender({
      to: entry.phone,
      type: "text",
      message: `אושר! ${entry.name || ""}, אתה בהגרלה של ${CONFIG.businessName}!\nכרטיסים: ${tickets}\nבדיקת כרטיסים: ${publicBaseUrl}/?check=${entry.phone}#check-card\nקישור השיתוף שלך: ${publicBaseUrl}/?ref=${entry.phone}`,
    });
    entry.status = "approved";
    entry.approvedAt = new Date().toISOString();
    entry.confirmationSentAt = new Date().toISOString();
    writeEntries(entries);
  } catch (error) {
    entry.status = previousStatus;
    writeEntries(entries);
    return res.status(502).json({ error: "approval confirmation failed" });
  }
  res.json({ ok: true, status: entry.status });
});

app.get("/admin/api/draw", auth, (req, res) => {
  const entries = readEntries().filter(isApprovedEntry);
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
    drawDate:      CONFIG.drawDate,
    heroImage:     CONFIG.heroImage,
    shareMedia:    CONFIG.shareMedia,
  });
});

// העלאת קובץ (תמונה/סרטון)
app.post("/admin/upload/:slot", auth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "לא הועלה קובץ" });
  const url = "/uploads/" + req.file.filename;
  // שמור ב-CONFIG ובקובץ
  const slot = req.params.slot; // "heroImage" או "shareMedia"
  if (!["heroImage","shareMedia"].includes(slot)) return res.status(400).json({ error: "slot לא תקין" });
  CONFIG[slot] = url;
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    saved[slot] = url;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(saved, null, 2));
  } catch {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ [slot]: url }, null, 2));
  }
  res.json({ ok: true, url });
});

app.post("/admin/api/settings", auth, (req, res) => {
  const allowed = ["businessName","prizeText","channelUrl","clientName","clientPhone","contactPrefix","adminPassword","drawDate","heroImage","shareMedia"];
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
  const entries = readEntries().filter(isApprovedEntry);
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
  const entries = readEntries().filter(isApprovedEntry);
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
