/**
 * Ashgrove Vaka Dosyası — Çözüm
 * ------------------------------------------------------------
 * Sıfır bağımlılık: sadece Node.js'in yerleşik http modülü.
 * (npm install gerekmiyor — deploy sırasında bağımlılık riski yok.)
 *
 *   /events/*     -> Servis 1: Platform olay yayıcısı ve alıcısı
 *   /crm/*        -> Servis 2: CRM mock'u (HubSpot benzeri)
 *   /campaign/*   -> Servis 3: Kampanya listesi ucu
 *   (dahili)       -> reconcile(): eşleştirme + karar + governance
 *   /dashboard     -> Host edilmiş ekran
 *   /demo/scenario/:name -> Bölüm 8'deki 6 zorunlu senaryo, tek istekle
 */

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "demo-secret-change-me";
const PORT = process.env.PORT || 3000;
// Sonuç kodu bu süre içinde hiç gelmezse çağrı "belirsiz" statüsüne düşer
// ve insan onay kuyruğuna işaretlenir (demo hızlı görünsün diye 20 sn).
const NO_DISPOSITION_TIMEOUT_MS = 20 * 1000;

// ---------------------------------------------------------------
// In-memory "veritabanı" (demo amaçlı — gerçek projede Postgres/Redis)
// ---------------------------------------------------------------
const db = {
  contacts: {},
  deals: {},
  activities: [],
  events: [],
  processedEventIds: new Set(),
  calls: {},
  suppressed: new Set(),
  reviewQueue: [],
  contactIdByCallId: {},
};

function seedDemoData() {
  const contactId = "HS-88214";
  const dealId = "DEAL-88214";
  db.contacts[contactId] = { id: contactId, name: "Jane Doe (demo hasta)" };
  db.deals[dealId] = {
    id: dealId,
    contact_id: contactId,
    dealstage: "new_lead",
    lastmodifieddate: new Date().toISOString(),
    history: [],
  };
  db.contactIdByCallId["CL-2609-3318"] = contactId;
}
seedDemoData();

function findDealByContactId(contactId) {
  return Object.values(db.deals).find((d) => d.contact_id === contactId);
}

function sign(body) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(JSON.stringify(body)).digest("hex");
}

// =================================================================
// ÜST KATMAN — Eşleştirme, bastırma, governance
// =================================================================

const CONFLICT_PATTERNS = /(book|randevu|reservation|rezervasyon)/i;
const NEGATIVE_CODES = new Set(["NO_ANSWER", "ANSWERING_MACHINE", "WRONG_NUMBER", "COULD_NOT_CONNECT"]);
const CODE_TO_STAGE = {
  CONSULTATION_BOOKED: "positive",
  NOT_INTERESTED: "negative",
  CALLBACK: "callback",
  NO_ANSWER: "new_lead",
  ANSWERING_MACHINE: "new_lead",
  WRONG_NUMBER: "negative",
  COULD_NOT_CONNECT: "new_lead",
};

function reconcile(event) {
  const call = db.calls[event.call_id] || { call_id: event.call_id };
  call.finish_code = event.finish_code;
  call.agent_note = event.agent_note || null;
  call.disposition_at = event.occurred_at;
  call.status = "disposition_received";
  db.calls[event.call_id] = call;

  const contactId = call.crm_contact_id || db.contactIdByCallId[event.call_id];
  const deal = contactId && findDealByContactId(contactId);
  if (!deal) {
    db.reviewQueue.push({ reason: "deal_bulunamadi", call_id: event.call_id, at: new Date().toISOString() });
    return;
  }

  const conflict =
    call.finish_code &&
    NEGATIVE_CODES.has(call.finish_code) &&
    call.agent_note &&
    CONFLICT_PATTERNS.test(call.agent_note);

  if (conflict) {
    db.reviewQueue.push({
      reason: "not_kod_celiskisi",
      call_id: event.call_id,
      deal_id: deal.id,
      finish_code: call.finish_code,
      agent_note: call.agent_note,
      llm_suggestion: "CONSULTATION_BOOKED (nottan çıkarım) — insan onayı gerekli",
      at: new Date().toISOString(),
    });
    return; // otomatik stage değişikliği yok — governance kuralı
  }

  if (!call.finish_code) {
    return; // sonuç kodu hiç gelmedi — no-disposition senaryosu
  }

  const targetStage = CODE_TO_STAGE[call.finish_code] || "callback";
  patchDeal(deal.id, {
    dealstage: targetStage,
    ccs_finish_code: call.finish_code,
    ccs_call_id: event.call_id,
    ccs_changed_by: "reconciliation-engine",
    ccs_change_reason: `disposition.selected: ${call.finish_code}`,
  });

  if (targetStage === "positive") {
    db.suppressed.add(deal.id);
  }
}

