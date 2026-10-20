# MaintainX → Relay bridge

Turns [MaintainX](https://www.getmaintainx.com/) work order webhooks into spoken alerts and broadcasts on [Relay](https://www.relaypro.com/) devices.

```
MaintainX ──signed webhook──▶ bridge ──classify──▶ Relay route ──▶ Workflow Group A
                                                               └─▶ Workflow Group B
```

* **Verifies** every request with MaintainX's HMAC signature.
* **Classifies** the event by what happened: a high-priority work order is `urgent`, a medium-priority one is a `notice`, a low-priority one is ignored.
* **Delivers** through a **Relay route**. A route sets alert or broadcast, plus the Relay Workflow Groups that hear it. One route can reach several groups.

The audience is set on the Relay side. MaintainX teams, assignees, locations, and categories never decide who hears an event.

📖 Full walkthrough: **[MaintainX Webhooks guide on developer.relaypro.com](https://developer.relaypro.com/integrations/maintainx-webhooks)**

## Deploy

| Platform | |
| --- | --- |
| **Replit** | [Import this repo into Replit](https://replit.com/github.com/relaypro/maintainx-relay-bridge), add Secrets, then **Publish** (Reserved VM recommended). `.replit` is included. |
| **Render** | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/relaypro/maintainx-relay-bridge) |
| **Google Cloud Run** | [![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/relaypro/maintainx-relay-bridge) |
| **Heroku** | [![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/relaypro/maintainx-relay-bridge) |
| **Docker** (Fly.io, Azure Container Apps, AWS ECS, your own server) | `docker build -t maintainx-relay-bridge .` then `docker run --env-file .env -p 3000:3000 maintainx-relay-bridge` |
| **Try it in the browser** | [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/relaypro/maintainx-relay-bridge) |

Every deploy starts with `DRY_RUN=true`. Set it to `false` once a test webhook looks right.

Your webhook URL is `https://<your-host>/webhooks/maintainx`. Register it in MaintainX under **Settings → Integrations → Webhooks**, then copy the webhook's secret into `MAINTAINX_WEBHOOK_SECRET`.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `RELAY_API_KEY` | Yes* | Relay Dash → **Help** → **API Keys** (Enterprise plan). *Not needed when `DRY_RUN=true`. |
| `RELAY_SUBSCRIBER_ID` | Yes | Relay Dash → **Help** → **Diagnostic Logs** → **Server Details** → **Subscriber** |
| `MAINTAINX_WEBHOOK_SECRET` | Yes | The webhook's secret from MaintainX |
| `RELAY_ROUTES` | No | Relay routes as JSON (below). Default: `urgent` and `notice`, both to `maintenance`. |
| `MAINTAINX_API_KEY` | No | Adds titles and locations to spoken alerts. Needs MaintainX API access (Premium or Enterprise). |
| `DRY_RUN` | No | `true` logs Relay requests instead of sending them |
| `PORT` | No | Default `3000` |

### Relay routes

```json
{
  "urgent": {
    "mode": "alert",
    "groups": ["maintenance", "shift-leads"],
    "timeout": 300,
    "quorum": 1,
    "on_quorum": "Someone else has this work order."
  },
  "notice": { "mode": "broadcast", "groups": ["maintenance"] }
}
```

* `mode`: `alert` repeats every 30 s until acknowledged. `broadcast` plays once.
* `groups`: one or more Relay Workflow Groups. Names must match exactly.
* Alert routes may also set `timeout`, `quorum`, `on_ack`, `on_quorum`, and `on_timeout`. See [Customizing Your Alerts](https://developer.relaypro.com/docs/relay-alerts-api/customizing-your-alerts).

The bridge won't start if a route has no groups or an unknown mode.

### Event rules

The **Event rules** section of [`src/bridge.js`](src/bridge.js) maps MaintainX events to route names:

| MaintainX event | Route |
| --- | --- |
| `NEW_WORK_ORDER`, priority `HIGH` | `urgent` |
| `NEW_WORK_ORDER`, priority `MEDIUM` | `notice` |
| `WORK_ORDER_STATUS_CHANGE` → `ON_HOLD` | `notice` |
| `WORK_ORDER_OVERDUE` | `urgent` |
| Anything else | ignored |

Rules only return a route name, never a group. Change *who hears it* in `RELAY_ROUTES`, and *what counts as urgent* in the rules.

## Local development

Needs Node.js 20.12 or newer.

```sh
npm install
cp .env.example .env     # fill in values; DRY_RUN=true is the default
npm run dev              # starts on :3000 and restarts on changes
npm run test:webhook     # sends a signed sample event (also: on-hold, overdue)
npm test                 # unit and end-to-end tests, Relay mocked
```

Point `npm run test:webhook` at a deployed bridge with `WEBHOOK_URL=https://<your-host>/webhooks/maintainx`.

## Endpoints

| Method | Path | |
| --- | --- | --- |
| `GET` | `/health` | `{"ok": true}` |
| `POST` | `/webhooks/maintainx` | MaintainX webhook receiver. Replies `401` on a bad signature. Otherwise replies `200` with `status`: `sent`, `ignored`, `duplicate`, `no_route`, `relay_error`, or `error`. |

Once a request is verified, the bridge always replies `200`, even if Relay fails. MaintainX may disable a webhook that keeps failing.

## Limitations

* Each MaintainX webhook has its own secret, and the bridge accepts one. Register one event per deployment, or extend `verifySignature` to accept a list.
* Duplicates are tracked in memory, per instance. If you run more than one instance, move dedupe to a shared store such as Redis.

## License

[MIT](LICENSE)
