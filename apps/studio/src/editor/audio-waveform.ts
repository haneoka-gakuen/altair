import type { JsonObject } from "@haneoka/altair";

export function audioWaveformPath(buffer: AudioBuffer, args: JsonObject): string {
  const offset = Number(args.offsetSeconds) || 0,
    rate = Number(args.playbackRate) || 1,
    duration = Number(args.durationSeconds) || buffer.duration,
    available = buffer.duration - offset;
  if (available <= 0) return "";
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const peakIn = (from: number, to: number) => {
    let peak = 0;
    const start = Math.floor((offset + from) * buffer.sampleRate),
      end = Math.min(buffer.length, Math.ceil((offset + to) * buffer.sampleRate));
    for (const channel of channels)
      for (let index = start; index < end; index++) peak = Math.max(peak, Math.abs(channel[index]!));
    return peak;
  };
  const fullPeak = args.loop === true && (duration * rate) / 150 >= available ? peakIn(0, available) : undefined;
  let d = "";
  for (let bin = 0; bin < 150; bin++) {
    const from = (duration * rate * bin) / 150,
      to = (duration * rate * (bin + 1)) / 150;
    const position = args.loop === true ? from % available : from;
    let peak = fullPeak ?? (position < available ? peakIn(position, Math.min(available, position + to - from)) : 0);
    if (args.loop === true && fullPeak === undefined && position + to - from > available)
      peak = Math.max(peak, peakIn(0, position + to - from - available));
    const height = Math.max(0.5, peak * 36),
      x = bin * 4 + 2;
    d += `M${x},${(40 - height).toFixed(2)}V${(40 + height).toFixed(2)}`;
  }
  return d;
}
