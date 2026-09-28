# HA Guest Pass

[![CI](https://github.com/ahmadelsayed97/ha-guest-pass/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmadelsayed97/ha-guest-pass/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ahmadelsayed97/ha-guest-pass)](https://github.com/ahmadelsayed97/ha-guest-pass/releases)
[![License](https://img.shields.io/github/license/ahmadelsayed97/ha-guest-pass)](LICENSE)

Scoped, password-free guest access to your Home Assistant dashboards. Hand a
guest a link or a QR code and they can use the rooms and devices you picked
until it expires. Nothing else in your Home Assistant is reachable from that
link, and your credentials never leave the proxy.

Home Assistant can hide an entity in the UI, but it still serves that entity
over the API. This proxy sits in front and enforces the boundary for real.

```mermaid
flowchart LR
    proxy["ha-guest-pass :8124<br/>verify, scope, filter"]
    guest["Guest browser"] -->|"signed guest link"| proxy
    you["You"] -->|"admin secret"| proxy
    proxy -->|"Home Assistant API"| ha["Home Assistant :8123"]
```

Guests reach the proxy and nothing else. Every WebSocket message and HTTP
request is checked against that guest's scope before it reaches Home
Assistant, and everything coming back is filtered to the same scope. Links are
signed, expire, and can be revoked. Connections from outside the LAN are
refused by socket address. Exact rules:
[docs/enforcement.md](docs/enforcement.md).

## Install as a Home Assistant add-on

Needs Home Assistant OS or Supervised. Tested against Home Assistant 2026.9.

1. Add this repository to your add-on store:

   [![Add repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fahmadelsayed97%2Fha-guest-pass)

   Or by hand: Settings → Add-ons → Add-on store → ⋮ → Repositories → add
   `https://github.com/ahmadelsayed97/ha-guest-pass`
2. Install **HA Guest Pass** and start it. There is nothing to configure: it
   reaches Home Assistant through the Supervisor, so no access token is
   needed, and it generates its own admin secret.
3. Open the Log tab and copy the line reading `admin secret for this add-on:`.
4. Open `http://homeassistant.local:8124/admin` and paste the secret.

## Creating a guest

On `/admin` pick a name, a duration, the dashboards the guest may open, and
each area at view or control, plus any per-entity overrides. Preview lists the
exact entities that resolves to before you commit to it. You get a link and a
QR code to hand over, and the same page revokes a guest, which closes their
open connections immediately.

Scopes are resolved when the guest is created and stored with the record, so a
device you add to an area later is not granted to guests who already exist.

The guest's token rides in the URL fragment, so it never reaches the server or
its logs. Guests see a countdown during their last ten minutes and a plain
"access has ended" page afterwards.

## Run from source

Bun 1.4 or newer.

```sh
cp .env.example .env   # HA_URL, HA_TOKEN, SIGNING_KEY, ADMIN_SECRET
bun install
bun start
```

Or build the `Dockerfile` and run it with `--network host` and a volume at
`/data`. Host networking is not optional: the LAN check and the per-address
lockout both need to see real client addresses.

## License

MIT. See [LICENSE](LICENSE).
