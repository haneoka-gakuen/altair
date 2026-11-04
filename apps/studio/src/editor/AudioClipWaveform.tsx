import { useEffect, useMemo, useState } from "react";
import type { AltairAuthoredNode } from "@haneoka/altair";
import type { EditorSession } from "./session";
import { tr } from "./i18n";
import { audioWaveformPath } from "./audio-waveform";

export const isAudioFile = (path: string) => /\.(?:ogg|mp3|wav|m4a|flac|aac|opus)$/iu.test(path);

export function AudioClipWaveform({ node, session }: { node: AltairAuthoredNode; session: EditorSession }) {
  const source = String(node.arguments.source ?? ""),
    file = session.getSnapshot().files.find((file) => file.path === source);
  const [buffer, setBuffer] = useState<AudioBuffer>(),
    [issue, setIssue] = useState("");
  useEffect(() => {
    let current = true;
    setBuffer(undefined);
    setIssue("");
    if (file)
      void (async () => {
        const context = new OfflineAudioContext(2, 1, 48000);
        const decoded = await context.decodeAudioData(await file.blob.arrayBuffer());
        if (current) setBuffer(decoded);
      })().catch(() => {
        if (current) setIssue(tr("Audio file cannot be decoded"));
      });
    return () => {
      current = false;
    };
  }, [file?.blob, source]);
  const path = useMemo(() => {
    return buffer ? audioWaveformPath(buffer, node.arguments) : "";
  }, [
    buffer,
    node.arguments.offsetSeconds,
    node.arguments.durationSeconds,
    node.arguments.playbackRate,
    node.arguments.loop,
  ]);
  return (
    <div className="audio-clip-waveform">
      <label className="field">
        <span>{tr("Audio file")}</span>
        <select value={source} onChange={(event) => session.editArgument(node.id, "source", event.target.value)}>
          <option value="">{tr("Select audio file")}</option>
          {session
            .getSnapshot()
            .files.filter((file) => isAudioFile(file.path))
            .map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
        </select>
      </label>
      <svg viewBox="0 0 600 80" width="100%" height="80" role="img" aria-label={tr("Audio waveform")}>
        <path d={path} stroke="currentColor" strokeWidth="2" />
      </svg>
      <button
        className="secondary-button"
        disabled={!buffer}
        onClick={() =>
          session.editArgument(
            node.id,
            "durationSeconds",
            Math.max(
              0.001,
              (buffer!.duration - Number(node.arguments.offsetSeconds || 0)) / Number(node.arguments.playbackRate || 1),
            ),
          )
        }
      >
        {tr("Use source duration")}
      </button>
      <output className="audio-export-issue" aria-live="polite">
        {issue}
      </output>
    </div>
  );
}
