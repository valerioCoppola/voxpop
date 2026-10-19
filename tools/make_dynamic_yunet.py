"""Reproducible build of models/yunet/yunet_dynamic.onnx.

The upstream YuNet model (OpenCV Zoo, face_detection_yunet_2023mar.onnx, MIT)
declares a fixed 640x640 input, but its graph is fully size-agnostic (reshapes
use -1, upsampling uses scale factors). This script changes ONLY the declared
input/output shapes to symbolic sizes so the detector can run at the frame's
native resolution and find small, distant faces in a single pass.
No weight or operation is modified.

    python tools/make_dynamic_yunet.py
"""
import hashlib
import pathlib

import onnx

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "models/yunet/face_detection_yunet_2023mar.onnx"
DST = ROOT / "models/yunet/yunet_dynamic.onnx"
SRC_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"

data = SRC.read_bytes()
assert hashlib.sha256(data).hexdigest() == SRC_SHA256, "upstream model changed"
m = onnx.load_from_string(data)

inp = m.graph.input[0].type.tensor_type.shape.dim
inp[2].ClearField("dim_value"); inp[2].dim_param = "height"
inp[3].ClearField("dim_value"); inp[3].dim_param = "width"
del m.graph.value_info[:]  # drop cached intermediate shapes computed for 640x640
for o in m.graph.output:
    d = o.type.tensor_type.shape.dim[1]
    d.ClearField("dim_value"); d.dim_param = f"{o.name}_cells"

onnx.checker.check_model(m)
out = m.SerializeToString()
DST.write_bytes(out)
print(DST.name, hashlib.sha256(out).hexdigest())
