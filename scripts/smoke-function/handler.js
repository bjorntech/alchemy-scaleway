export async function handle(event) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, source: "alchemy-scaleway-smoke", event }),
  };
}
