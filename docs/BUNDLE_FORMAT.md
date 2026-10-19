# The .voxpop file format (`voxpop-witness/1`)

A `.voxpop` file is a standard ZIP archive with exactly these entries:

| Entry | Content |
|---|---|
| `manifest.json` | All signed records (UTF-8 JSON) |
| `video.webm` or `video.mp4` | The covered recording, byte-for-byte what was signed |
| `README.txt` | A plain-language note; not part of the verification |

ZIP timestamps are fixed to 2000-01-01, so they reveal nothing about the device clock.

## Canonical JSON

Every signed object is serialized as **canonical JSON** before hashing or signing: object keys sorted by code point, no whitespace, strings escaped as `JSON.stringify` does, and numbers that are safe integers only (no floats anywhere). The *hash* of an object means the SHA-256 of its canonical JSON, written in lowercase hex.

## manifest.json

```jsonc
{
  "format": "voxpop-witness/1",
  "header": { "rec": Header, "sig": "<base64>" },
  "chunks": [ { "rec": ChunkRecord, "sig": "<base64>" }, ... ],
  "seal":   { "rec": Seal, "sig": "<base64>" } | null,
  "beacons": [ Beacon, ... ],
  "video": { "file": "video.webm", "mime": "...", "size": <bytes>, "sha256": "<hex>" }
}
```

Verifiers must reject a manifest with missing **or extra** fields at any level.

### Header

| Field | Meaning |
|---|---|
| `v` | `1` |
| `kind` | `"header"` |
| `r` | recording ID: 128 random bits, 32 lowercase hex characters |
| `alg` | `"Ed25519"` or `"ECDSA-P256"` |
| `pub` | public key, base64. Ed25519: 32 raw bytes. P-256: 65-byte uncompressed point |
| `mime` | media type of the video, as reported by the recorder |
| `t` | start time, Unix milliseconds (device clock) |
| `cell` | `null` or `{ "la", "lo", "k" }`: the cell covering latitudes `[la/k, (la+1)/k)` and longitudes `[lo/k, (lo+1)/k)`, with `k` = 1 (~110 km) or 10 (~11 km) |
| `app` | app name and version |
| `identity` | `"one-time"` (fresh key per recording) or `"pseudonym"` (reused key) |
| `faces` | `"masked"` (full-resolution scan), `"masked-fast"` (half resolution) or `"unmasked"` |
| `audio` | `"disguised"`, `"muted"` or `"original"` |

### ChunkRecord (one per ~2 s piece of video)

| Field | Meaning |
|---|---|
| `v`, `kind` | `1`, `"chunk"` |
| `r` | recording ID (must equal the header's) |
| `i` | index: 0, 1, 2, ... |
| `t` | signing time, Unix ms |
| `n` | byte length of the piece |
| `h` | SHA-256 of the piece bytes |
| `p` | hash of the previous record: the header for `i = 0`, otherwise chunk `i-1` |
| `b` | `null`, or the latest verified drand round known when signing (must be listed in `beacons`) |

The video file is exactly the concatenation of all pieces in order.

### Seal

| Field | Meaning |
|---|---|
| `v`, `kind`, `r` | `1`, `"seal"`, recording ID |
| `count` | number of chunk records |
| `last` | hash of the last chunk record (header hash if there are none) |
| `bytes` | total video bytes |
| `t` | end time, Unix ms |
| `interrupted` | `true` if sealed after a crash or forced close, on the next app start |

### Beacon (drand quicknet)

`{ "round", "randomness", "signature" }`. Chain hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, genesis 1692803367, period 3 s. Round `r` was published at `genesis + (r-1)·3` seconds. Valid when `randomness = sha256(signature)` and the BLS signature (G1, RFC 9380 hash-to-curve, DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`) over `sha256(round as 8-byte big-endian)` verifies against the quicknet public key.

## Verification steps

1. Check the manifest structure as above.
2. Verify the header signature with `pub`.
3. Check that `video.size` and `video.mime` match. Then, for each chunk `i` in order: same `r`; `i` matches its position; `p` equals the running hash; signature valid; SHA-256 of the next `n` video bytes equals `h`; time does not go backwards by more than 5 s; `b`, if set, is listed in `beacons`.
4. Every video byte is covered by a chunk, and the file's SHA-256 equals `video.sha256`.
5. If there is a seal: valid signature, and `count`, `last` and `bytes` match. `interrupted: true` is a caution, not a failure. No seal is a caution: trailing pieces could be missing.
6. Every beacon is authentic. A chunk whose `t` is more than 30 s earlier than its beacon's publication time indicates a wrong or backdated clock (caution).
7. Report the disclosures: faces, audio, location, identity type.

Reference implementations: `src/core/verify.ts` (app) and `tools/verify_witness.py` (independent).
