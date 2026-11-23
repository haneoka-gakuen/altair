import { useState } from "react";
import { createFilesZip } from "./archive";
import type { ProjectFile } from "./library";
import {
  decodeStoryVideoAudio,
  audioClipPlayableDuration,
  audioClipSourcePosition,
  scheduleAudioClipGain,
  type StoryAudioClip,
} from "@haneoka/vega/audio";
import type { AltairAuthoredNode } from "@haneoka/altair";
import { parseVegaStageMediaClip, stageMediaAudioClip } from "@haneoka/vega-protocol";
import { readPublicResponse } from "./public-response";
import { isTimelineReference, resolveTimelineInstance, timelinePlaybackNode } from "@haneoka/altair/documents";
import type { EditorSession } from "./session";
import { isTimeline, timelineCues, type TimelineCue, type TimelineTimingContext } from "./timeline-model";
import { downloadStudioFile } from "./studio-host";
import { tr } from "./i18n";

export const isAudioClip = (node: AltairAuthoredNode) =>
  node.type.plugin === "haneoka.altair" && node.type.name === "audioClip";

export const isMediaClip = (node: AltairAuthoredNode) =>
  node.type.plugin === "haneoka.altair" && node.type.name === "mediaClip";
interface AudioCue {
  atSeconds: number;
  durationSeconds: number;
  clip: StoryAudioClip;
}
function audioForCue(cue: TimelineCue): StoryAudioClip | undefined {
  if (isAudioClip(cue.node)) return cue.node.arguments as unknown as StoryAudioClip;
  if (
    isMediaClip(cue.node) &&
    cue.node.arguments.mediaKind === "video" &&
    cue.node.arguments.audioEnabled !== false &&
    cue.node.arguments.source
  ) {
    return stageMediaAudioClip(parseVegaStageMediaClip(cue.node.arguments), cue.node.id, cue.trackName);
  }
  return undefined;
}
const sourceKey = (clip: StoryAudioClip) => (clip.sourceKind ?? "audio") + ":" + clip.source;

function collectAudioTracks(
  cues: readonly TimelineCue[],
  timing: TimelineTimingContext,
  offset = 0,
  instance: string[] = [],
  labels: string[] = [],
  tracks = new Map<string, { name: string; clips: AudioCue[] }>(),
) {
  for (const cue of cues) {
    if (cue.node.disabled) continue;
    if (cue.playbackMuted && (isTimeline(cue.node) || isTimelineReference(cue.node))) continue;
    const atSeconds = offset + cue.atSeconds;
    const source = resolveTimelineInstance(timelinePlaybackNode(cue), timing);
    const nested = source?.node ?? (isTimeline(cue.node) ? cue.node : undefined);
    if (nested) {
      const title =
        typeof nested.arguments.title === "string" && nested.arguments.title.trim()
          ? nested.arguments.title
          : (source?.scene.name ?? tr("Timeline"));
      collectAudioTracks(
        timelineCues(nested, timing),
        timing,
        atSeconds,
        [...instance, cue.node.id],
        [...labels, title],
        tracks,
      );
    } else {
      const sound = audioForCue(cue);
      if (!sound) continue;
      const id = JSON.stringify([...instance, cue.trackId]);
      const track = tracks.get(id);
      const clip: AudioCue = {
        atSeconds,
        durationSeconds: cue.durationSeconds,
        clip: {
          ...sound,
          trackVolume: cue.trackGain ?? sound.trackVolume,
          muted: sound.muted || cue.playbackMuted || cue.playbackAudioMuted,
        },
      };
      if (track) track.clips.push(clip);
      else tracks.set(id, { name: [...labels, cue.trackName].join(" · "), clips: [clip] });
    }
  }
  return tracks;
}
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
  cues: readonly AudioCue[],
  decoded: ReadonlyMap<string, AudioBuffer>,
  duration: number,
  categoryVolumes: Record<string, number>,
): Promise<Uint8Array<ArrayBuffer>> {
  const context = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * 48000)), 48000);
  for (const cue of cues) {
    const { clip } = cue;
    if (clip.muted) continue;
    const buffer = decoded.get(sourceKey(clip));
    if (!buffer || clip.offsetSeconds >= buffer.duration) continue;
    const length = audioClipPlayableDuration(clip, buffer.duration);
    if (!length) continue;
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
    source.start(cue.atSeconds, audioClipSourcePosition(clip, buffer.duration));
    source.stop(cue.atSeconds + length);
  }
  return wav(await context.startRendering());
}

