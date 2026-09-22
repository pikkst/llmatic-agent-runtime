const baseUrl = (process.argv[2] || process.env.LLMATIC_CONNECTION_BROKER_URL || "")
  .trim()
  .replace(/\/+$/, "");

if (!baseUrl) {
  console.error(
    "Usage: node scripts/oauth-broker-smoke.mjs https://<broker-origin>\n" +
      "or set LLMATIC_CONNECTION_BROKER_URL.",
  );
  process.exit(2);
}

const url = new URL(baseUrl);
if (url.protocol !== "https:") {
  console.error("FAIL: production OAuth broker URL must use HTTPS.");
  process.exit(2);
}

const response = await fetch(baseUrl + "/health", {
  headers: { Accept: "application/json" },
});
const raw = await response.text();

if (!response.ok) {
  console.error(
    "FAIL: broker health returned " +
      response.status +
      " " +
      response.statusText +
      (raw.trim() ? ": " + raw.trim().slice(0, 500) : ""),
  );
  process.exit(1);
}

let health;
try {
  health = JSON.parse(raw);
} catch {
  console.error("FAIL: broker health returned invalid JSON.");
  process.exit(1);
}

const atlassian = health?.providers?.atlassian;
if (
  health?.ok !== true ||
  health?.ready !== true ||
  atlassian?.ready !== true
) {
  console.error("FAIL: broker is reachable but not ready.");
  console.error(JSON.stringify(health, null, 2));
  process.exit(1);
}

console.log("OAUTH BROKER SMOKE PASSED");
console.log("Service:", health.service);
console.log("Version:", health.version);
console.log("Atlassian:", "ready");
