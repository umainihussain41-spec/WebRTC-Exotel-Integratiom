# Exotel Web Browser Calling

A browser softphone built on the **Exotel WebRTC WebSDK** — in-browser calling,
incoming and outgoing — plus a one-command **provisioning** script that creates
the App, the WebRTC agent, and the recording setting via the Exotel APIs.

Dialer features: number pad with DTMF, mute, hold, hang up, incoming-call popup
with ringer, call timer, activity log. **Every call is recorded.**

> Non-technical, step-by-step guide: see `SOP.md` (or the shared SOP page).

## Files

| File | Purpose |
|------|---------|
| `server.js` | Node/Express backend; holds secrets, exposes safe endpoints. |
| `provision.js` | One-command provisioning (register App + create agent). |
| `.env` | Your Exotel credentials (never commit). |
| `build-sdk.js` | Bundles the Exotel WebSDK into a browser file. |
| `public/` | The dialer site (`index.html`, `app.js`, `styles.css`). |
| `public/vendor/exotel-websdk.bundle.js` | Pre-built Exotel WebSDK. |
| `public/login.html` | Password gate used when deployed. |
| `railway.json` | Railway build/start/health config. |
| `railway-env.js` | Prints the variable block to paste into Railway. |

## Endpoints (no Exotel API removed)

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/config` | Non-secret settings for the browser. |
| GET  | `/api/account` | Account type/status/billing/KYC (why calls get refused). |
| POST | `/login` / `/logout` | Access gate when `APP_PASSWORD` is set. |
| GET  | `/healthz` | Railway health check. |
| POST | `/api/webrtc/token` | **App** access token for the WebSDK (+ userId). |
| GET  | `/api/webrtc/whoami` | Which App/account the token resolves to. |
| GET  | `/api/webrtc/user?user_id=email` | Is a WebRTC user provisioned? |
| POST | `/api/provision/app` | Register the App under the customer. |
| POST | `/api/provision/user` | Create a WebRTC agent (incoming + outgoing). |
| POST | `/api/provision/setting` | Set an App setting (`{key,value}`). |
| GET  | `/api/provision/status` | App + agent provisioning status. |
| GET  | `/api/call/:sid` | Get call details (Voice v1). |
| POST | `/webhook/call-status` | Receives Exotel status callbacks (logged). |

## Run

```bash
npm install
npm run build:sdk     # builds public/vendor/exotel-websdk.bundle.js
npm run provision     # registers App + tries to create the agent
npm start             # http://localhost:3000
```

## Deploying to Railway (so you can take calls on the Mac)

WebRTC needs a **secure context**: browsers refuse `getUserMedia` on plain
`http://` unless the host is `localhost`. That's the whole reason this has to
be deployed to reach it from another machine — Railway serves HTTPS by default,
which is all the browser needs.

### Before you push: this app must be password protected

`/api/webrtc/token` hands out an Exotel **App token**. Anyone who reaches that
endpoint can place calls billed to your account and read the agent's SIP
credentials. On `localhost` that's nobody; on a public URL it's everybody.

So the server now has an access gate. Set `APP_PASSWORD` and every page and API
call requires a signed session cookie first (`/webhook/*` stays open, because
Exotel posts status callbacks there, and it carries no secrets). Leave
`APP_PASSWORD` unset and the server runs wide open and says so loudly in its
logs — fine locally, not fine deployed.

### Steps

The repo is already on GitHub (private):
**https://github.com/umainihussain41-spec/exotel-browser-softphone**

