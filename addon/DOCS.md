# HA Guest Pass

Gives guests a link that opens your Home Assistant dashboard with only the
areas and entities you picked, for as long as you picked. No HA user is
created and guests never see your credentials.

## Setup

1. In Home Assistant, open your profile, Security tab, and create a
   long-lived access token. Paste it into the add-on's `ha_token` option.
2. Set `admin_secret` to at least 32 random characters, for example the
   output of `openssl rand -hex 24`.
3. Start the add-on.
4. Open `http://homeassistant.local:8124/admin` from a device on your LAN
   and enter the admin secret.

Guest records live in the add-on's data directory and survive restarts and
updates. The key that signs guest links is generated there on first start;
deleting it invalidates every outstanding link.

## Creating a guest

On the admin page pick a name, a duration, the dashboards the guest may open,
and for each area whether the guest can view or control it. Preview shows
exactly which entities that resolves to. Create gives you a link and a QR
code. Revoking a guest closes their open connections immediately.

The scope is fixed when the guest is created. A device you add to an area
later is not visible to existing guests.

## Network

The add-on uses host networking on purpose. It refuses connections from
outside your LAN by checking the source address of each connection, and it
locks out addresses that keep failing a credential check. Both need the real
client address, which Docker's bridge network hides.

Guests connect to port 8124. Do not forward that port on your router; the
add-on is meant for people on your Wi-Fi.

Supervisor's watchdog polls `/health` and restarts the add-on if it stops
answering. Enable it under the add-on's Info tab.

## What guests cannot do

Anything not in their scope. The add-on filters every WebSocket message and
REST request against the guest's entity list before it reaches Home
Assistant, refuses service calls on entities the guest may only view, and
blocks history, logbook, the media browser, configuration and every other
endpoint not needed to render a dashboard.
