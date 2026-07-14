const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");

const WEBHOOK_SECRET = "test-webhook-secret";
const WPSENDER_USER_ID = "tenant-tehiru";

let baseUrl;
let child;
let dataDir;
let adminCookie;
let fakeWpsender;
let fakeWpsenderBaseUrl;
let sentWpsenderRequests = [];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/config`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("raffle test server did not start");
}

function sign(body, secret = WEBHOOK_SECRET) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function sendWebhook(payload, signatureSecret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  return fetch(`${baseUrl}/api/integrations/wpsender/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": sign(body, signatureSecret),
    },
    body,
  });
}

function proofEvent() {
  return {
    event: "message.inbound",
    timestamp: "2026-07-14T10:00:00.000Z",
    userId: WPSENDER_USER_ID,
    data: {
      messageId: "proof-message-1",
      from: "972501234567@s.whatsapp.net",
      senderName: "Test Participant",
      text: "",
      mediaType: "imageMessage",
      mimeType: "image/jpeg",
      hasMedia: true,
      timestamp: "2026-07-14T10:00:00.000Z",
    },
  };
}

test.before(async () => {
  const fakeWpsenderPort = await getFreePort();
  fakeWpsenderBaseUrl = `http://127.0.0.1:${fakeWpsenderPort}`;
  fakeWpsender = http.createServer(async (req, res) => {
    if (req.url === "/api/raffle/send"
        && req.method === "POST"
        && req.headers.authorization === "Bearer test-api-key") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      sentWpsenderRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, messageId: `sent-${sentWpsenderRequests.length}` }));
    }
    if (req.url === "/api/raffle/messages/proof-message-1/media"
        && req.headers.authorization === "Bearer test-api-key") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      return res.end("proof-image-bytes");
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => fakeWpsender.listen(fakeWpsenderPort, "127.0.0.1", resolve));

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "raffle-whatsapp-test-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      RAFFLE_DATA_DIR: dataDir,
      WPSENDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
      WPSENDER_USER_ID,
      WPSENDER_BASE_URL: fakeWpsenderBaseUrl,
      WPSENDER_API_KEY: "test-api-key",
      WHATSAPP_FLOW_ENABLED: "true",
      SESSION_SECRET: "test-session-secret",
      ADMIN_USER: "test-admin",
      ADMIN_PASSWORD: "test-password",
    },
    stdio: "ignore",
  });
  await waitForServer(baseUrl);
});

test.after(() => {
  if (child && !child.killed) child.kill();
  if (fakeWpsender) fakeWpsender.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("rejects a WPSender event with an invalid signature", async () => {
  const response = await sendWebhook(proofEvent(), "wrong-secret");
  assert.equal(response.status, 401);
});

test("announces the enabled WhatsApp flow to the public page", async () => {
  const response = await fetch(`${baseUrl}/api/config`);
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.whatsappFlowEnabled, true);
  assert.equal(config.whatsappKeyword, "הגרלה");
});

test("sends the raffle instructions and contact when a participant writes the keyword", async () => {
  const response = await sendWebhook({
    event: "message.inbound",
    timestamp: "2026-07-14T09:30:00.000Z",
    userId: WPSENDER_USER_ID,
    data: {
      messageId: "keyword-message-1",
      from: "972501234567@s.whatsapp.net",
      text: "הגרלה ref=0508888888",
      timestamp: 1700000000,
      mediaType: "conversation",
      mimeType: null,
      hasMedia: false,
    },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, kitSent: true });
  assert.equal(sentWpsenderRequests.length, 2);
  assert.deepEqual(sentWpsenderRequests[0], {
    to: "972501234567",
    type: "text",
    message: sentWpsenderRequests[0].message,
  });
  assert.match(sentWpsenderRequests[0].message, /צילום מסך/);
  assert.deepEqual(sentWpsenderRequests[1], {
    to: "972501234567",
    type: "document",
    buffer: sentWpsenderRequests[1].buffer,
    mimetype: "text/vcard",
    fileName: "contact.vcf",
  });
  assert.match(Buffer.from(sentWpsenderRequests[1].buffer, "base64").toString("utf8"), /BEGIN:VCARD/);
});

test("stores an incoming screenshot as pending review", async () => {
  const response = await sendWebhook(proofEvent());
  assert.equal(response.status, 202);

  const result = await response.json();
  assert.equal(result.status, "pending_review");

  const entries = JSON.parse(fs.readFileSync(path.join(dataDir, "data.json"), "utf8"));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: entries[0].id,
    name: "Test Participant",
    phone: "972501234567",
    referredBy: "972508888888",
    status: "pending_review",
    source: "whatsapp",
    proofMessageId: "proof-message-1",
    proofMimeType: "image/jpeg",
    proofReceivedAt: "2026-07-14T10:00:00.000Z",
    createdAt: entries[0].createdAt,
  });
});

