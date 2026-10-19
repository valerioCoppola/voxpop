# Third-party components

VoxPop ships these components inside the app. All are free software.

| Component | Use | Licence |
|---|---|---|
| [YuNet face detector](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), 2023mar (Shiqi Yu, OpenCV Zoo) | Finding faces to cover | MIT, see `models/yunet/LICENSE` |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (Microsoft) | Running the face model in the browser | MIT |
| [@noble/curves](https://github.com/paulmillr/noble-curves), [@noble/hashes](https://github.com/paulmillr/noble-hashes) (Paul Miller) | Verifying drand BLS signatures | MIT |
| [Trystero](https://github.com/dmotz/trystero) (Dan Motzenbecker) | Finding peers through Nostr relays and connecting them with WebRTC | MIT |
| [@noble/secp256k1](https://github.com/paulmillr/noble-secp256k1) (Paul Miller) | Signing Nostr meeting messages (via Trystero) | MIT |
| [fflate](https://github.com/101arrowz/fflate) (Arjun Barrett) | Reading and writing .voxpop ZIP files | MIT |
| [topojson-client](https://github.com/topojson/topojson-client) (Mike Bostock) | Decoding the ledger map | ISC |
| [world-atlas](https://github.com/topojson/world-atlas) (Mike Bostock), from [Natural Earth](https://www.naturalearthdata.com) | Offline land outlines for the ledger map | ISC; Natural Earth data is public domain |
| [drand quicknet](https://drand.love) (League of Entropy) | Optional public time proof; only the public key is embedded | n/a |

The Python checker uses [cryptography](https://github.com/pyca/cryptography) (Apache-2.0 / BSD) and [py_ecc](https://github.com/ethereum/py_ecc) (MIT).
