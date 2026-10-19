# Security model

VoxPop is meant for people who may face retaliation for what they record. This page states plainly what the app protects and what it cannot. If you find a weakness, please report it (see the end of this page).

## Who we defend against

| Adversary | What VoxPop does |
|---|---|
| Someone who receives or intercepts a shared recording and wants to identify people in it | Faces are covered with solid shapes before any frame is saved. Voices are pitch-shifted by a random, unstored amount, or not recorded at all. No name, account, device ID or exact position is in the file. |
| Someone who wants to fake or edit a recording | Every ~2 s piece is hashed, linked to the previous piece and signed. A signed seal closes the chain. Any change, removal, insertion or reordering fails verification, in the app and in the independent Python checker. |
| Someone who claims a video is old or pre-recorded | With time proof on, a public drand beacon value is burned into the frames and referenced in the signed records. Neither could exist before that beacon was published. |
| Someone who seizes the phone | Recordings are encrypted at rest. With a passphrase set, they can't be watched or exported without it, even with the app open. Recording still works while locked. A held panic button deletes all keys and data. |
| Someone watching network traffic | Outside a room, VoxPop makes no network requests except the drand beacon when time proof is on. In a room, all video and data travel end-to-end encrypted. |
| Someone linking your recordings together | By default each recording is signed with a fresh one-time key, so two recordings can't be tied to the same person by their keys. |

## Live rooms (Agora)

| Who | What they can see |
|---|---|
| People in the same room | Your chosen display name, your live picture and disguised voice while you broadcast, and **your IP address** (WebRTC connects devices directly). An IP address reveals approximate area and internet provider. |
| Public Nostr relays | That a device at your IP address is using some room. The connection details are encrypted with a key derived from the room password, or from the room name for public rooms. A relay operator who guesses a public room's name can read them. |
| Public STUN servers (Google, Cloudflare) | Your IP address, when your device asks for its public address. |
| Anyone else on the network | Encrypted traffic only: WebRTC media and data are end-to-end encrypted (DTLS-SRTP). |

- **What is sent live** is the same covered, voice-disguised canvas that is recorded. Raw camera frames never leave the phone.
- **The live picture itself is not signed.** It is a normal video stream: trust it like any live video. Its burned-in text (time, recording ID, drand beacon) helps. **Saved copies are verified**: each piece is checked against the recorder's signature and the chain as it arrives, and anything that fails is refused and listed in the Ledger.
- **Nothing is stored on a viewer's device** unless they tap "Save a copy". A recorder who turns off "also save" keeps nothing either.
- **Display names are not identities.** Anyone can choose any name. Recording keys are separate from names.
- **Public rooms are public.** Anyone who knows or guesses the name can join and watch. Use a password for private rooms.
- **Use a VPN** if revealing your IP address to room members is a risk. WebRTC does not work over Tor.

## What VoxPop cannot protect against

- **A compromised phone.** Spyware with access to the camera, the screen or the browser sees everything before VoxPop can protect it.
- **What the picture shows besides faces.** Places, clothes, tattoos, gait, car plates, voices of people who are not near the microphone, reflections. Only faces are covered.
- **Missed faces.** The detector can miss faces that are very small (under about 14 px wide), strongly turned away, heavily occluded, or in very poor light. Each frame also keeps the covers from the previous two checked frames, which hides single-frame misses. The "Cover near faces" fast scan misses distant faces much more often, and recordings made with it say so.
- **Voice forensics.** Pitch shifting stops recognition by ear. A skilled analyst can estimate the shift and partly undo it. Use "No audio" when a voice must not be identifiable.
- **Staged scenes.** Signatures prove a file was not changed after recording and, with time proof, when it was signed. They do not prove the scene was real or who filmed it. Independent corroborating recordings, which come in a later release, address this.
- **The beacon request.** With time proof on, the drand servers (api.drand.sh, drand.cloudflare.com) see your IP address and that you fetched a beacon.
- **Coarse location in sparse areas.** An ~11 km cell can identify a small town. A reused pseudonym key with many recordings in one cell can reveal where someone lives.
- **Forensic recovery without a passphrase.** In device mode (no passphrase) the vault key is stored in the browser profile next to the encrypted data. A full forensic copy of an unlocked phone could recover both. After a panic wipe the keys are deleted, but flash storage may keep old blocks until they are overwritten. Set a passphrase if this matters to you.
- **Files you already shared.** Once a file is out, it is out.

## Cryptography

| Purpose | Algorithm |
|---|---|
| Piece hashes, chain links, file checksum | SHA-256 |
| Recording signatures | Ed25519 (WebCrypto), fallback ECDSA P-256 with SHA-256, raw r‖s signatures |
| Signed data encoding | Canonical JSON: sorted keys, no whitespace, integers only |
| Encryption at rest | AES-256-GCM, a random 96-bit IV per piece, recording ID and piece index as associated data |
| Per-recording key | ECDH P-256 (ephemeral × vault key), then HKDF-SHA256 |
| Vault private key protection | AES-256-GCM under a random device key, or under PBKDF2-SHA256 (600,000 rounds, 128-bit salt) from the passphrase |
| Public time proof | drand quicknet, BLS12-381 signatures on G1 (`bls-unchained-g1-rfc9380`), verified on the device with @noble/curves |

Private signing keys are created as non-extractable WebCrypto keys: the app can sign with them, but no script can read them out. One-time keys are deleted when the recording is sealed.

## Hardening in the app

- A strict Content Security Policy: scripts, workers, models and styles only from the app's own origin, and `wasm-unsafe-eval` for the face detector. Network access is limited to secure WebSockets (Nostr relays, so users can pick relays that work where they live) and the two drand mirrors. No inline scripts and no `eval`.
- Peers can only push recording data to a viewer who asked for a copy from that specific peer, within a size limit. Every piece is verified before storage.
- Everything is bundled and served from one origin, with no CDNs, web fonts or analytics. The face model's SHA-256 is pinned at build time.
- Received files are parsed defensively: size limits, only expected ZIP entries, exact field sets (unknown fields are rejected), and text is always rendered as text, never as HTML.
- Same-origin isolation (COOP/COEP) is set by the server or by the service worker.
- Raw camera frames are never stored and never reach the recorder. Only the covered canvas is recorded.

## Reporting a vulnerability

Please don't open a public issue for a security problem that could put users at risk. Contact the maintainers privately through the repository's security advisory feature ("Report a vulnerability"), with steps to reproduce. We will credit you unless you prefer otherwise.
