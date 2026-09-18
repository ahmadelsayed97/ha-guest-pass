# ha-guest-pass

Reverse proxy that gives guests temporary access to a Home Assistant dashboard
without creating an HA user. LAN only.

The proxy holds the long-lived token; guests never see it. Everything a guest
can see or do comes from a scope you define by area and entity, and anything
not in it is refused before it reaches HA. See `docs/enforcement.md` for the
exact rules.

## Running

```sh
cp .env.example .env
cp guest-scope.example.json guest-scope.json   # areas, overrides, dashboards
bun install
bun run resolve guest-scope.json               # writes scope.json from HA's registries
bun run dev
```

`resolve` prints every entity it granted and where it came from. Run it again
whenever the definition or your devices change; the proxy only reads
`scope.json`.

Then open `http://<proxy-host>:8124/guest#<GUEST_SECRET>` from a device on the
LAN. The secret goes in the URL fragment so it never reaches the server or its
logs.

## How it works

The `/guest` page checks the secret with the proxy, then writes it into
localStorage in the shape HA's frontend keeps its tokens, so the frontend
believes it is logged in. The proxy resolves that secret to a session on every
`/api` request and on the WebSocket `auth` message, then swaps in the real
token before talking to HA. HA's `/auth/token` endpoint
is answered by the proxy; the rest of `/auth` is blocked. Requests from outside
the LAN get a 403 based on the socket address, not headers.

On the WebSocket, each message from the guest is checked against an allowlist
of types and rewritten before forwarding, and each message from HA is filtered
by the scope before it reaches the guest. Service calls must target
controllable entities by id; area, device and label targets are refused. Guest
requests that fail a check get an `unauthorized` result and never reach HA.

## Tests

```sh
bun test
bun run typecheck
```

Policy code is pure functions, so each rule has direct tests that try to get
around it. Integration tests run the proxy against a small fake HA and check
what crosses each side: the real token goes upstream and nowhere else, out of
scope entities never reach the guest, and refused requests never reach HA.
