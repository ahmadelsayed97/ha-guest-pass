# ha-guest-pass

Reverse proxy that gives guests temporary access to a Home Assistant dashboard
without creating an HA user. LAN only.

The proxy holds the long-lived token; guests never see it. Each guest gets a
signed link that expires, can be revoked, and only reaches the dashboards and
entities you picked. Anything else is refused before it reaches HA. See
`docs/enforcement.md` for the exact rules.

## Running

As a Home Assistant add-on (HA OS or Supervised): Settings, Add-ons, Add-on
store, Repositories, add `https://github.com/ahmadelsayed97/ha-guest-pass`,
install HA Guest Pass, paste a long-lived token and an admin secret into its
configuration, start it. The add-on runs on the host network so it sees real
client addresses, which the LAN check and the lockout depend on. Guest records
and the signing key live in its data directory. Details in `addon/DOCS.md`.

Anywhere else:

```sh
cp .env.example .env   # fill in HA_URL, HA_TOKEN, SIGNING_KEY, ADMIN_SECRET
bun install
bun run dev
```

or build the `Dockerfile` and run it with `--network host` and the same
variables, mounting a volume at `/data`.

Open `http://<proxy-host>:8124/admin` from the LAN, enter the admin secret,
and create a guest: name, how long, which dashboards, which areas at view or
control, and any per-entity overrides. Preview shows exactly what would be
granted. Create gives you a link and a QR code to hand over. The same page
lists guests and revokes them; revoking closes their open connections.

The link carries the token in the URL fragment, so it never reaches the server
or its logs. In the last ten minutes the guest sees a countdown; when access
ends they get a plain "access has ended" page.

## How it works

The `/guest` page checks the token with the proxy, then writes it into
localStorage in the shape HA's frontend keeps its tokens, so the stock frontend
believes it is logged in. HTML pages coming back from HA get one script added
that polls the session and shows the countdown; it is cosmetic, expiry itself
is enforced by the proxy. The proxy verifies the token on every `/api` request
and on the WebSocket `auth` message, looks up the guest record, and swaps in
the real token before talking to HA. HA's `/auth/token` endpoint is answered by
the proxy; the rest of `/auth` is blocked. Requests from outside the LAN get a
403 based on the socket address, not headers. Addresses that keep failing a
credential check are locked out for a few minutes.

On the WebSocket, each message from the guest is checked against an allowlist
of types and rewritten before forwarding, and each message from HA is filtered
by the guest's scope before it reaches them. Service calls must target
controllable entities by id; area, device and label targets are refused.

Scopes are resolved when a guest is created and stored with the record. A
device added to an area later is not granted until you create a new guest.

## Tests

```sh
bun test
bun run typecheck
```

Policy code is pure functions, so each rule has direct tests that try to get
around it. Integration tests run the proxy against a small fake HA and check
what crosses each side: the real token goes upstream and nowhere else, out of
scope entities never reach the guest, and refused requests never reach HA.
