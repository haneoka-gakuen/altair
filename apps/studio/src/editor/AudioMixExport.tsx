import { useState } from "react";
import { createFilesZip } from "./archive";
import type { ProjectFile } from "./library";
import { scheduleAudioClipGain, type StoryAudioClip } from "@haneoka/vega/audio";
import type { AltairAuthoredNode } from "@haneoka/altair";
import type { EditorSession } from "./session";
import type { TimelineCue } from "./timeline-model";
import { downloadStudioFile } from "./studio-host";
import { tr } from "./i18n";

export const isAudioClip = (node: AltairAuthoredNode) =>
  node.type.plugin === "haneoka.altair" && node.type.name === "audioClip";
function wav(buffer: AudioBuffer): Uint8Array<ArrayBuffer> {
  const channels = buffer.numberOfChannels,
    bytes = new Uint8Array(44 + buffer.length * channels * 2),
    view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length - 44, true);
  const data = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
  for (let frame = 0; frame < buffer.length; frame++)
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.max(-1, Math.min(1, data[channel]![frame]!));
      view.setInt16(44 + (frame * channels + channel) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
  return bytes;
}

async function mix(
  cues: readonly TimelineCue[],
  decoded: ReadonlyMap<string, AudioBuffer>,
  duration: number,
  categoryVolumes: Record<string, number>,
): Promise<Uint8Array<ArrayBuffer>> {
  const context = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * 48000)), 48000);
  for (const cue of cues) {
    const clip = cue.node.arguments as unknown as StoryAudioClip,
      buffer = decoded.get(clip.source)!;
    if (clip.muted || clip.offsetSeconds >= buffer.duration) continue;
    const length = clip.loop
      ? clip.durationSeconds
      : Math.min(clip.durationSeconds, (buffer.duration - clip.offsetSeconds) / clip.playbackRate);
    const source = context.createBufferSource(),
      gain = context.createGain();
    source.buffer = buffer;
    source.loop = clip.loop;
    source.loopStart = clip.offsetSeconds;
    source.loopEnd = buffer.duration;
    source.playbackRate.value = clip.playbackRate;
    source.connect(gain);
    gain.connect(context.destination);
    scheduleAudioClipGain(
      gain.gain,
      { ...clip, durationSeconds: length },
      cue.atSeconds,
      0,
      clip.volume * clip.trackVolume * (categoryVolumes[clip.category] ?? (clip.category === "Bgm" ? 0.7 : 1)),
    );
    source.start(cue.atSeconds, clip.offsetSeconds);
    source.stop(cue.atSeconds + length);
  }
  return wav(await context.startRendering());
}

export function AudioMixExport({
  node,
  session,
  cues: allCues,
}: {
  node: AltairAuthoredNode;
  session: EditorSession;
  cues: readonly TimelineCue[];
}) {
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState("");
  const cues = allCues.filter((cue) => isAudioClip(cue.node)),
    tracks = [...new Set(cues.map((cue) => String(cue.node.arguments.trackName)))];
  const changeTrack = (name: string, key: "trackVolume" | "muted", value: number | boolean) =>
    session.editNode(node.id, (current) => ({
      ...current,
      children: current.children?.map((child) =>
        isAudioClip(child) && child.arguments.trackName === name
          ? { ...child, arguments: { ...child.arguments, [key]: value } }
          : child,
      ),
    }));
  const exportAudio = async (stems: boolean) => {
    setBusy(true);
    setIssue("");
    try {
      const duration = Math.max(
        Number(node.arguments.durationSeconds) || 0,
        ...cues.map((cue) => cue.atSeconds + cue.durationSeconds),
      );
      if (duration * 48000 * 2 > 32 * 1024 * 1024) throw new Error("Audio export exceeds memory limit");
      if (stems && duration * 48000 * 4 * tracks.length > 256 * 1024 * 1024)
        throw new Error("Audio export exceeds memory limit");
      const context = new OfflineAudioContext(2, 1, 48000),
        decoded = new Map<string, AudioBuffer>();
      for (const source of new Set(cues.map((cue) => String(cue.node.arguments.source)))) {
        const file = session.getSnapshot().files.find((file) => file.path === source);
        if (!file) throw new Error("Audio file is missing");
        try {
          decoded.set(source, await context.decodeAudioData(await file.blob.arrayBuffer()));
        } catch (error) {
          throw new Error("Audio file cannot be decoded", { cause: error });
        }
        if (
          [...decoded.values()].reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0) >
          128 * 1024 * 1024
        )
          throw new Error("Audio export exceeds memory limit");
      }
      const audio = session.getSnapshot().project?.runtime?.audio as
        { categoryVolumes?: Record<string, number> } | undefined;
      if (stems) {
        const files: ProjectFile[] = [];
        for (const [index, name] of tracks.entries())
          files.push({
            path: `${index + 1}-${name.replace(/[^\p{L}\p{N}_.-]/gu, "_")}.wav`,
            blob: new Blob(
              [
                await mix(
                  cues.filter((cue) => cue.node.arguments.trackName === name),
                  decoded,
                  duration,
                  audio?.categoryVolumes ?? {},
                ),
              ],
              { type: "audio/wav" },
            ),
          });
        downloadStudioFile(await createFilesZip(files), "audio-tracks.zip");
      } else
        downloadStudioFile(
          new Blob([await mix(cues, decoded, duration, audio?.categoryVolumes ?? {})], { type: "audio/wav" }),
          "audio-mix.wav",
        );
    } catch (error) {
      setIssue(tr(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };
  if (!cues.length) return null;
  return (
    <details className="audio-mix-settings">
      <summary>{tr("Audio tracks")}</summary>
      {tracks.map((name) => {
        const clip = cues.find((cue) => cue.node.arguments.trackName === name)!.node;
        return (
          <div className="audio-track-settings" key={name}>
            <span>{name}</span>
            <label className="field">
              <span>{tr("Track volume")}</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={Number(clip.arguments.trackVolume)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value >= 0 && value <= 1) changeTrack(name, "trackVolume", value);
                }}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={clip.arguments.muted === true}
                onChange={(event) => changeTrack(name, "muted", event.target.checked)}
              />
              {tr("Muted")}
            </label>
          </div>
        );
      })}
      <div className="timeline-toolbar">
        <button className="secondary-button" disabled={busy} onClick={() => void exportAudio(false)}>
          {tr("Export audio mix")}
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => void exportAudio(true)}>
          {tr("Export audio tracks")}
        </button>
      </div>
      <output className="audio-export-issue" aria-live="polite">
        {issue}
      </output>
    </details>
  );
}
