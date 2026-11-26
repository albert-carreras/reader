// reader-edge: forwards reader.bored.cat to the app on au through the Workers VPC tunnel binding.
// Cloudflare Access (in front of this Worker) is the login; the app also verifies the Access JWT.
const ORIGIN = "http://127.0.0.1:8130";

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
    const originResponse = await env.READER_ORIGIN.fetch(originRequest);
    const response = new Response(originResponse.body, originResponse);

    // audio segments are immutable and safe to keep in the browser cache; everything else is private, no-store
    if (!incomingUrl.pathname.includes("/audio/")) response.headers.set("cache-control", "private, no-store");
    response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    return response;
  },
};
