import workletUrl from './pitch.worklet.js?url';

/**
 * Builds the audio track that gets recorded.
 *  - 'disguised': pitch-shifted by a random ratio chosen per recording and never
 *    stored, so it can't simply be read from the file and reversed.
 *  - 'muted': no audio track at all (strongest protection).
 *  - 'original': untouched microphone audio.
 *
 * Honest limit: pitch shifting stops casual recognition by ear. A determined
 * analyst can estimate and partly undo it. Use 'muted' when a voice must not
 * be identifiable at all.
 */
export class VoiceChain {
  private ctx: AudioContext | null = null;
  track: MediaStreamTrack | null = null;

  static randomRatio(): number {
    const r = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    // Either lower (0.72–0.82) or higher (1.22–1.34): never close to 1.
    return r < 0.6 ? 0.72 + (r / 0.6) * 0.1 : 1.22 + ((r - 0.6) / 0.4) * 0.12;
  }

  async build(mic: MediaStream | null, mode: 'disguised' | 'muted' | 'original'): Promise<MediaStreamTrack | null> {
    this.stop();
    if (mode === 'muted' || !mic || !mic.getAudioTracks().length) return null;
    if (mode === 'original') {
      this.track = mic.getAudioTracks()[0].clone();
      return this.track;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(mic);
    const shifter = new AudioWorkletNode(ctx, 'voxpop-pitch', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ratio: VoiceChain.randomRatio() },
    });
    const dest = ctx.createMediaStreamDestination();
    src.connect(shifter).connect(dest);
    if (ctx.state === 'suspended') await ctx.resume();
    this.track = dest.stream.getAudioTracks()[0];
    return this.track;
  }

  stop() {
    this.track?.stop();
    this.track = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
