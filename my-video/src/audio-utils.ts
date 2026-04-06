/** Build a mono 16-bit PCM WAV and return it as a base64 data-URL. */
function makeWav(
  frequencyHz: number,
  durationSecs: number,
  sampleRate = 22050
): string {
  const n = Math.floor(sampleRate * durationSecs);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true);  // chunk size
  v.setUint16(20, 1, true);   // PCM
  v.setUint16(22, 1, true);   // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // Fade in/out 10 ms to avoid clicks
    const env = Math.min(t / 0.01, (durationSecs - t) / 0.01, 1);
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * env * 0.45;
    v.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }

  const bytes = new Uint8Array(buf);
  let b = "";
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(b)}`;
}

/** Short tick for each countdown second. */
export const TICK_SND = makeWav(880, 0.12);

/** Final (last-second) tick — slightly lower. */
export const TICK_LAST_SND = makeWav(440, 0.25);

/** C-major arpeggio fanfare for the correct-answer reveal. */
function makeFanfare(): string {
  const sampleRate = 22050;
  const noteDur = 0.25; // seconds per note
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  const total = noteDur * notes.length;
  const n = Math.floor(sampleRate * total);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, n * 2, true);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const ni = Math.min(Math.floor(t / noteDur), notes.length - 1);
    const nt = t - ni * noteDur;
    const env = Math.min(nt / 0.02, (noteDur - nt) / 0.02, 1);
    const sample = Math.sin(2 * Math.PI * notes[ni] * t) * env * 0.42;
    v.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }

  const bytes = new Uint8Array(buf);
  let b = "";
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(b)}`;
}

export const FANFARE_SND = makeFanfare();

/**
 * StreamElements TTS — free, no API key, proper CORS headers.
 * Voices: "Joanna" (warm US female), "Justin" (US male, great for kids),
 *         "Brian" (UK male), "Ivy" (US female child).
 */
export function ttsUrl(text: string, voice = "Justin"): string {
  return `https://api.streamelements.com/kappa/v2/speech?voice=${voice}&text=${encodeURIComponent(text)}`;
}
