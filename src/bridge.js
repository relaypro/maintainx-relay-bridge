// MaintainX webhook -> Relay Alerts API bridge.
import express from "express";
import crypto from "node:crypto";

const RELAY_BASE = "https://api.relaypro.com";
const MAINTAINX_BASE = "https://api.getmaintainx.com/v1";
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Relay routes: WHO hears an event and HOW it is delivered. This is owned on
// the Relay side. MaintainX tells us what happened; it does not pick the
// audience. Each route fans out to one or more Relay Workflow Groups.
//   mode "alert"     repeats every 30 s until acknowledged (or timeout).
//   mode "broadcast" plays once, no acknowledgement.
// Alert routes may also set timeout, quorum, on_ack, on_quorum, on_timeout.
// Override with the RELAY_ROUTES environment variable.
// ---------------------------------------------------------------------------
export const DEFAULT_ROUTES = {
  urgent: { mode: "alert", groups: ["maintenance"], timeout: 300, quorum: 1 },
  notice: { mode: "broadcast", groups: ["maintenance"] },
};

const ALERT_OPTIONS = ["timeout", "quorum", "on_ack", "on_quorum", "on_timeout"];

export function parseRoutes(json) {
  const routes = json ? JSON.parse(json) : DEFAULT_ROUTES;
  for (const [name, r] of Object.entries(routes)) {
    if (!["alert", "broadcast"].includes(r.mode) || !Array.isArray(r.groups) || !r.groups.length) {
      throw new Error(`RELAY_ROUTES.${name} needs mode "alert" or "broadcast" and a non-empty groups list`);
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Event rules: WHAT happened and which route it belongs to. Rules classify the
// event only; they never choose groups. Return null to ignore an event.
// ---------------------------------------------------------------------------
const PRIORITY_ROUTE = { HIGH: "urgent", MEDIUM: "notice", LOW: null, NONE: null };
const STATUS_ROUTE = { ON_HOLD: "notice", DONE: null, OPEN: null, IN_PROGRESS: null };

export async function classify(event, maintainx) {
  const wo = event.newWorkOrder ?? {};
  switch (event.eventType) {
    case "NEW_WORK_ORDER": {
      const route = PRIORITY_ROUTE[wo.priority ?? "NONE"];
      if (!route) return null;
      const where = await maintainx.locationName(wo.locationId);
      return {
        route,
        text: `New ${wo.priority.toLowerCase()} priority work order: ${wo.title}${where ? ` at ${where}` : ""}.`,
      };
    }
    case "WORK_ORDER_STATUS_CHANGE": {
      const route = STATUS_ROUTE[event.newStatus];
      if (!route) return null;
      return {
        route,
        text: `Work order ${wo.title ?? event.workOrderId} is now ${event.newStatus.replace("_", " ").toLowerCase()}.`,
      };
    }
    case "WORK_ORDER_OVERDUE": {
      // The overdue payload carries only IDs, so look the work order up if we can.
      const full = await maintainx.workOrder(event.workOrderId);
      return {
        route: "urgent",
        text: `Work order overdue: ${full?.title ?? `number ${event.workOrderId}`}${full?.location?.name ? ` at ${full.location.name}` : ""}.`,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// MaintainX
// ---------------------------------------------------------------------------
// Header format: "t=<timestamp>,v1=<hex hmac>". The HMAC is SHA-256 over
// "<timestamp>.<raw request body>", keyed with the webhook's secret.
export function verifySignature(rawBody, header, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  if (!parts.t || !parts.v1) return false;

  // Accept seconds or milliseconds; reject anything outside the replay window.
  const t = Number(parts.t);
  const tMs = t > 1e12 ? t : t * 1000;
  if (!Number.isFinite(tMs) || Math.abs(now - tMs) > SIGNATURE_TOLERANCE_MS) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`, "utf8").digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function sign(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function maintainxClient(apiKey, fetchImpl) {
  async function get(path) {
    if (!apiKey) return null;
    try {
      const res = await fetchImpl(`${MAINTAINX_BASE}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }
  return {
    workOrder: async (id) => (await get(`/workorders/${id}?expand=location`))?.workOrder ?? null,
    locationName: async (id) => (id ? (await get(`/locations/${id}`))?.location?.name ?? null : null),
  };
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------
export function buildRelayRequest(routes, routeName, text, subscriberId) {
  const { mode, groups, ...options } = routes[routeName];
  const endpoint = mode === "alert" ? "alerts" : "broadcasts";
  const body = { notification: text.slice(0, 600), groups };
  if (mode === "alert") {
    Object.assign(body, {
      name: `maintainx-${routeName}`,
      on_ack: "Thanks, work order acknowledged.",
      on_timeout: "No one acknowledged this work order.",
    });
    for (const key of ALERT_OPTIONS) if (key in options) body[key] = options[key];
  }
  return { url: `${RELAY_BASE}/subscribers/${subscriberId}/api/v1/${endpoint}`, endpoint, body };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
export function createApp(env = process.env, { fetch: fetchImpl = fetch, log = console } = {}) {
  const routes = parseRoutes(env.RELAY_ROUTES);
  const dryRun = env.DRY_RUN === "true";
  const maintainx = maintainxClient(env.MAINTAINX_API_KEY, fetchImpl);

  async function sendToRelay(routeName, text) {
    const { url, endpoint, body } = buildRelayRequest(routes, routeName, text, env.RELAY_SUBSCRIBER_ID);
    if (dryRun) {
      log.log("[dry-run] POST", url, JSON.stringify(body));
      return true;
    }
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `RelayApiKey ${env.RELAY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) log.error(`Relay ${endpoint} failed: HTTP ${res.status} ${await res.text()}`);
    else log.log(`Relay ${endpoint} sent to ${body.groups.join(", ")}: ${body.notification}`);
    return res.ok;
  }

  const seen = new Map(); // dedupe key -> expiry
  function isDuplicate(key) {
    const now = Date.now();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (seen.has(key)) return true;
    seen.set(key, now + 60 * 60 * 1000);
    return false;
  }

  const app = express();

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Keep the body raw: the signature is computed over the exact bytes MaintainX sent.
  app.post("/webhooks/maintainx", express.raw({ type: "*/*" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifySignature(rawBody, req.get("x-maintainx-webhook-body-signature"), env.MAINTAINX_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: "invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "invalid JSON" });
    }
    const key = `${event.eventType}:${event.workOrderId}:${event.occurredAt}`;
    if (isDuplicate(key)) return res.json({ status: "duplicate" });

    try {
      const message = await classify(event, maintainx);
      if (!message) return res.json({ status: "ignored" });
      if (!routes[message.route]) {
        log.error(`No Relay route named "${message.route}" in RELAY_ROUTES`);
        return res.json({ status: "no_route", route: message.route });
      }
      const sent = await sendToRelay(message.route, message.text);
      // Always answer 200 once the event is verified: MaintainX may disable a
      // webhook that keeps failing, and a Relay outage shouldn't cost you the hook.
      res.json({ status: sent ? "sent" : "relay_error", route: message.route });
    } catch (err) {
      log.error("Failed to process event", err);
      res.json({ status: "error" });
    }
  });

  return app;
}
