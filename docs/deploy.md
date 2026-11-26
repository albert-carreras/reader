# Deploy

Runs on **`au`** (this laptop), like piso-radar and cfo:
- A systemd **user** service bound to `127.0.0.1:8130`, with the renderer in the same process.
- An outbound-only Cloudflare Tunnel and a small Workers VPC edge proxy publish it at **https://reader.bored.cat**.
- Cloudflare Access on that hostname is the login.

```
browser
  -> Cloudflare Access (identity policy)
  -> reader.bored.cat / Worker custom domain
  -> reader-edge Worker            (infra/cloudflare)
  -> Workers VPC binding (tunnel reader-au)
  -> cloudflared-reader.service    (outbound QUIC only)
  -> http://127.0.0.1:8130
  -> reader.service                (FastAPI + background renderer)
  -> ~/reader/data                 (books, audio segments, take cache, positions)
```

**Defence in depth.** The app refuses any request that comes through the edge unless it carries a valid Cloudflare Access JWT.
- The JWT is checked against `READER_ACCESS_TEAM` (`bertini.cloudflareaccess.com`), and against `READER_ACCESS_AUD` too when that is set.
- Until the Access application exists, `reader.bored.cat` answers **403 Locked** to everything except `/healthz`. The library is never public, even in the window before Access is set up.
- Unknown forwarded hostnames get 404.
- Direct loopback requests on the laptop are allowed.

## Day to day

```
./stack deploy     # git pull -> uv sync -> restart
./stack status     # service, connector, local + public health
./stack logs
./stack edge       # redeploy the Worker after changing infra/cloudflare
```

Config that is not committed lives in `~/.config/reader/env`:

| Variable | Meaning |
|---|---|
| `READER_ACCESS_TEAM` | Access team domain |
| `READER_ACCESS_AUD` | The Access app's AUD tag (optional) |
| `READER_THREADS` | CPU threads for rendering (default 4) |
| `READER_NICE` | Renderer niceness (default 10) |

## Cloudflare resources

- Account: `17ef3b088f7d0af621420d0313ff4d39`
- Tunnel: `reader-au`. Its id is in `infra/cloudflare/wrangler.jsonc`.
- Worker: `reader-edge`, custom domain `reader.bored.cat`, `workers_dev` off.
- Connector unit: `cloudflared-reader.service`, which reads the root-only token `/etc/cloudflared/reader.token`.

The tunnel has no public-hostname ingress and no `cfargotunnel.com` record. The Worker's VPC binding is the only route.

## One-time setup

1. **Wrangler login:** `npx wrangler login`, in a terminal on the laptop.
2. **Tunnel:** `npx wrangler tunnel create reader-au`.
   - Put its id in `wrangler.jsonc`.
   - Write the connector token to `~/.config/reader/tunnel.token` (mode 600).
3. **Connector (sudo):** `sudo ./infra/install-connector.sh`. It installs the token and the unit, enables the connector, and deletes the user copy of the token.
4. **App:** `./stack install`.
5. **Edge:** `./stack edge`. The site answers *Locked* until step 6.
6. **Cloudflare Access** (operator):
   1. Zero Trust → Access controls → Applications → **Self-hosted** application `reader` on `reader.bored.cat`, no path.
   2. Add an **Allow** policy with **Include → Emails** set to the exact allowed addresses only. Not `Everyone`, and not One-time PIN as the only rule.
   3. Optionally, copy the app's **AUD tag** into `READER_ACCESS_AUD` in `~/.config/reader/env`, then run `systemctl --user restart reader`.
   4. Test in a private window: the allowed identity gets in, others are denied.
