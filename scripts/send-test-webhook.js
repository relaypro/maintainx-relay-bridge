// Sends a signed sample MaintainX webhook to a running bridge.
//
//   npm run test:webhook                          # NEW_WORK_ORDER to localhost
//   npm run test:webhook -- overdue               # WORK_ORDER_OVERDUE
//   WEBHOOK_URL=https://my-app.example.com/webhooks/maintainx npm run test:webhook
//
// Signs with MAINTAINX_WEBHOOK_SECRET, the same secret the bridge uses.
import { sign } from "../src/bridge.js";

// Pick up a local .env if there is one; hosted environments set real env vars.
try {
  process.loadEnvFile(".env");
} catch {}

const samples = {
  new: {
    eventType: "NEW_WORK_ORDER",
    workOrderId: 123456,
    orgId: 321,
    newWorkOrder: { title: "Compressor 3 leaking oil", priority: "HIGH" },
  },
  "on-hold": {
    eventType: "WORK_ORDER_STATUS_CHANGE",
    workOrderId: 123457,
    orgId: 321,
    oldStatus: "IN_PROGRESS",
    newStatus: "ON_HOLD",
    newWorkOrder: { title: "Dock door 4 sensor" },
  },
  overdue: {
    eventType: "WORK_ORDER_OVERDUE",
    workOrderId: 123458,
    orgId: 321,
    dueDate: new Date(Date.now() - 3600_000).toISOString(),
  },
};

const kind = process.argv[2] ?? "new";
if (!samples[kind]) {
  console.error(`Unknown sample "${kind}". Use one of: ${Object.keys(samples).join(", ")}`);
  process.exit(1);
}
const secret = process.env.MAINTAINX_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set MAINTAINX_WEBHOOK_SECRET (e.g. in .env) to sign the request.");
  process.exit(1);
}

const url = process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 3000}/webhooks/maintainx`;
// A fresh occurredAt each run so the bridge doesn't drop it as a duplicate.
const body = JSON.stringify({ ...samples[kind], occurredAt: new Date().toISOString() });

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-maintainx-webhook-body-signature": sign(body, secret) },
  body,
});
console.log(`HTTP ${res.status}`, await res.text());