function patchDeal(dealId, patch, retry = true) {
  const deal = db.deals[dealId];
  if (!deal) return { status: 404 };

  const already = deal.history.some(
    (h) => h.ccs_call_id === patch.ccs_call_id && h.ccs_finish_code === patch.ccs_finish_code
  );
  if (already) return { status: 200, noop: true, deal };

  if (retry && Math.random() < 0.1) {
    deal.lastmodifieddate = new Date().toISOString();
    return patchDeal(dealId, patch, false);
  }

  deal.dealstage = patch.dealstage;
  deal.lastmodifieddate = new Date().toISOString();
  deal.history.push({ ...patch, at: deal.lastmodifieddate });
  db.activities.push({
    contact_id: deal.contact_id,
    call_id: patch.ccs_call_id,
    outcome: patch.ccs_finish_code,
    note: patch.ccs_change_reason,
    occurred_at: new Date().toISOString(),
  });
  return { status: 200, deal };
}

// /crm/objects/deals/:id PATCH ile birebir aynı kural seti (409 + governance
// zorunluluğu). Hem gerçek HTTP route'u hem de conflict-409 demo senaryosu
// bunu kullanır, böylece demo gerçek uçla birebir aynı davranışı sergiler.
function crmPatchDeal(id, body) {
  const deal = db.deals[id];
  if (!deal) return { status: 404, body: { error: "not found" } };
  if (body.expected_lastmodifieddate && body.expected_lastmodifieddate !== deal.lastmodifieddate) {
    return { status: 409, body: { error: "conflict", current: deal } };
  }
  if (!body.ccs_changed_by || !body.ccs_change_reason) {
    return { status: 400, body: { error: "ccs_changed_by ve ccs_change_reason zorunlu (denetim şartı)" } };
  }
  const result = patchDeal(deal.id, body);
  return { status: result.status, body: result.deal || deal };
}

function deliverWebhook(event) {
  if (db.processedEventIds.has(event.event_id) && event.__forceRedeliver !== true) {
    return { duplicate: true };
  }
  db.processedEventIds.add(event.event_id);
  if (event.type === "disposition.selected") reconcile(event);
  return { ok: true };
}

// Sonuç kodu hiç gelmeyen çağrıları düzenli aralıklarla tarar; zaman aşımına
// uğrayanları "belirsiz" statüsüne düşürür ve insan onay kuyruğuna ekler.
// Bu, Bölüm 8'deki "sonuç kodu hiç gelmez" senaryosunun gerçek davranışıdır —
// sessizce sonsuza kadar beklemek yerine görünür/izlenebilir hale gelir.
function sweepStaleCalls() {
  const now = Date.now();
  for (const call of Object.values(db.calls)) {
    if (call.status !== "awaiting_disposition") continue;
    if (call.sweptToReview) continue;
    const endedAt = new Date(call.call_ended_at).getTime();
    if (now - endedAt < NO_DISPOSITION_TIMEOUT_MS) continue;

    call.status = "belirsiz";
    call.sweptToReview = true;
    db.reviewQueue.push({
      reason: "sonuc_kodu_gelmedi",
      call_id: call.call_id,
      at: new Date().toISOString(),
    });
    // Not: deal bilerek New Lead'de bırakılır — sonuç bilinmediği için
    // hastanın tekrar aranması doğru davranıştır; ama artık görünür ve
    // insan onayına düşmüş durumda, sessizce kaybolmuyor.
  }
}
setInterval(sweepStaleCalls, 2000);

