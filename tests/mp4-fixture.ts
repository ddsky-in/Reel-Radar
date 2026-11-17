const join = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
};
const box = (type: string, ...parts: Uint8Array[]) => {
  const content = join(...parts), bytes = new Uint8Array(content.length + 8);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4); bytes.set(content, 8);
  return bytes;
};
export function mp4Fixture(seconds = 12): Uint8Array {
  const timing = new Uint8Array(20), timingView = new DataView(timing.buffer);
  timingView.setUint32(12, 1000); timingView.setUint32(16, Math.round(seconds * 1000));
  const handler = new Uint8Array(12); handler.set(new TextEncoder().encode('soun'), 8);
  const samples = new Uint8Array(16), sampleView = new DataView(samples.buffer);
  sampleView.setUint32(4, 1); sampleView.setUint32(8, 1); sampleView.setUint32(12, Math.round(seconds * 1000));
  const track = box('trak', box('mdia', box('mdhd', timing), box('hdlr', handler), box('minf', box('stbl', box('stts', samples)))));
  return join(box('ftyp', new TextEncoder().encode('isom0000')), box('moov', box('mvhd', timing), track), box('mdat', new Uint8Array([1, 2, 3])));
}
