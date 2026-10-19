# VoxPop

VoxPop is a free, open-source agora for live political video: people anywhere can show what is happening around them, safely, and anyone can check that what they see is real. No accounts, no company, no ads, no money. Ever.

VoxPop has two parts:

- **Agora:** live rooms. People who type the same room name meet, see who is there, and watch each other live, directly device to device, with no server of ours in between. Watching stores nothing. A viewer can choose to **save a copy**, and then every piece is verified as it arrives.
- **Witness:** the recorder. Faces are covered and voices disguised on the phone before anything leaves the camera, whether it is recorded, streamed or both.

What Witness does, all on the phone:

- **Faces are covered before anything is saved.** Every camera frame is scanned for faces on the device, and only the covered frame is shown or recorded. If face protection is not ready, the picture is blurred beyond recognition instead (it fails closed).
- **Voices are disguised.** Pitch is shifted by a random amount chosen per recording and never stored. Or record with no audio at all.
- **Every 2 seconds of video is signed.** Each piece carries the hash of the piece before it, so removing, editing or reordering anything is detectable by anyone.
- **Optional public time proof.** A public random number from the [drand](https://drand.love) beacon is burned into the picture, proving the video was made after that moment.
- **Location is coarse or absent.** Off by default; when on, only an ~11 km or ~110 km grid square is kept. Your exact position is never stored.
- **Encrypted on the device, wiped in two seconds.** Recordings are encrypted at rest, optionally behind a passphrase, and a held "panic wipe" button destroys the keys.
- **A transparent ledger.** Every recording you hold, yours or received, is listed with all its public facts on an offline world map. Files that fail checks are listed too, but never played.
- **Works offline once installed.** It is a web app you install from the browser to your home screen. No app store needed.

## Agora: live rooms

1. Open **Agora** and type a room name (for example `agora`, a city or a cause). Add a password for a private room.
2. Everyone who joins with the same name meets there.
3. Go to **Witness** and press record to **go live**. Everyone in the room sees your covered, voice-disguised picture.
4. Choose whether your broadcast is also saved on your phone ("When I go live, also save the recording on this phone"). With it off, you only stream: nothing is stored and it uses less battery.
5. Viewers just watch: nothing is stored on their phones. If the recorder is saving, a viewer can tap **Save a copy**. They then receive the signed pieces from the beginning, each verified before it is kept, and the copy lands in their Ledger.

**How people find each other without a server.** Browsers can't discover each other on their own. They need a first "here I am" message. VoxPop sends that message, encrypted, through public **Nostr relays**: free servers run by volunteers worldwide (8 by default, editable in Safety). After that, video flows directly between the devices over WebRTC, end-to-end encrypted. Public STUN servers (Google, Cloudflare) help each device learn its public address. This costs nothing and needs no account anywhere.

**Limits of this version:**
- Joining a room reveals your IP address to the people in it and to the relays (see SECURITY.md).
- Each viewer receives the stream directly from the recorder, so a phone can serve roughly 5–10 viewers before its upload runs out. Passing streams on from viewer to viewer is the next step.
- Some mobile networks block direct connections. Then two people on different networks may not connect without a TURN relay, which VoxPop does not provide because it costs money; you can add one in Safety. On the same Wi-Fi it always works.

## Publish it for free (GitHub Pages)

Two people on different devices only need to open the same web address.

1. Create a **public** repository on GitHub. Consider a pseudonymous account: the address will contain the account name.
2. Push this repository to it (`git remote add origin …` then `git push -u origin main`).
3. On GitHub: **Settings → Pages → Source: GitHub Actions**.
4. The included workflow (`.github/workflows/pages.yml`) tests, builds and publishes on every push. The app appears at `https://<account>.github.io/<repository>/`.

GitHub Pages serves over valid HTTPS, so the camera, installing to the home screen and offline use all work. Other free static hosts work too: Cloudflare Pages, Netlify, Codeberg Pages. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
npm start          # builds, then serves at http://localhost:4173
```

Open http://localhost:4173 in Chrome, Edge, Firefox or Safari. For development with live reload, use `npm run dev` (http://localhost:5173).

## Test on a phone

Phones only allow the camera on `https://` pages, so VoxPop includes a command that serves it to your local network with a temporary certificate made on your computer. Nothing goes through the internet.

1. Connect the phone and the computer to the **same Wi-Fi**.
2. On the computer run:
   ```bash
   npm run phone
   ```
   It prints an address like `https://192.168.1.23:4443/` and a QR code.
3. On the phone, scan the QR code or type the address.
4. The phone warns that the connection is not private. That is the local test certificate, so it's expected.
   - **Android Chrome:** tap *Advanced*, then *Proceed*.
   - **iPhone Safari:** tap *Show Details*, then *visit this website*.
5. Tap **Start camera** and allow the camera and microphone.

**Two users, one PC and one phone:** keep `npm run phone` running, open `https://localhost:4443` in the PC's browser (accept the same warning), and open the printed address on the phone. These are two separate users: each browser has its own storage, keys and name. Join the same room on both, then go live from either one. Both devices need internet access, because the rooms meet through public relays.

**If the phone can't open the page:**
- The computer's firewall may block the port. On Ubuntu: `sudo ufw allow 4443/tcp`.
- Some routers and guest networks stop devices from talking to each other. Use your main network, or turn on the phone's hotspot and connect the computer to it.

**Limit of this mode:** with a self-signed certificate, browsers refuse to install the app or keep its offline copy. Recording, the ledger, verifying and the panic wipe all work. To also test install and offline use:
- **Android, by USB:** enable USB debugging on the phone, connect it, then open `chrome://inspect/#devices` on the computer and add the port-forwarding rule `4173` → `localhost:4173`. Run `npm start` and open `http://localhost:4173` on the phone. The phone treats `localhost` as secure, so everything works, including *Install*.
- **Any phone:** host `dist/` on a real HTTPS address (see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)).

