# HA Guest Pass

Scoped, password-free guest access to your Home Assistant dashboards. Hand a
guest a link or a QR code and they can use the rooms and devices you picked
until it expires. They never see your credentials.

## Setup

1. Start the add-on. Nothing to fill in first.
2. Open the Log tab and copy the line that reads
   `admin secret for this add-on: ...`.
3. Open `http://homeassistant.local:8124/admin` from a device on your network
   and paste that secret.

The add-on talks to Home Assistant through the Supervisor, so there is no
access token to create. To use your own admin secret instead of the generated
one, put it in the Configuration tab; anything 32 characters or longer works.

Guest records and the generated secrets live in the add-on's data directory
and survive restarts and updates. Deleting the add-on deletes them, which
invalidates every outstanding guest link.

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
blocks logbook, the media browser, configuration and every other endpoint not
needed to render a dashboard.
