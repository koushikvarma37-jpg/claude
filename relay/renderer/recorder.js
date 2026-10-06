// Records the microphone, draws a live waveform, stops by itself when you pause,
// and returns a small 16 kHz mono WAV (as base64) for Gemini to transcribe.
(function () {
  const TARGET_RATE = 16000;
  const MAX_MS = 15000;          // hard limit per command
  const SILENCE_MS = 1400;       // stop this long after you stop talking
  const NO_SPEECH_MS = 6000;     // give up if nothing is said
  const SPEECH_RMS = 0.02, SILENCE_RMS = 0.012;

  class Recorder {
    constructor(canvas) { this.canvas = canvas; this.active = false; }

    async start({ onAutoStop } = {}) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
      this.chunks = [];
      this.heardSpeech = false;
      this.startedAt = performance.now();
      this.lastLoud = 0;
      this.onAutoStop = onAutoStop;
      this.active = true;

      this.proc.onaudioprocess = (e) => {
        if (!this.active) return;
        const data = e.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(data));
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (rms > SPEECH_RMS) { this.heardSpeech = true; this.lastLoud = now; }
        const elapsed = now - this.startedAt;
        if (elapsed > MAX_MS) return this.autoStop("max");
        if (!this.heardSpeech && elapsed > NO_SPEECH_MS) return this.autoStop("no-speech");
        if (this.heardSpeech && rms < SILENCE_RMS && now - this.lastLoud > SILENCE_MS) return this.autoStop("silence");
      };
      src.connect(this.analyser);
      src.connect(this.proc);
      this.proc.connect(this.ctx.destination);
      this.draw();
    }

    autoStop(reason) {
      if (!this.active || this.autoStopping) return;
      this.autoStopping = true;
      setTimeout(() => this.onAutoStop && this.onAutoStop(reason), 0);
    }

    draw() {
      if (!this.active) return;
      const c = this.canvas, g = c.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const buf = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(buf);
      // centre line
      g.strokeStyle = "rgba(236,233,228,0.12)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
      // waveform, oscilloscope style
      g.strokeStyle = "#e0884e"; g.lineWidth = 1.8; g.shadowColor = "#e0884e"; g.shadowBlur = 6;
      g.beginPath();
      const step = buf.length / w;
      for (let x = 0; x < w; x++) {
        const v = buf[Math.floor(x * step)] * 2.4;
        const y = h / 2 + Math.max(-1, Math.min(1, v)) * (h / 2 - 3);
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke(); g.shadowBlur = 0;
      this.raf = requestAnimationFrame(() => this.draw());
    }

    /** Stops recording. Returns { base64, heardSpeech, ms } */
    async stop() {
      if (!this.active) return null;
      this.active = false;
      cancelAnimationFrame(this.raf);
      try { this.proc.disconnect(); } catch {}
      this.stream.getTracks().forEach((t) => t.stop());
      const rate = this.ctx.sampleRate;
      await this.ctx.close();
      const ms = performance.now() - this.startedAt;
      const merged = merge(this.chunks);
      const pcm = downsample(merged, rate, TARGET_RATE);
      return { base64: toBase64(encodeWav(pcm, TARGET_RATE)), heardSpeech: this.heardSpeech, ms };
    }

    cancel() {
      if (!this.active) return;
      this.active = false;
      cancelAnimationFrame(this.raf);
      try { this.proc.disconnect(); } catch {}
      this.stream.getTracks().forEach((t) => t.stop());
      this.ctx.close();
    }
  }

  function merge(chunks) {
    const len = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(len);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  function downsample(buf, from, to) {
    if (from === to) return buf;
    const ratio = from / to, len = Math.floor(buf.length / ratio), out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const start = Math.floor(i * ratio), end = Math.min(buf.length, Math.floor((i + 1) * ratio));
      let s = 0; for (let j = start; j < end; j++) s += buf[j];
      out[i] = s / Math.max(1, end - start); // simple averaging = basic low-pass filter
    }
    return out;
  }

  function encodeWav(samples, rate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buffer);
  }

  function toBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  window.RelayRecorder = Recorder;
  window.RelayRecorder._encodeWav = encodeWav; // exposed for tests
})();
