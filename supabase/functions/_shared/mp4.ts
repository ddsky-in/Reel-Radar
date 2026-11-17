interface Box { type: string; start: number; end: number }
// Parse bounded ISO-BMFF boxes, never scan arbitrary payload bytes for an apparent header.
export function mp4Duration(bytes: Uint8Array, maxDurationSeconds = 180): number {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 86400) throw new Error('Invalid media duration bound');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  let count = 0;
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      if (++count > 4096 || end - start < 8) throw new Error('Invalid media container');
      let size = view.getUint32(start), header = 8;
      const type = text(start + 4);
      if (size === 1) {
        if (end - start < 16) throw new Error('Invalid media container');
        const large = view.getBigUint64(start + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid media container');
        size = Number(large); header = 16;
      } else if (size === 0) size = end - start;
      if (size < header || size > end - start) throw new Error('Invalid media container');
      result.push({ type, start: start + header, end: start + size }); start += size;
    }
    return result;
  }
  function only(values: Box[], type: string): Box {
    const found = values.filter(value => value.type === type);
    if (found.length !== 1) throw new Error('Media timing unavailable');
    return found[0];
  }
  function duration(box: Box): { seconds: number; timescale: number } {
    const version = bytes[box.start], minimum = version === 1 ? 32 : 20;
    if (![0, 1].includes(version) || box.end - box.start < minimum) throw new Error('Media timing unavailable');
    const timescale = view.getUint32(box.start + (version === 1 ? 20 : 12));
    const ticks = version === 1 ? view.getBigUint64(box.start + 24) : BigInt(view.getUint32(box.start + 16));
    if (!timescale || ticks === 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Media timing unavailable');
    const seconds = Number(ticks) / timescale;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxDurationSeconds) throw new Error('Media duration exceeds bound');
    return { seconds, timescale };
  }
  const top = boxes(0, bytes.length);
  if (top[0]?.type !== 'ftyp' || top[0].end - top[0].start < 8 || !top.some(box => box.type === 'mdat' && box.end > box.start) || top.some(box => box.type === 'moof')) throw new Error('Unsupported media container');
  const movie = boxes(only(top, 'moov').start, only(top, 'moov').end);
  if (movie.some(box => box.type === 'mvex')) throw new Error('Fragmented media timing unavailable');
  const movieDuration = duration(only(movie, 'mvhd')).seconds;
  let audio = false, maximum = movieDuration, tracks = 0;
  for (const track of movie.filter(box => box.type === 'trak')) {
    if (++tracks > 8) throw new Error('Unsupported media tracks');
    const trackBoxes = boxes(track.start, track.end), mediaBox = only(trackBoxes, 'mdia');
    const media = boxes(mediaBox.start, mediaBox.end), handler = only(media, 'hdlr');
    if (handler.end - handler.start < 12) throw new Error('Invalid media handler');
    const kind = text(handler.start + 8);
    if (!['soun', 'vide'].includes(kind)) continue;
    const timing = duration(only(media, 'mdhd'));
    const minf = only(media, 'minf'), stbl = only(boxes(minf.start, minf.end), 'stbl');
    const stts = only(boxes(stbl.start, stbl.end), 'stts');
    if (stts.end - stts.start < 8 || bytes[stts.start] !== 0) throw new Error('Media sample timing unavailable');
    const entries = view.getUint32(stts.start + 4);
    if (!entries || entries > 20000 || stts.end - stts.start !== 8 + entries * 8) throw new Error('Invalid media sample timing');
    let ticks = 0n;
    for (let i = 0; i < entries; i++) {
      const offset = stts.start + 8 + i * 8, samples = view.getUint32(offset), delta = view.getUint32(offset + 4);
      if (!samples || !delta) throw new Error('Invalid media sample timing');
      ticks += BigInt(samples) * BigInt(delta);
      if (ticks > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid media sample timing');
    }
    const seconds = Number(ticks) / timing.timescale;
    const tolerance = Math.max(.5, timing.seconds * .02);
    if (seconds > maxDurationSeconds || Math.abs(seconds - timing.seconds) > tolerance || Math.abs(timing.seconds - movieDuration) > Math.max(1, movieDuration * .03)) throw new Error('Inconsistent media duration');
    maximum = Math.max(maximum, seconds, timing.seconds);
    if (kind === 'soun') audio = true;
  }
  if (!audio) throw new Error('Media audio unavailable');
  return maximum;
}