export function AudioMixExport({
  node,
  session,
  cues: allCues,
  timing,
}: {
  node: AltairAuthoredNode;
  session: EditorSession;
  cues: readonly TimelineCue[];
  timing: TimelineTimingContext;
}) {
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState("");
  let byTrack: ReturnType<typeof collectAudioTracks>;
  try {
    byTrack = collectAudioTracks(allCues, timing);
  } catch (error) {
    return (
      <div className="home-error" role="alert">
        {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }
  const tracks = [...byTrack.values()];
  const cues = tracks.flatMap((track) => track.clips);
  const exportAudio = async (stems: boolean) => {
    setBusy(true);
    setIssue("");
    try {
      const duration = Math.max(
        Number(node.arguments.durationSeconds) || 0,
        ...allCues.map((cue) => cue.atSeconds + cue.durationSeconds),
        ...cues.map((cue) => cue.atSeconds + cue.durationSeconds),
      );
      if (duration * 48000 * 2 > 32 * 1024 * 1024) throw new Error("Audio export exceeds memory limit");
      if (stems && duration * 48000 * 4 * tracks.length > 256 * 1024 * 1024)
        throw new Error("Audio export exceeds memory limit");
      const context = new OfflineAudioContext(2, 1, 48000),
        decoded = new Map<string, AudioBuffer>();
      const sounds = new Map(cues.filter(({ clip }) => !clip.muted).map(({ clip }) => [sourceKey(clip), clip]));
      for (const [key, clip] of sounds) {
        const file = session.getSnapshot().files.find((file) => file.path === clip.source);
        let bytes: Uint8Array;
        if (file) bytes = new Uint8Array(await file.blob.arrayBuffer());
        else if (/^(?:https?:\/\/|\/(?!\/))/iu.test(clip.source)) {
          bytes = await readPublicResponse(clip.source, {
            label: "Audio",
            maxBytes: 128 * 1024 * 1024,
            signals: [session.lifetimeSignal],
          });
        } else throw new Error("Audio file is missing");
        try {
          const buffer =
            clip.sourceKind === "video"
              ? await decodeStoryVideoAudio(bytes, context, session.lifetimeSignal)
              : await context.decodeAudioData(new Uint8Array(bytes).buffer);
          if (buffer) decoded.set(key, buffer);
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
        | { categoryVolumes?: Record<string, number> }
        | undefined;
      if (stems) {
        const files: ProjectFile[] = [];
        for (const [index, track] of tracks.entries())
          files.push({
            path: `${index + 1}-${track.name.replace(/[^\p{L}\p{N}_.-]/gu, "_")}.wav`,
            blob: new Blob([await mix(track.clips, decoded, duration, audio?.categoryVolumes ?? {})], {
              type: "audio/wav",
            }),
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
  if (
    !cues.length &&
    !allCues.some((cue) => cue.playbackMuted && (isTimeline(cue.node) || isTimelineReference(cue.node)))
  )
    return null;
  return (
    <details className="audio-mix-settings">
      <summary>{tr("Audio tracks")}</summary>
      <div className="timeline-toolbar">
        <button className="secondary-button" disabled={busy} onClick={() => void exportAudio(false)}>
          {tr("Export audio mix")}
        </button>
        <button className="secondary-button" disabled={busy || !tracks.length} onClick={() => void exportAudio(true)}>
          {tr("Export audio tracks")}
        </button>
      </div>
      <output className="audio-export-issue" aria-live="polite">
        {issue}
      </output>
    </details>
  );
}
