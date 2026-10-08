import { useEffect, useState } from "react";
import { createStoryCommand, advCommandToAuthoredNode } from "@haneoka/altair-plugin-adv";
import {
  parseAltairProjectDocument,
  parseAltairSceneDocument,
  serializeAltairDocument,
  type JsonObject,
} from "@haneoka/altair";
import { storyResourceContentType } from "@haneoka/vega/plugin";
import { createNativeProject, NATIVE_PROJECT_PATH } from "./native-project";
import { registerLocalPublicAsset } from "./public-asset-project";
import { EditorSession } from "./session";
import { Preview } from "./Preview";
import type { EditorPublicAsset } from "./resource-manifest";
import type { LocalPublicAssetPlan } from "./public-asset-import";
import { tr } from "./i18n";

export function PublicAssetPreview({ asset, plan }: { asset: EditorPublicAsset; plan: LocalPublicAssetPlan }) {
  const [media, setMedia] = useState(""),
    [preview, setPreview] = useState<EditorSession>(),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let session: EditorSession | undefined, url: string | undefined;
    setMedia("");
    setPreview(undefined);
    setError("");
    void (async () => {
      if (["image", "audio", "video"].includes(asset.format)) {
        const primary = asset.members.find((member) => ["image", "audio", "video"].includes(member.role));
        const row = (plan.metadata.members as JsonObject[]).find((member) => member.memberId === primary?.id),
          file = plan.files.find((file) => file.path === row?.path);
        if (!file) throw new Error("Preview resource is missing");
        const bytes = new Uint8Array(await file.blob.arrayBuffer());
        controller.signal.throwIfAborted();
        url = URL.createObjectURL(new Blob([bytes], { type: storyResourceContentType(primary!.source, bytes) }));
        setMedia(url);
        return;
      }
      const project = createNativeProject("Public asset preview"),
        manifest = project.files.find((file) => file.path === NATIVE_PROJECT_PATH)!;
      const source = registerLocalPublicAsset(await manifest.blob.text(), asset, plan),
        document = parseAltairProjectDocument(source),
        scenePath = document.scenes[0]!.path,
        sceneFile = project.files.find((file) => file.path === scenePath)!;
      const command =
        asset.kind === "post-effect"
          ? createStoryCommand("PostEffect", { postEffectRef: asset.id, params: ["0"] })
          : asset.kind === "effect"
            ? createStoryCommand("Effect", {
                effectRef: asset.id,
                targetName: "public-preview",
                positionType: 0,
                canvasLayers: [],
                params: [""],
              })
            : createStoryCommand("Character", {
                targetName: "public-preview",
                live2dKey: asset.id,
                targetAssetIndex: 0,
              });
      const scene = {
        ...parseAltairSceneDocument(await sceneFile.blob.text()),
        nodes: [advCommandToAuthoredNode(command)],
      };
      controller.signal.throwIfAborted();
      session = new EditorSession(
        {
          ...project,
          files: [
            ...project.files.map((file) =>
              file.path === manifest.path
                ? { ...file, blob: new Blob([source]) }
                : file.path === scenePath
                  ? { ...file, blob: new Blob([serializeAltairDocument(scene)]) }
                  : file,
            ),
            ...plan.files,
          ],
        },
        undefined,
        { ephemeral: true },
      );
      await session.initialize();
      controller.signal.throwIfAborted();
      setPreview(session);
    })().catch((error) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      void session?.dispose();
    };
  }, [asset, plan]);
  if (error) return <p role="alert">{tr(error)}</p>;
  if (media)
    return asset.format === "audio" ? (
      <audio controls src={media} aria-label={asset.name} />
    ) : asset.format === "video" ? (
      <video controls src={media} aria-label={asset.name} />
    ) : (
      <img src={media} alt={asset.name} />
    );
  return preview ? <Preview session={preview} /> : <p role="status">{tr("Loading preview")}</p>;
}
