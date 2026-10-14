/** Minimal PCM WAV encoder / decoder (16-bit, interleaved). Used by the lab, tests and the sandbox. */

export function encodeWav16(channels: ArrayLike<number>[], sampleRate: number): Uint8Array {
  const nCh = channels.length;
  const n = channels[0].length;
  const dataBytes = n * nCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const w4 = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w4(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  w4(8, 'WAVE');
  w4(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nCh * 2, true);
  dv.setUint16(32, nCh * 2, true);
  dv.setUint16(34, 16, true);
  w4(36, 'data');
  dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      let s = channels[c][i];
      if (!(s === s)) s = 0;
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      dv.setInt16(o, Math.round(s < 0 ? s * 32768 : s * 32767), true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

export function decodeWav16(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nCh = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  let off = 12;
  let dataOff = 44;
  let dataLen = bytes.byteLength - 44;
  while (off + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    const len = dv.getUint32(off + 4, true);
    if (id === 'data') {
      dataOff = off + 8;
      dataLen = len;
      break;
    }
    off += 8 + len;
  }
  const n = Math.floor(dataLen / (nCh * 2));
  const channels = Array.from({ length: nCh }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) channels[c][i] = dv.getInt16(dataOff + (i * nCh + c) * 2, true) / 32768;
  return { sampleRate, channels };
}
