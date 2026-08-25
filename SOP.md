# Standard Operating Procedure (SOP)
## Exotel Web Browser Calling — Simple Guide for Everyone

This guide explains, in plain language, how to set up and use the **Exotel Web
Dialer** — a website that lets you make and receive phone calls from your web
browser. No coding knowledge is needed to follow along.

---

## 1. What this tool does

- **In-browser calling (WebRTC):** Talk to customers using your computer's
  microphone and speakers — no desk phone needed. Works for **outgoing** and
  **incoming** calls.
- **Dialer features:** number pad, mute, hold, hang up, send keypad tones
  (for IVR menus like "press 1"), a ringing pop-up for incoming calls, and an
  activity log.
- **Every call is recorded.** This is switched on for the whole account, so
  there is no per-call checkbox and nothing to remember. Recordings are in your
  Exotel dashboard next to each call.

---

## 2. What you need before you start

| # | You need | Where it comes from |
|---|----------|---------------------|
| 1 | A Windows or Mac computer with **Google Chrome** | Already installed |
| 2 | **Node.js** installed | Download from https://nodejs.org (click the "LTS" button) |
| 3 | The project folder ("Web Browser Calling") | Already on the Desktop |
| 4 | Your Exotel credentials | Already filled in the `.env` file |
| 5 | A **headset with microphone** (recommended) | Any USB/3.5mm headset |

---

## 3. First-time setup (do this once)

> You will type a few commands. Don't worry — just copy each line exactly.

1. Open the project folder: **Desktop → Web Browser Calling**.
2. In the address bar of that folder, type `cmd` and press **Enter**.
   A black window (Command Prompt) opens.
3. Type this and press Enter (installs the building blocks):
   ```
   npm install
   ```
4. Type this and press Enter (prepares the Exotel calling software):
   ```
   npm run build:sdk
   ```
5. Type this and press Enter (sets up your Exotel account & agent):
   ```
   npm run provision
   ```
   - It should say **"Provisioning complete"**. You're ready.
   - This has already been run successfully on your account, so it will simply
     confirm that the agent already exists.
6. You're set up. You only need to do steps 3–5 once.

---

## 4. Starting the dialer (every time you use it)

1. Open the project folder, type `cmd` in the address bar, press **Enter**.
2. Type this and press Enter:
   ```
   npm start
   ```
3. You'll see: `Exotel Web Browser Calling running: http://localhost:3000`
4. Open **Google Chrome** and go to: **http://localhost:3000**
5. A card appears: **"Enable your microphone."** Click the green button, then
   click **Allow** in the small prompt Chrome shows at the top-left.
6. To stop the dialer later: go back to the black window and press **Ctrl + C**.

### About that microphone question

Chrome will only ask for your microphone **after you click something**, and it
only remembers your answer per website. That's why the dialer shows its own
"Enable your microphone" card first — clicking it is what makes Chrome ask.

- Click **Allow** and you won't be asked again on that computer.
- If you clicked **Block** by mistake, click the **padlock icon** in Chrome's
  address bar, switch **Microphone** to **Allow**, and press **Retry** on the card.
- The same click is also what lets the dialer play its ring sound, so please
  don't skip it — otherwise incoming calls may arrive silently.

---

## 4b. Using the dialer from your Mac

The dialer must be published to a web address first (your developer does this
once — see "Deploying to Railway" in `README.md`). After that:

1. On the Mac, open **Chrome** and go to the **https://…** address you were given.
2. Enter the **password** for the dialer and click **Sign in**.
3. Click **Enable microphone**, then **Allow**.
4. If Chrome never asks, macOS is blocking it: **System Settings → Privacy &
   Security → Microphone → turn on Chrome**, then reload the page.

> Use the dialer on **one** computer at a time. If it's open on both the Windows
> PC and the Mac, calls ring on whichever one connected most recently.

---

## 5. How to make and manage calls

### Make a call from the browser (outgoing)
1. Check the small bars at the top-right of the blue strip are **green** — that
   means the line is connected.