## Check a recording yourself

In the app: **Verify** tab, then choose the `.voxpop` file.

Without the app, use the independent Python checker. It is a separate implementation, so you don't have to trust VoxPop's own code:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r tools/requirements.txt
python tools/verify_witness.py recording.voxpop
```

A `.voxpop` file is an ordinary ZIP archive: rename it to `.zip` to see the signed `manifest.json` and the video inside. The format is documented in [docs/BUNDLE_FORMAT.md](docs/BUNDLE_FORMAT.md).

## How a recording is made

```
camera frame ──► face detector (in a worker, on this device)
                   │  checks THIS frame; nothing is drawn until it answers
                   ▼
             covered frame + burned-in time/beacon text ──► recorder (only ever sees covered frames)
                                                              │ every 2 s
                                                              ▼
                       piece ──► SHA-256 ──► signed record linking to previous ──► AES-GCM encrypted ──► IndexedDB
                                                              │ on stop
                                                              ▼
                                                     signed seal closes the chain
```

- **Signing:** Ed25519 where the browser supports it, otherwise ECDSA P-256. One fresh key per recording by default (recordings can't be linked to each other); an optional reusable pseudonym key lets people build a track record.
- **Encryption at rest:** a per-recording AES-256-GCM key, derived by ECDH against a device "vault" key. Recording only needs the vault's public half, so you can always record instantly, even while the vault is locked. Watching or sharing needs the private half, which is protected by a passphrase if you set one (PBKDF2-SHA256, 600,000 rounds).
- **Face detection:** [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (OpenCV Zoo, MIT licence) through ONNX Runtime Web. By default it scans every frame at full resolution and finds faces down to about 14 pixels wide. Covers are solid shapes, not blurs, because blurs can be reversed.

Read [SECURITY.md](SECURITY.md) for what VoxPop protects against and, as important, what it cannot.

## Project layout

```
src/core/      signing, hash chain, live verification, drand beacon, coarse location, .voxpop format
src/net/       Agora rooms: Nostr meeting points, WebRTC live streams, verified copies on request
src/storage/   IndexedDB, encrypted vault, recordings, panic wipe
src/media/     face detector worker, frame pipeline, voice disguise, recording session
src/ui/        Witness, Agora, Ledger, Verify, Safety screens
public/        service worker (offline), web-app manifest, icons, security headers
models/yunet/  face model (upstream + size-agnostic copy built by tools/make_dynamic_yunet.py)
tools/         independent Python checker + tests, model build script
tests/         unit tests (vitest) and shared .voxpop fixtures
e2e/           browser tests (Playwright) against the production build, incl. two users in a room via a local test relay
```

## Tests

```bash
npm test                          # unit tests: crypto, chain, tampering, storage, vault, detector maths
npm run test:e2e                  # full browser run: two users live in a room, record, export, verify, tamper, offline, wipe
python -m unittest tools/test_verify_witness.py
```

For the browser tests you can feed a video with faces as the fake camera: `VOXPOP_FAKE_VIDEO=/path/clip.y4m npm run test:e2e`.

## Principles

1. **Nothing leaves your device unless you choose.** No server of ours, no analytics, no third-party code, fonts or models at runtime. Outside connections happen only when you join a room (Nostr relays, STUN, the people in the room) or turn on public time proof (drand).
2. **The safest option is the default.** Every weaker choice is explicit and is written into the signed recording, so viewers know too.
3. **Honest about limits.** The app says what each protection does and does not do.
4. **No money.** Free software under the GNU AGPL 3.0: anyone can use, study, change and share it. Anyone running a modified version for others must publish their changes.

## What comes next

Witness mode is the foundation. Next steps, roughly in order:

1. **Viewers pass the stream on**, so one phone can reach thousands, and copies can be relayed onward even after the recorder goes offline.
2. **Corroboration:** independent recordings of the same place and time back each other up.
3. **The globe:** a live map of the rooms and broadcasts happening worldwide.
4. **On-device translation:** subtitles so anyone can understand anyone.

## Licence

VoxPop is free software: GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE). Third-party components and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
