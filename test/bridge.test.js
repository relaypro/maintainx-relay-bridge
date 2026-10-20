import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRelayRequest, createApp, parseRoutes, sign, verifySignature } from "../src/bridge.js";

const SECRET = "test-secret";
const ROUTES = JSON.stringify({
  urgent: { mode: "alert", groups: ["maintenance", "shift-leads"], quorum: 1, on_quorum: "Taken." },
  notice: { mode: "broadcast", groups: ["maintenance"] },
});

test("verifySignature accepts a valid signature in seconds or milliseconds", () => {
  const body = '{"a":1}';
  assert.ok(verifySignature(body, sign(body, SECRET), SECRET));
  assert.ok(verifySignature(body, sign(body, SECRET, Date.now()), SECRET));
});

test("verifySignature rejects wrong secret, altered body, stale timestamp, bad header", () => {
  const body = '{"a":1}';
  assert.equal(verifySignature(body, sign(body, "other"), SECRET), false);
  assert.equal(verifySignature('{"a":2}', sign(body, SECRET), SECRET), false);
  const stale = Math.floor(Date.now() / 1000) - 600;
  assert.equal(verifySignature(body, sign(body, SECRET, stale), SECRET), false);
  assert.equal(verifySignature(body, "garbage", SECRET), false);
  assert.equal(verifySignature(body, undefined, SECRET), false);
});

test("parseRoutes rejects routes without groups or with an unknown mode", () => {
  assert.throws(() => parseRoutes('{"urgent":{"mode":"alert","groups":[]}}'), /urgent/);
  assert.throws(() => parseRoutes('{"x":{"mode":"page","groups":["a"]}}'), /x/);
  assert.ok(parseRoutes(undefined).urgent);
});

test("alert routes fan out to every group and pass alert options through", () => {
  const { url, body } = buildRelayRequest(parseRoutes(ROUTES), "urgent", "Hello.", "sub-1");
  assert.equal(url, "https://api.relaypro.com/subscribers/sub-1/api/v1/alerts");
  assert.deepEqual(body.groups, ["maintenance", "shift-leads"]);
  assert.equal(body.quorum, 1);
  assert.equal(body.on_quorum, "Taken.");
  assert.equal(body.name, "maintainx-urgent");
});

test("broadcast routes send only notification and groups", () => {
  const { url, body } = buildRelayRequest(parseRoutes(ROUTES), "notice", "Hello.", "sub-1");
  assert.ok(url.endsWith("/api/v1/broadcasts"));
  assert.deepEqual(body, { notification: "Hello.", groups: ["maintenance"] });
});

// --- End to end through the HTTP server, with Relay mocked ------------------

async function withServer(fn) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
  const env = { MAINTAINX_WEBHOOK_SECRET: SECRET, RELAY_SUBSCRIBER_ID: "sub-1", RELAY_API_KEY: "k", RELAY_ROUTES: ROUTES };
  const quiet = { log() {}, error() {} };
  const server = createApp(env, { fetch: fakeFetch, log: quiet }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (event, signature) => {
    const body = JSON.stringify(event);
    const res = await fetch(`${base}/webhooks/maintainx`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-maintainx-webhook-body-signature": signature ?? sign(body, SECRET) },
      body,
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    await fn(post, calls);
  } finally {
    server.close();
  }
}

const newWorkOrder = (priority, extra = {}) => ({
  eventType: "NEW_WORK_ORDER",
  workOrderId: Math.floor(Math.random() * 1e9),
  orgId: 1,
  occurredAt: new Date().toISOString(),
  newWorkOrder: { title: "Compressor 3 leaking oil", priority, ...extra },
});

test("high priority work order alerts every group on the urgent route", async () => {
  await withServer(async (post, calls) => {
    const res = await post(newWorkOrder("HIGH"));
    assert.deepEqual(res.json, { status: "sent", route: "urgent" });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/alerts"));
    assert.deepEqual(calls[0].body.groups, ["maintenance", "shift-leads"]);
    assert.match(calls[0].body.notification, /high priority work order: Compressor 3/);
  });
});

test("MaintainX team assignment does not change the audience", async () => {
  await withServer(async (post, calls) => {
    await post(newWorkOrder("HIGH", { teamIds: [12], locationId: null, categories: [{ id: 1, name: "HVAC" }] }));
    assert.deepEqual(calls[0].body.groups, ["maintenance", "shift-leads"]);
  });
});

test("medium priority broadcasts, low priority is ignored", async () => {
  await withServer(async (post, calls) => {
    assert.equal((await post(newWorkOrder("MEDIUM"))).json.route, "notice");
    assert.equal((await post(newWorkOrder("LOW"))).json.status, "ignored");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/broadcasts"));
  });
});

test("status change to on hold broadcasts; overdue alerts", async () => {
  await withServer(async (post, calls) => {
    const onHold = { eventType: "WORK_ORDER_STATUS_CHANGE", workOrderId: 7, orgId: 1, occurredAt: "a",
      oldStatus: "IN_PROGRESS", newStatus: "ON_HOLD", newWorkOrder: { title: "Dock door 4" } };
    assert.equal((await post(onHold)).json.route, "notice");
    const overdue = { eventType: "WORK_ORDER_OVERDUE", workOrderId: 8, orgId: 1, dueDate: "b", occurredAt: "b" };
    assert.equal((await post(overdue)).json.route, "urgent");
    assert.match(calls[1].body.notification, /overdue: number 8/);
  });
});

test("duplicates are dropped and bad signatures rejected", async () => {
  await withServer(async (post, calls) => {
    const event = newWorkOrder("HIGH");
    await post(event);
    assert.equal((await post(event)).json.status, "duplicate");
    assert.equal((await post(newWorkOrder("HIGH"), "t=1,v1=00")).status, 401);
    assert.equal(calls.length, 1);
  });
});