// =================================================================
// DEMO SENARYOLARI
// =================================================================

function emit(type, body) {
  const event = {
    event_id: "ev_" + crypto.randomUUID(),
    call_id: body.call_id,
    occurred_at: new Date().toISOString(),
    agent_id: "AG-114",
    type,
    ...body,
  };
  db.events.push(event);
  if (type === "call.ended") {
    db.calls[body.call_id] = {
      call_id: body.call_id,
      crm_contact_id: body.crm_contact_id,
      status: "awaiting_disposition",
      call_ended_at: event.occurred_at,
      finish_code: null,
      agent_note: null,
    };
  }
  deliverWebhook(event);
  return event;
}

function runScenario(name, res) {
  const callId = "CL-DEMO-" + Date.now();
  const contactId = "HS-88214";

  switch (name) {
    case "clean-flow":
      emit("call.ended", { call_id: callId, crm_contact_id: contactId });
      emit("disposition.selected", { call_id: callId, finish_code: "CONSULTATION_BOOKED", agent_note: "booked Thursday 2pm" });
      break;
    case "no-disposition":
      emit("call.ended", { call_id: callId, crm_contact_id: contactId });
      break;
    case "late-disposition":
      emit("call.ended", { call_id: callId, crm_contact_id: contactId });
      setTimeout(() => emit("disposition.selected", { call_id: callId, finish_code: "CONSULTATION_BOOKED", agent_note: "geç geldi ama booked" }), 1500);
      break;
    case "note-conflict":
      emit("call.ended", { call_id: callId, crm_contact_id: contactId });
      emit("disposition.selected", { call_id: callId, finish_code: "NO_ANSWER", agent_note: "spoke to her, she's booking online herself tonight" });
      break;
    case "duplicate-event": {
      // Vakadaki tanım: AYNI call_id, FARKLI event_id (platformun aynı
      // sonucu iki kez, iki ayrı olay olarak göndermesi). Her emit() kendi
      // event_id'sini üretir, bu yüzden iki ayrı emit() çağrısı tam olarak
      // bunu simüle eder — event_id bazlı dedup bunu YAKALAYAMAZ, ama
      // patchDeal()'daki call_id+finish_code bazlı kontrol yakalar.
      emit("call.ended", { call_id: callId, crm_contact_id: contactId });
      emit("disposition.selected", { call_id: callId, finish_code: "CONSULTATION_BOOKED", agent_note: "booked" });
      emit("disposition.selected", { call_id: callId, finish_code: "CONSULTATION_BOOKED", agent_note: "booked (mükerrer teslimat, farklı event_id)" });
      break;
    }
    case "conflict-409": {
      // Gerçek/deterministik 409: rastgeleliğe dayanmaz.
      // 1) Reconciliation motoru deal'i "okur" (o anki lastmodifieddate'i alır).
      // 2) Nadia'nın ekibi TAM O SIRADA deal'i CRM üzerinden elle taşır.
      // 3) Reconciliation motoru elindeki ESKİ tarihle PATCH dener -> 409.
      // 4) Taze veriyle tekrar dener -> başarılı.
      const dealId = "DEAL-88214";
      const dealBefore = db.deals[dealId];
      const staleLastMod = dealBefore.lastmodifieddate; // reconciliation'ın "okuduğu" an

      crmPatchDeal(dealId, {
        dealstage: "callback",
        ccs_changed_by: "nadia.kaur (manuel CRM düzenlemesi)",
        ccs_change_reason: "Ekip deal'i elle taşıdı — demo senaryosu",
      });

      const conflictAttempt = crmPatchDeal(dealId, {
        dealstage: "positive",
        ccs_finish_code: "CONSULTATION_BOOKED",
        ccs_call_id: callId,
        ccs_changed_by: "reconciliation-engine",
        ccs_change_reason: "disposition.selected: CONSULTATION_BOOKED",
        expected_lastmodifieddate: staleLastMod,
      });

      const freshLastMod = db.deals[dealId].lastmodifieddate;
      const retryAttempt = crmPatchDeal(dealId, {
        dealstage: "positive",
        ccs_finish_code: "CONSULTATION_BOOKED",
        ccs_call_id: callId,
        ccs_changed_by: "reconciliation-engine",
        ccs_change_reason: "disposition.selected: CONSULTATION_BOOKED (retry)",
        expected_lastmodifieddate: freshLastMod,
      });

      if (retryAttempt.status === 200) db.suppressed.add(dealId);
      return sendJSON(res, 200, {
        started: name,
        call_id: callId,
        adim_1_ilk_deneme: { beklenen: 409, gercek: conflictAttempt.status },
        adim_2_retry: { beklenen: 200, gercek: retryAttempt.status },
      });
    }
    default:
      sendJSON(res, 404, {
        error: "bilinmeyen senaryo",
        available: ["clean-flow", "no-disposition", "late-disposition", "note-conflict", "duplicate-event", "conflict-409"],
      });
      return;
  }
  sendJSON(res, 200, { started: name, call_id: callId });
}

