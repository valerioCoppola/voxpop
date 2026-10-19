#!/usr/bin/env python3
"""Independent checker for VoxPop witness files (.voxpop).

A second implementation, written separately from the app, so nobody has to
trust VoxPop's own code to check a recording. It repeats every check the app
does: structure, signatures, the hash chain over every video piece, the seal,
and the drand public-time beacons.

    python tools/verify_witness.py recording.voxpop
    python tools/verify_witness.py recording.voxpop --json
    python tools/verify_witness.py recording.voxpop --skip-beacons   # faster

Exit code 0 = passed, 1 = failed, 2 = could not run.
Requires: pip install -r tools/requirements.txt
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import re
import sys
import zipfile

FORMAT = "voxpop-witness/1"
QUICKNET_PK = bytes.fromhex(
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d"
    "1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
)
QUICKNET_GENESIS = 1692803367
QUICKNET_PERIOD = 3
BLS_DST = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_"
CLOCK_SLACK_MS = 30_000
MAX_BYTES = 2 * 1024**3

HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX32 = re.compile(r"^[0-9a-f]{32}$")
B64 = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


class Fail(Exception):
    def __init__(self, title: str, detail: str):
        super().__init__(f"{title}: {detail}")
        self.title, self.detail = title, detail


# ---------------------------------------------------------------- helpers

def canonical(obj) -> bytes:
    """Same canonical JSON as the app: sorted keys, no spaces, integers only."""
    def check(v):
        if isinstance(v, bool) or v is None or isinstance(v, str):
            return
        if isinstance(v, int):
            if abs(v) > 2**53 - 1:
                raise Fail("File structure", "number out of safe range")
            return
        if isinstance(v, float):
            raise Fail("File structure", "floating-point number in signed data")
        if isinstance(v, list):
            for x in v:
                check(x)
            return
        if isinstance(v, dict):
            for x in v.values():
                check(x)
            return
        raise Fail("File structure", f"unsupported value {type(v).__name__}")
    check(obj)
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def obj_hash(obj) -> str:
    return hashlib.sha256(canonical(obj)).hexdigest()


def is_int(v, lo=0) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= 2**53 - 1


def exact(o, keys) -> bool:
    return isinstance(o, dict) and sorted(o.keys()) == sorted(keys)


def valid_cell(c) -> bool:
    return (exact(c, ["la", "lo", "k"]) and c["k"] in (1, 10) and is_int(c["la"], -90 * c["k"])
            and c["la"] < 90 * c["k"] and is_int(c["lo"], -180 * c["k"]) and c["lo"] < 180 * c["k"])


def describe_cell(c) -> str:
    lat, lon = (c["la"] + 0.5) / c["k"], (c["lo"] + 0.5) / c["k"]
    d = 2 if c["k"] == 10 else 1
    size = "~11 km" if c["k"] == 10 else "~110 km"
    return f"{abs(lat):.{d}f}°{'N' if lat >= 0 else 'S'} {abs(lon):.{d}f}°{'E' if lon >= 0 else 'W'} ({size} area)"


def iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- crypto

def make_verifier(alg: str, pub_b64: str):
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, ed25519
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    raw = base64.b64decode(pub_b64)
    if alg == "Ed25519":
        key = ed25519.Ed25519PublicKey.from_public_bytes(raw)

        def verify(obj, sig_b64):
            try:
                key.verify(base64.b64decode(sig_b64), canonical(obj))
                return True
            except InvalidSignature:
                return False
    elif alg == "ECDSA-P256":
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)

        def verify(obj, sig_b64):
            sig = base64.b64decode(sig_b64)
            if len(sig) != 64:
                return False
            der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
            try:
                key.verify(der, canonical(obj), ec.ECDSA(hashes.SHA256()))
                return True
            except InvalidSignature:
                return False
    else:
        raise Fail("Recording key", f"unknown algorithm {alg!r}")
    return verify


def verify_beacon(b) -> bool:
    """drand quicknet: BLS signature on G1 over sha256(round, 8-byte big-endian)."""
    from py_ecc.bls.hash_to_curve import hash_to_G1
    from py_ecc.bls.point_compression import decompress_G1, decompress_G2
    from py_ecc.optimized_bls12_381 import FQ12, G2, final_exponentiate, neg
    from py_ecc.optimized_bls12_381 import optimized_pairing as op

    sig = bytes.fromhex(b["signature"])
    if hashlib.sha256(sig).hexdigest() != b["randomness"]:
        return False
    try:
        pk = decompress_G2((int.from_bytes(QUICKNET_PK[:48], "big"), int.from_bytes(QUICKNET_PK[48:], "big")))
        s = decompress_G1(int.from_bytes(sig, "big"))
    except Exception:
        return False
    h = hash_to_G1(hashlib.sha256(b["round"].to_bytes(8, "big")).digest(), BLS_DST, hashlib.sha256)
    return final_exponentiate(op.miller_loop(neg(G2), s) * op.miller_loop(pk, h)) == FQ12.one()


def round_time_ms(r: int) -> int:
    return (QUICKNET_GENESIS + (r - 1) * QUICKNET_PERIOD) * 1000


# ---------------------------------------------------------------- structure

def check_structure(m):
    if not exact(m, ["format", "header", "chunks", "seal", "beacons", "video"]):
        raise Fail("File structure", "manifest has unexpected or missing fields")
    if m["format"] != FORMAT:
        raise Fail("File structure", f"unknown format {m['format']!r}")
    hs = m["header"]
    h = hs.get("rec") if isinstance(hs, dict) else None
    ok = (exact(hs, ["rec", "sig"]) and exact(h, ["v", "kind", "r", "alg", "pub", "mime", "t", "cell", "app", "identity", "faces", "audio"])
          and h["v"] == 1 and h["kind"] == "header" and isinstance(h["r"], str) and HEX32.match(h["r"])
          and h["alg"] in ("Ed25519", "ECDSA-P256") and isinstance(h["pub"], str) and B64.match(h["pub"])
          and isinstance(h["mime"], str) and re.match(r"^video/(webm|mp4)(;[a-z0-9=.,\- ]*)?$", h["mime"], re.I) and is_int(h["t"]) and (h["cell"] is None or valid_cell(h["cell"]))
          and isinstance(h["app"], str) and h["identity"] in ("one-time", "pseudonym")
          and h["faces"] in ("masked", "masked-fast", "unmasked") and h["audio"] in ("disguised", "muted", "original")
          and isinstance(hs["sig"], str) and B64.match(hs["sig"]))
    if not ok:
        raise Fail("File structure", "header is malformed")
    if not isinstance(m["chunks"], list):
        raise Fail("File structure", "chunk list is malformed")
    for i, c in enumerate(m["chunks"]):
        r = c.get("rec") if isinstance(c, dict) else None
        ok = (exact(c, ["rec", "sig"]) and exact(r, ["v", "kind", "r", "i", "t", "n", "h", "p", "b"]) and r["v"] == 1
              and r["kind"] == "chunk" and isinstance(r["r"], str) and HEX32.match(r["r"]) and is_int(r["i"]) and is_int(r["t"])
              and is_int(r["n"], 1) and isinstance(r["h"], str) and HEX64.match(r["h"]) and isinstance(r["p"], str)
              and HEX64.match(r["p"]) and (r["b"] is None or is_int(r["b"], 1)) and isinstance(c["sig"], str) and B64.match(c["sig"]))
        if not ok:
            raise Fail("File structure", f"chunk record {i} is malformed")
    s = m["seal"]
    if s is not None:
        r = s.get("rec") if isinstance(s, dict) else None
        ok = (exact(s, ["rec", "sig"]) and exact(r, ["v", "kind", "r", "count", "last", "bytes", "t", "interrupted"])
              and r["v"] == 1 and r["kind"] == "seal" and isinstance(r["r"], str) and HEX32.match(r["r"]) and is_int(r["count"])
              and isinstance(r["last"], str) and HEX64.match(r["last"]) and is_int(r["bytes"]) and is_int(r["t"])
              and isinstance(r["interrupted"], bool) and isinstance(s["sig"], str) and B64.match(s["sig"]))
        if not ok:
            raise Fail("File structure", "seal is malformed")
    for b in m["beacons"] if isinstance(m["beacons"], list) else [None]:
        if not (exact(b, ["round", "randomness", "signature"]) and is_int(b["round"], 1) and isinstance(b["randomness"], str)
                and HEX64.match(b["randomness"]) and isinstance(b["signature"], str) and re.match(r"^[0-9a-f]{96}$", b["signature"])):
            raise Fail("File structure", "beacon list is malformed")
    v = m["video"]
    if not (exact(v, ["file", "mime", "size", "sha256"]) and v["file"] in ("video.webm", "video.mp4") and isinstance(v["mime"], str)
            and is_int(v["size"]) and isinstance(v["sha256"], str) and HEX64.match(v["sha256"])):
        raise Fail("File structure", "video entry is malformed")


# ---------------------------------------------------------------- main check

def verify(path: str, skip_beacons: bool):
    checks = []
    add = lambda level, title, detail: checks.append({"level": level, "title": title, "detail": detail})
    try:
        try:
            z = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            raise Fail("Opening the file", "not a ZIP archive")
        names = {i.filename: i for i in z.infolist()}
        if "manifest.json" not in names:
            raise Fail("Opening the file", "manifest.json is missing")
        if sum(i.file_size for i in z.infolist() if i.filename in ("manifest.json", "video.webm", "video.mp4")) > MAX_BYTES:
            raise Fail("Opening the file", "archive expands beyond 2 GB")
        try:
            m = json.loads(z.read("manifest.json").decode("utf-8"))
        except ValueError:
            raise Fail("Opening the file", "manifest.json is not valid JSON")
        check_structure(m)
        if m["video"]["file"] not in names:
            raise Fail("Opening the file", "the video file is missing")
        video = z.read(m["video"]["file"])
        add("pass", "File structure", "All fields are present and well-formed.")

        h = m["header"]["rec"]
        try:
            ver = make_verifier(h["alg"], h["pub"])
        except Fail:
            raise
        except Exception:
            raise Fail("Recording key", "the public key cannot be loaded")
        fp = hashlib.sha256(base64.b64decode(h["pub"])).hexdigest()
        fp = f"{fp[0:4]}-{fp[4:8]}-{fp[8:12]}"
        if not ver(h, m["header"]["sig"]):
            raise Fail("Header signature", "the header was not signed by the recording key")
        add("pass", "Header signature", f"Signed by key {fp} ({h['identity']}).")

        if m["video"]["mime"] != h["mime"]:
            raise Fail("Video type", "the video type differs from the signed header")
        if len(video) != m["video"]["size"]:
            raise Fail("Video size", f"expected {m['video']['size']} bytes, file has {len(video)}")
        prev, off, last_t = obj_hash(h), 0, h["t"]
        rounds = {b["round"] for b in m["beacons"]}
        for i, c in enumerate(m["chunks"]):
            r = c["rec"]
            if r["r"] != h["r"]:
                raise Fail("Chain", f"chunk {i} belongs to a different recording")
            if r["i"] != i:
                raise Fail("Chain", f"chunk {i} is out of order")
            if r["p"] != prev:
                raise Fail("Chain", f"chunk {i} does not link to the previous record")
            if not ver(r, c["sig"]):
                raise Fail("Chain", f"chunk {i} signature is invalid")
            if off + r["n"] > len(video):
                raise Fail("Chain", f"chunk {i} runs past the end of the video")
            if hashlib.sha256(video[off:off + r["n"]]).hexdigest() != r["h"]:
                raise Fail("Chain", f"chunk {i} video data was modified after signing")
            if r["t"] + 5000 < last_t:
                raise Fail("Chain", f"chunk {i} time goes backwards")
            if r["b"] is not None and r["b"] not in rounds:
                raise Fail("Chain", f"chunk {i} references a time beacon that is not included")
            last_t = max(last_t, r["t"])
            off += r["n"]
            prev = obj_hash(r)
        if off != len(video):
            raise Fail("Chain", f"{len(video) - off} bytes of video are not covered by any signed chunk")
        if hashlib.sha256(video).hexdigest() != m["video"]["sha256"]:
            raise Fail("Video checksum", "the whole-file checksum does not match")
        add("pass", "Every chunk", f"{len(m['chunks'])} chunks, each signed and linked to the one before.")

        sealed, end = "unsealed", last_t
        if m["seal"]:
            s = m["seal"]["rec"]
            if s["r"] != h["r"] or not ver(s, m["seal"]["sig"]):
                raise Fail("Seal", "the seal signature is invalid")
            if s["count"] != len(m["chunks"]) or s["last"] != prev or s["bytes"] != off:
                raise Fail("Seal", "the seal does not match the chunks: the end was cut or replaced")
            sealed, end = ("interrupted" if s["interrupted"] else "sealed"), s["t"]
            add("warn" if s["interrupted"] else "pass", "Seal",
                "Interrupted and sealed on next start." if s["interrupted"] else "Closed normally; nothing can be cut from the end.")
        else:
            add("warn", "Seal", "No seal: chunks after the last one could be missing.")

        earliest = None
        if m["beacons"]:
            if skip_beacons:
                add("warn", "Public time proof", f"{len(m['beacons'])} beacon(s) present but NOT checked (--skip-beacons).")
            else:
                for b in m["beacons"]:
                    if not verify_beacon(b):
                        raise Fail("Public time proof", f"beacon round {b['round']} is not authentic")
            back = 0
            for c in m["chunks"]:
                r = c["rec"]
                if r["b"] is None:
                    continue
                bt = round_time_ms(r["b"])
                earliest = bt if earliest is None else min(earliest, bt)
                if r["t"] + CLOCK_SLACK_MS < bt:
                    back += 1
            if not skip_beacons:
                add("pass", "Public time proof", f"{len(m['beacons'])} drand beacon(s) verified; signed no earlier than {iso(earliest) if earliest else 'n/a'}.")
            if back:
                add("warn", "Device clock", f"{back} chunk time(s) earlier than the public beacon allows.")
        else:
            add("info", "Public time proof", "Not used; times come only from the device clock.")

        add("warn" if h["faces"] == "unmasked" else "info", "Faces", {"masked": "covered, full-resolution scan", "masked-fast": "covered, fast scan (distant faces may be missed)", "unmasked": "NOT covered"}[h["faces"]])
        add("warn" if h["audio"] == "original" else "info", "Audio", {"disguised": "voices pitch-shifted", "muted": "no audio", "original": "original voices"}[h["audio"]])
        add("info", "Location", describe_cell(h["cell"]) if h["cell"] else "not shared")
        summary = {"recordingId": h["r"], "key": fp, "start": iso(h["t"]), "end": iso(end),
                   "seconds": round(max(0, end - h["t"]) / 1000, 1), "chunks": len(m["chunks"]), "bytes": off,
                   "sealed": sealed, "earliestProvenTime": iso(earliest) if earliest else None}
        return True, checks, summary
    except Fail as f:
        add("fail", f.title, f.detail)
        return False, checks, None


def main() -> int:
    ap = argparse.ArgumentParser(description="Check a VoxPop witness recording (.voxpop) independently.")
    ap.add_argument("file")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--skip-beacons", action="store_true", help="do not check drand signatures (faster)")
    a = ap.parse_args()
    try:
        ok, checks, summary = verify(a.file, a.skip_beacons)
    except ImportError as e:
        print(f"missing dependency: {e.name}. Run: pip install -r tools/requirements.txt", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"cannot read file: {e}", file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps({"ok": ok, "checks": checks, "summary": summary}, indent=2, ensure_ascii=False))
    else:
        mark = {"pass": "PASS", "fail": "FAIL", "warn": "WARN", "info": "NOTE"}
        for c in checks:
            print(f"[{mark[c['level']]}] {c['title']}: {c['detail']}")
        print()
        print("RESULT: intact and authentic" if ok else "RESULT: did NOT pass")
        if summary:
            print(f"        {summary['seconds']} s, {summary['chunks']} pieces, from {summary['start']}, key {summary['key']}, {summary['sealed']}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
