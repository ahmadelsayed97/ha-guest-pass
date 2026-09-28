# HA Guest Pass

Scoped, password-free guest access to your Home Assistant dashboards. Hand a
guest a link or a QR code and they can use the rooms and devices you picked
until it expires. They never see your credentials.

## Setup

Start the add-on. **Guest Pass** appears in your sidebar; open it to create
guests. You are already signed in, so there is nothing to configure and no
password to keep. Only Home Assistant administrators can open it.

Guest records and the key that signs links live in the add-on's data
directory and survive restarts and updates. Uninstalling deletes them, which
invalidates every outstanding link.

## Creating a guest

Pick a name, a duration, the dashboards the guest may open, and for each area
whether the guest can view or control it. Every entity in a chosen area then
appears, grouped by device, with its own off, view or control switch, so
exceptions are one click; anything outside those areas can be added by name.
Create gives you a link and a QR code. Revoke closes the guest's open
connections immediately. Renew gives an ended guest a new link with the same
access; the old link stays dead.

The scope is fixed when the guest is created. A device you add to an area
later is not visible to existing guests.

## Network

Guests connect to port 8124 on this machine. Do not forward that port on your
router: the add-on is for people on your Wi-Fi and refuses connections from
outside your network.

The add-on uses host networking so it sees real client addresses. That is
what the LAN check relies on, and what lets it lock out an address that keeps
failing a credential check.

Turn on the watchdog under the add-on's Info tab and Supervisor will restart
it if it ever stops answering.

## Options

Both optional. Leave them empty unless you need them.

- `admin_secret`: lets you open the admin page outside Home Assistant, at
  `http://homeassistant.local:8124/admin`. Not needed for the sidebar.
- `ha_url`: where the add-on fetches the Home Assistant frontend from. Only
  change it if Home Assistant does not answer on port 8123 of this machine.

## What guests cannot do

Anything not in their scope. The add-on checks every WebSocket message and
REST request against the guest's entity list before it reaches Home
Assistant, refuses service calls on entities the guest may only view, and
blocks logbook, the media browser, configuration and every other endpoint not
needed to render a dashboard.