test("treats a repeated WPSender message as idempotent", async () => {
  const response = await sendWebhook(proofEvent());
  assert.equal(response.status, 200);

  const result = await response.json();
  assert.equal(result.duplicate, true);

  const entries = JSON.parse(fs.readFileSync(path.join(dataDir, "data.json"), "utf8"));
  assert.equal(entries.length, 1);
});

test("proxies proof media without exposing the WPSender API key", async () => {
  const loginResponse = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "test-admin", pass: "test-password" }),
  });
  assert.equal(loginResponse.status, 200);
  adminCookie = loginResponse.headers.get("set-cookie").split(";", 1)[0];

  const entries = JSON.parse(fs.readFileSync(path.join(dataDir, "data.json"), "utf8"));
  const response = await fetch(`${baseUrl}/admin/api/entries/${entries[0].id}/proof`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(await response.text(), "proof-image-bytes");
});

test("prevents the legacy web form from bypassing WhatsApp approval", async () => {
  const response = await fetch(`${baseUrl}/api/enter`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Bypass Attempt",
      phone: "0509999999",
      consent: true,
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "whatsapp_flow_required" });
});

test("does not count a pending proof as a raffle ticket", async () => {
  const ticketResponse = await fetch(`${baseUrl}/api/tickets/972501234567`);
  assert.deepEqual(await ticketResponse.json(), { found: false, pending: true });

  const drawResponse = await fetch(`${baseUrl}/admin/api/draw`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(drawResponse.status, 200);
  assert.deepEqual(await drawResponse.json(), { winner: null });
});

test("does not export a pending participant as an approved contact", async () => {
  const vcfResponse = await fetch(`${baseUrl}/admin/export.vcf`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(vcfResponse.status, 200);
  assert.doesNotMatch(await vcfResponse.text(), /972501234567/);

  const csvResponse = await fetch(`${baseUrl}/admin/export.csv`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(csvResponse.status, 200);
  assert.doesNotMatch(await csvResponse.text(), /972501234567/);
});

test("an admin approval turns the verified proof into an eligible entry", async () => {
  const entriesBefore = JSON.parse(fs.readFileSync(path.join(dataDir, "data.json"), "utf8"));
  const entryId = entriesBefore[0].id;

  const approveResponse = await fetch(`${baseUrl}/admin/api/entries/${entryId}/approve`, {
    method: "POST",
    headers: { cookie: adminCookie },
  });
  assert.equal(approveResponse.status, 200);
  assert.deepEqual(await approveResponse.json(), { ok: true, status: "approved" });

  const ticketResponse = await fetch(`${baseUrl}/api/tickets/972501234567`);
  const ticket = await ticketResponse.json();
  assert.equal(ticket.found, true);
  assert.equal(ticket.tickets, 1);

  const drawResponse = await fetch(`${baseUrl}/admin/api/draw`, {
    headers: { cookie: adminCookie },
  });
  const { winner } = await drawResponse.json();
  assert.equal(winner.phone, "972501234567");

  assert.equal(sentWpsenderRequests.length, 3);
  assert.deepEqual(sentWpsenderRequests[2], {
    to: "972501234567",
    type: "text",
    message: sentWpsenderRequests[2].message,
  });
  assert.match(sentWpsenderRequests[2].message, /נכנסת להגרלה/);
});