2. Type the number using the on-screen keypad or your keyboard.
3. Click the big green **Call** button.
4. You'll hear a ring tone, and the screen shows **Dialing → Ringing → Talking**
   with a timer. You do **not** need to accept your own outgoing call.
5. During the call:
   - **Mute** – turns your microphone off/on.
   - **Hold** – pauses the call (the other person waits).
   - **Keypad** – opens the number pad to send tones for menus ("press 1 for sales").
6. Click the big red **Hang up** button to end the call.

### Receive a call (incoming)
1. The dialer **rings** and a pop-up fills the screen showing who's calling.
2. Click the green **Accept** to talk, or the red **Decline** to refuse.
3. **Silence ringer** stops the sound but keeps the call ringing.
4. Pressing **Esc** on the keyboard declines the call.

### Seeing what happened
Click **Activity** at the bottom of the dialer to open a log of every event —
useful when reporting a problem.

---

## 6. Account status — what is done, what is left

Your account is now live and everything on the computer side is finished:

- ✅ Your account app is **registered**.
- ✅ Your login keys are **correct** (a Key/Token mix-up was fixed for you).
- ✅ Your **browser-calling agent is created**
  (`umainihussain41+webrtc@gmail.com`, agent phone `8088055789`).
- ✅ The dialer **connects to Exotel** — the signal bars in the blue strip
  turn green.
- ✅ Your account is **fully live** (upgraded from trial, KYC completed).
- ✅ Your account has **balance**, confirmed by a real call: we dialled
  **8088055789** from the browser and it connected and ran for 19 seconds.

**Outgoing browser calls are working right now.** Open the dialer, type a
number, press **Call**.

> If calls ever start failing with *"Insufficient balance to make a call"*, the
> account has simply run out of money again — recharge it in the Exotel
> dashboard. Nothing on this computer needs changing.

### The one step left — for *incoming* calls only

Making calls out works right away. For calls **coming in** to reach your
browser, someone with access to the Exotel dashboard has to say where your
Exotel number should send them:

> In the Exotel dashboard, set your ExoPhone number **08048332956** to a flow
> that **connects the call to the VoIP / WebRTC agent**
> `umainihussain41+webrtc@gmail.com`.

Ask your Exotel account manager or whoever manages your Exotel dashboard to do
this. Nothing on this computer needs to change — once they've set it, incoming
calls will simply start appearing in the dialer with **Accept** and **Reject**
buttons.

### A note on what you'll see when you call out

When you press **Call**, Exotel rings *your browser* back to join you to the
call. The dialer answers that automatically — so you'll see
**"Dialing…" → "Ringing…" → "Connected"** and just start talking. You do **not**
need to click Accept for a call you made yourself.

---

## 7. Troubleshooting

| Problem | What to do |
|---------|------------|
| Banner says "agent isn't provisioned" | Run `npm run provision` again, then restart the dialer (Section 4). |
| Banner says "Device offline — retrying…" | Check your internet. The dialer re-registers on its own; it goes green again by itself. |
| "Insufficient balance to make a call" | The Exotel account is out of money. Recharge it — see Section 6. |
| Nobody ever rings my browser | Incoming routing isn't set yet — see Section 6. |
| Call says "Exotel never rang this browser back" | The outgoing leg didn't reach you. Check your internet, then try again. |
| No sound / can't be heard | Check the headset; in Chrome click the 🔒 icon → allow Microphone. |
| "Enter a valid number" | Use 10–14 digits. You may add a leading `+`. |
| Nothing loads at localhost:3000 | Make sure the black window still shows "running". Re-run `npm start`. |
| Website loads but says "WebSDK failed to load" | Run `npm run build:sdk` again, then `npm start`. |

---

## 8. Simple word list (glossary)

- **WebRTC / In-browser calling:** calling through the web browser using your
  computer's mic and speakers.
- **ExoPhone / Caller ID:** the Exotel virtual number shown to customers.
- **DTMF / keypad tones:** the beeps used to navigate phone menus.
- **Provisioning:** Exotel setting up your account/agent so calling works.
- **`.env` file:** a private settings file that stores your Exotel credentials.

---

*Keep your `.env` file private — it contains your Exotel passwords/keys. Never
share it or upload it to the internet.*