// =================================================================
// Minik router yardımcıları
// =================================================================

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}
function sendHTML(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // Tarayıcı tabanlı test araçlarının (Hoppscotch, Postman web vb.) CORS
  // engeline takılmadan istek atabilmesi için: herkese açık, sadece demo amaçlı.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CCS-Signature");
  if (method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    // ---- SERVİS 1: /events/* ----
    if (path === "/events/emit" && method === "POST") {
      const body = await readBody(req);
      const { type, call_id, agent_id, campaign, finish_code, agent_note, crm_contact_id } = body;
      if (!type || !call_id) return sendJSON(res, 400, { error: "type ve call_id zorunlu" });
      const event = {
        event_id: "ev_" + crypto.randomUUID(),
        call_id,
        occurred_at: new Date().toISOString(),
        campaign: campaign || "ASHGROVE_BOOKINGS",
        agent_id: agent_id || "AG-114",
        type,
      };
      if (type === "call.ended") {
        Object.assign(event, { crm_contact_id: crm_contact_id || null, talk_time_sec: 96, finish_code: null });
        db.calls[call_id] = { call_id, agent_id: event.agent_id, crm_contact_id: event.crm_contact_id, status: "awaiting_disposition", call_ended_at: event.occurred_at, finish_code: null, agent_note: null };
      } else if (type === "disposition.selected") {
        Object.assign(event, { finish_code: finish_code || null, agent_note: agent_note || null });
      } else {
        return sendJSON(res, 400, { error: "type: call.ended | disposition.selected olmalı" });
      }
      db.events.push(event);
      deliverWebhook(event);
      return sendJSON(res, 202, { accepted: true, event, webhook_signature: sign(event) });
    }

    if (path.startsWith("/events/redeliver/") && method === "POST") {
      const eventId = path.split("/").pop();
      const ev = db.events.find((e) => e.event_id === eventId);
      if (!ev) return sendJSON(res, 404, { error: "event bulunamadı" });
      const r = deliverWebhook({ ...ev, __forceRedeliver: true });
      return sendJSON(res, 200, { redelivered: ev.event_id, ...r });
    }

    if (path === "/events/webhook" && method === "POST") {
      const body = await readBody(req);
      const sig = req.headers["x-ccs-signature"];
      if (!sig || sig !== sign(body)) return sendJSON(res, 401, { error: "geçersiz imza" });
      const r = deliverWebhook(body);
      return sendJSON(res, 200, { ok: true, ...r });
    }

    // ---- SERVİS 2: /crm/* ----
    if (path.match(/^\/crm\/objects\/contacts\/[^/]+$/) && method === "GET") {
      const id = path.split("/").pop();
      const c = db.contacts[id];
      return c ? sendJSON(res, 200, c) : sendJSON(res, 404, { error: "not found" });
    }
    if (path.match(/^\/crm\/objects\/deals\/[^/]+$/) && method === "GET") {
      const id = path.split("/").pop();
      const d = db.deals[id];
      return d ? sendJSON(res, 200, d) : sendJSON(res, 404, { error: "not found" });
    }
    if (path.match(/^\/crm\/objects\/deals\/[^/]+$/) && method === "PATCH") {
      const id = path.split("/").pop();
      const body = await readBody(req);
      const result = crmPatchDeal(id, body);
      return sendJSON(res, result.status, result.body);
    }
    if (path === "/crm/objects/activities" && method === "POST") {
      const body = await readBody(req);
      db.activities.push({ ...body, occurred_at: new Date().toISOString() });
      return sendJSON(res, 201, { ok: true });
    }

    // ---- SERVİS 3: /campaign/* ----
    if (path === "/campaign/next-list" && method === "GET") {
      const suppression = url.searchParams.get("suppression") !== "off";
      let list = Object.values(db.deals).filter((d) => d.dealstage === "new_lead");
      if (suppression) list = list.filter((d) => !db.suppressed.has(d.id));
      return sendJSON(res, 200, {
        date: url.searchParams.get("date") || new Date().toISOString().slice(0, 10),
        suppression_applied: suppression,
        count: list.length,
        contacts: list.map((d) => d.contact_id),
      });
    }

    // ---- DASHBOARD ----
    if (path === "/dashboard" && method === "GET") {
      const pending = Object.values(db.calls).filter((c) => c.status === "awaiting_disposition").length;
      return sendHTML(
        res,
        200,
        `<!doctype html><html><head><meta charset="utf-8"><title>Ashgrove Dashboard</title>
        <style>body{font-family:system-ui;max-width:760px;margin:40px auto;color:#141413}
        .card{border:1px solid #ddd;border-radius:8px;padding:16px;margin-bottom:14px}
        table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left;font-size:13px}
        </style></head><body>
        <h1>Ashgrove — Reconciliation Dashboard</h1>
        <div class="card"><b>Sonuç kodu bekleyen çağrı:</b> ${pending}</div>
        <div class="card"><b>Bastırılan (randevulu) deal sayısı:</b> ${db.suppressed.size}</div>
        <div class="card"><b>İnsan onayı bekleyen kayıt:</b> ${db.reviewQueue.length}
          <table><tr><th>Sebep</th><th>Call ID</th><th>Detay</th></tr>
          ${db.reviewQueue.map((r) => `<tr><td>${r.reason}</td><td>${r.call_id}</td><td>${r.llm_suggestion || ""}</td></tr>`).join("")}
          </table>
        </div>
        <div class="card"><b>Deal durumları</b>
          <table><tr><th>Deal</th><th>Stage</th><th>Son değişiklik</th></tr>
          ${Object.values(db.deals).map((d) => `<tr><td>${d.id}</td><td>${d.dealstage}</td><td>${d.lastmodifieddate}</td></tr>`).join("")}
          </table>
        </div>
        </body></html>`
      );
    }

    if (path === "/state" && method === "GET") {
      return sendJSON(res, 200, {
        ...db,
        processedEventIds: [...db.processedEventIds],
        suppressed: [...db.suppressed],
      });
    }

    // ---- DEMO SENARYOLARI ----
    if (path.startsWith("/demo/scenario/") && method === "POST") {
      const name = path.split("/").pop();
      return runScenario(name, res);
    }

    if (path === "/" && method === "GET") {
      res.writeHead(302, { Location: "/dashboard" });
      return res.end();
    }

    sendJSON(res, 404, { error: "not found", path });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Ashgrove case app listening on :${PORT}`));

module.exports = server;
