// Voice disguise: a two-tap delay-line pitch shifter running on the audio thread.
// Two read heads sweep through a short delay window at a speed set by the pitch
// ratio; their outputs are cross-faded (sin² + cos² = 1) so the sweep is seamless.
// Ratio < 1 lowers the voice, > 1 raises it. Formants shift too, which changes
// the timbre of the voice, not only its pitch.

class PitchShifter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = options.processorOptions.ratio;
    this.size = 1 << 15;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.win = Math.round(sampleRate * 0.06); // 60 ms window
    this.phase = 0;
  }

  read(delay) {
    let pos = this.w - delay;
    while (pos < 0) pos += this.size;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i & (this.size - 1)];
    const b = this.buf[(i + 1) & (this.size - 1)];
    return a + (b - a) * f;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output.length) return true;
    const inp = input.length ? input[0] : null;
    const out = output[0];
    const step = (1 - this.ratio) / this.win;
    for (let n = 0; n < out.length; n++) {
      // Mix down to mono: one disguised channel, no stereo cues about position.
      let x = 0;
      if (inp) {
        for (let c = 0; c < input.length; c++) x += input[c][n];
        x /= input.length;
      }
      this.buf[this.w] = x;
      this.phase += step;
      this.phase -= Math.floor(this.phase);
      const p2 = (this.phase + 0.5) % 1;
      const g1 = Math.sin(Math.PI * this.phase) ** 2;
      const g2 = Math.sin(Math.PI * p2) ** 2;
      const y = this.read(this.phase * this.win + 2) * g1 + this.read(p2 * this.win + 2) * g2;
      for (let c = 0; c < output.length; c++) output[c][n] = y;
      this.w = (this.w + 1) & (this.size - 1);
    }
    return true;
  }
}

registerProcessor('voxpop-pitch', PitchShifter);
