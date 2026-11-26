// reader-edge: forwards reader.bored.cat to the app on au through the Workers VPC tunnel binding.
// Cloudflare Access (in front of this Worker) is the login; the app also verifies the Access JWT.
const ORIGIN = "http://127.0.0.1:8130";
const RESTARTING = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>reader</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font:16px -apple-system,system-ui,sans-serif;background:#121110;color:#ece6dc">
<div style="text-align:center;padding:2rem"><div style="font-size:1.2rem;font-weight:650;margin-bottom:.4rem">reader is restarting</div>
<div style="color:#9d958a">This page reloads by itself in a few seconds.</div></div>`;

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    const originUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, ORIGIN);
    const headers = new Headers(request.headers);

    headers.set("x-forwarded-host", incomingUrl.host);
    headers.set("x-forwarded-proto", "https");

    const originRequest = new Request(originUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
    let originResponse;
    try {
      originResponse = await env.READER_ORIGIN.fetch(originRequest);
    } catch (err) {
      // the app on the laptop is restarting or offline: answer cleanly instead of throwing (Cloudflare 1101)
      const html = (request.headers.get("accept") || "").includes("text/html");
      return html
        ? new Response(RESTARTING, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "5", "cache-control": "no-store" } })
        : new Response(JSON.stringify({ detail: "reader is restarting, try again in a moment" }),
            { status: 503, headers: { "content-type": "application/json", "retry-after": "5", "cache-control": "no-store" } });
    }
    const response = new Response(originResponse.body, originResponse);

    // audio segments are immutable and safe to keep in the browser cache; everything else is private, no-store
    if (!incomingUrl.pathname.includes("/audio/")) response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    return response;
  },
};