1. On [railway.app](https://railway.app) → **New Project → Deploy from GitHub
   repo** → pick `exotel-browser-softphone`. (First time only: authorise Railway
   for the repo, and because it's private, grant it access explicitly.)
   `railway.json` supplies the start command and a `/healthz` check; Nixpacks
   installs and runs `postinstall` to build the browser bundle.

2. Get the variables to paste. Locally, run:

   ```bash
   node railway-env.js
   ```

   That prints every `EXOTEL_*` value from your `.env`, plus a freshly generated
   `SESSION_SECRET` and a placeholder `APP_PASSWORD`. Replace the placeholder
   with a password you choose.

3. In Railway → **Variables → Raw Editor**, paste the whole block and save.

   - **`APP_PASSWORD` is required.** Without it the dialer is open to anyone
     with the URL, and `/api/webrtc/token` hands out an Exotel app token.
   - Do **not** set `PORT` — Railway injects it and `server.js` reads it.

4. **Settings → Networking → Generate Domain.**

5. Open the `https://…` URL on the Mac, sign in with `APP_PASSWORD`, click
   **Enable microphone → Allow**. The signal bars go green and the browser line
   is live.

To redeploy later, just `git push` — Railway rebuilds on every push to `main`.

Provisioning (`npm run provision`) stays a **local** task — it writes
`EXOTEL_APP_ID`/`EXOTEL_APP_SECRET` back into `.env`, and a deployed container's
filesystem is thrown away on redeploy. Run it here, then copy the values up.

> One agent = one registration. If the dialer is open on the Windows box and
> the Mac at the same time, both register the same SIP device and Exotel rings
> whichever registered last. Use one at a time, or provision a second agent.

## What happens with the microphone permission

Browsers only show the permission prompt in response to a click, and they only
allow it on HTTPS. So the app asks deliberately instead of letting the SDK
trigger a surprise prompt in the middle of a call:

1. On load it checks `navigator.permissions.query({name:'microphone'})`.
2. **Already granted** → it opens and releases the mic silently; nothing shown.
3. **Not yet decided** → a card appears: *"Enable your microphone"*. Clicking it
   triggers the browser prompt. That same click is also what unlocks audio
   playback, which is why the ringer is armed here rather than at page load.
4. **Denied** → the card explains how to re-allow it from the padlock icon in
   the address bar, with a Retry button, and a red strip stays up meanwhile.

On the Mac, Chrome also needs the OS to agree: **System Settings → Privacy &
Security → Microphone → Chrome**. If macOS is blocking it, Chrome's own prompt
never appears and the card will just keep saying permission was denied.

## Ringing

Both directions ring, and the tones are synthesised in the browser with the Web
Audio API — no audio files to 404 or fail to decode:

- **Incoming** — a full-screen popup with the caller's number, Accept/Decline,
  and a repeating two-burst ring. Escape declines; "Silence ringer" stops the
  sound without dropping the call.
- **Outgoing** — a softer ringback while the call is being placed, which stops
  the moment the call connects.

The SDK ships its own ringtone and plays it on a detached `<audio>` element. To
avoid two overlapping rings, `app.js` silences detached media elements *only
while our ringer is running*, and restores their volume when it stops — so call
audio can never be left muted.

## How Exotel auth actually works here (verified live)

- **Token API:** `POST {icore}/v2/integrations/token` with body
  `{ "Id", "Secret", "Entity" }`, where `Entity` is `"customer"` or `"app"`.
  (Field names are `Id/Secret/Entity` — *not* `entity_id/entity_secret`.)
- Your **Client ID is the CustomerID**; the **App** has its own Id/Secret
  (created by `npm run provision`, saved to `.env`).
- The **WebSDK access token is an APP token** (a JWT, valid ~90 days); the SDK
  `userId` is the agent email.
- **Voice API:** `https://api.in.exotel.com/v1/Accounts/<sid>/...` with an
  `Authorization: Basic base64(key:token)` header. Do **not** use the
  `https://key:token@host/...` form — Node's `fetch()` refuses to build a
  request from a URL containing credentials, so that form fails outright.

### Credentials note
The API Key/Token you were given were **labelled swapped**. The verified working
order (already fixed in `.env`) is:
`EXOTEL_API_KEY=59baecc9…`, `EXOTEL_API_TOKEN=e8aec300…`.

## Call recording

**Every call is recorded**, and that is configured at the Exotel **app** level,
not per call:

```
POST {icore}/v2/integrations/app_setting   { "Key": "record", "Value": "true" }
```

This is the only lever that exists — the SDK's `MakeCall` payload is just
`{customer_id, app_id, to, user_id}`, with no record field, so there is nothing
per-call to toggle. `npm run provision` sets it (step 3) and is safe to re-run;
it reports "already enabled" when nothing needs changing. Recordings appear
against each call in the Exotel dashboard.

## How an in-browser call actually flows

This is the part that trips people up. `webPhone.MakeCall(number)` does **not**
dial from the browser. It posts to Exotel
(`/v2/integrations/call/outbound_call`), and Exotel then **rings this browser's
SIP device** with an ordinary INVITE.

So *outgoing* calls arrive back at the SDK as an `"incoming"` event. `app.js`
tracks `state.pendingOutbound` and auto-answers that leg, so the agent never
sees an "incoming call" card for a number they just dialled. Without this, every
outgoing call shows up as a bogus inbound ring.

Event order for an outgoing call:

```
dial() → MakeCall() → "success" (CallSid)   → UI: "Ringing…"
       → "incoming"  (Exotel's return leg)  → auto AcceptCall()
       → "connected"                        → timer starts, mute/hold enabled
       → "callEnded"                        → UI resets
```

## Current status

Provisioning is complete and was run live against `exotel243m`:

- ✅ Account is **live**: `Type: Full`, `Status: active`, `KycStatus: completed`
  (no longer the trial that previously blocked agent creation).
- ✅ App **registered** (`AppName: webdialer`).
- ✅ WebRTC **agent created** — `umainihussain41+webrtc@gmail.com`, SIP
  `sip:umainihf98a3bc9`, SIP device `372299`, phone device `372298`
  (`AgentNumber: +918088055789`), ExoPhone `08048332956`, `OutboundActive: true`.
  `ActiveDeviceId == SipDeviceID`, so calls route to the **browser**, with the
  phone as a fallback device.
- ✅ Browser **registers with Exotel's SIP server** (`REGISTER` → `200 OK`,
  verified in headless Chrome against `exotel243m.voip.exotel.com`).
- ✅ Account **recharged and verified by a live call**: browser →
  `08088055789`, `CallSid 0c423e88bb65c8f28280157419401a8p`,
  `Status: completed`, `Duration: 19s`, `Direction: outbound-dial`.
  The full path works: dial → Exotel's return INVITE → auto-answer → two-way
  media → hangup.
- ✅ Tokens and Voice API authenticate.
- ✅ **Recording enabled** for all calls (app setting `record: true`).

`GET /api/account` reports `billingType`/`status` at a glance if calls ever start
getting refused again.

### Why a failed call used to just say "Error"

`MakeCall`'s failure callback receives `new Error(response.statusText)`, and
Exotel's API is served over **HTTP/2, where `statusText` is always empty** — so
every rejection reached the UI as the string `"Error"`, with the real reason
only in the console. `app.js` now wraps `window.fetch`, reads the body of a
failed `/call/outbound_call` response, and surfaces Exotel's actual
`error_data.description`. The vendored SDK is untouched.

### Plus-addressed agent emails break the SDK (worked around)

The SDK builds its user lookup as
`` `${icoreBaseURL}/v2/integrations/usermapping?user_id=${agentUserID}` `` —
**with no encoding**. An address like `umainihussain41+webrtc@gmail.com`
therefore reaches Exotel with the `+` decoded as a space, the lookup 404s, and
`Initialize()` returns `void` with only a console warning.

`app.js` passes `encodeURIComponent(userId)` to the SDK constructor. That value
is used solely to build this URL — the SDK's `User` object comes from the
response body — so pre-encoding is safe and leaves the vendored bundle
untouched. Verified: raw → `HTTP 404 record not found`, encoded → `HTTP 200`.

### Incoming calls need one dashboard step

Provisioning creates the agent, but it does not decide what your ExoPhone does
when someone rings it. In the Exotel dashboard, point ExoPhone
**08048332956** at a flow whose applet connects to the **VoIP / WebRTC agent**
(`umainihussain41+webrtc@gmail.com`). Until that is set, outgoing browser calls
work but inbound calls never reach the tab. Outgoing needs no dashboard change.
