import { createApp } from "./src/bridge.js";

const required = ["MAINTAINX_WEBHOOK_SECRET", "RELAY_SUBSCRIBER_ID"];
if (process.env.DRY_RUN !== "true") required.push("RELAY_API_KEY");
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, "0.0.0.0", () => {
  console.log(`Listening on :${port}${process.env.DRY_RUN === "true" ? " (dry run)" : ""}`);
});
