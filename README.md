# ha-guest-pass

Reverse proxy that gives guests temporary access to a Home Assistant dashboard
without creating an HA user. LAN only.

This is currently the pass-through spike. It proves the stock HA frontend works
behind the proxy while the long-lived token stays on the server. Nothing is
filtered yet, so a guest sees whatever the token's user sees.

## Running

```sh
cp .env.example .env
bun install
bun run dev
```

Then open `http://<proxy-host>:8124/guest#<GUEST_SECRET>` from a device on the
LAN. The secret goes in the URL fragment so it never reaches the server or its
logs.

## How it works

The `/guest` page writes the guest secret into localStorage in the shape HA's
frontend keeps its tokens, so the frontend believes it is logged in. The proxy
checks that secret on every `/api` request and on the WebSocket `auth` message,
then swaps in the real token before talking to HA. HA's `/auth/token` endpoint
is answered by the proxy; the rest of `/auth` is blocked. Requests from outside
the LAN get a 403 based on the socket address, not headers. Anything unexpected
on the WebSocket closes it.

## Tests

```sh
bun test
bun run typecheck
```

The tests run the proxy against a small fake HA and check what crosses each
side: the real token goes upstream and nowhere else, and bad credentials never
cause an upstream connection.
