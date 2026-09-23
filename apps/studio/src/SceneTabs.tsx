import type { StoryProject } from "@haneoka/altair";
import { StudioIcon } from "./StudioIcon";
import type { StudioSourceDocument } from "./studio-workspace";

export interface SceneTabsProps {
  readonly documents: readonly StudioSourceDocument[];
  readonly openSceneIds: readonly string[];
  readonly project: StoryProject | null;
  readonly selectedSceneId: string;
  readonly onClose: (sceneId: string) => void;
  readonly onOpen: (sceneId: string) => void;
}

export function SceneTabs({ documents, openSceneIds, project, selectedSceneId, onClose, onOpen }: SceneTabsProps) {
  return (
    <div aria-label="Open scene files" className="scene-tabs" role="tablist">
      {openSceneIds.map((sceneId) => {
        const scene = project?.scenes.find(({ id }) => id === sceneId);
        return (
          <div className={selectedSceneId === sceneId ? "scene-tab selected" : "scene-tab"} key={sceneId}>
            <button
              aria-selected={selectedSceneId === sceneId}
              onClick={() => onOpen(sceneId)}
              role="tab"
              title={documents.find(({ id }) => id === sceneId)?.path ?? sceneId}
            >
              <StudioIcon name="scene" />
              {scene?.name ?? sceneId}
            </button>
            <button
              aria-label={`Close ${scene?.name ?? sceneId} tab`}
              disabled={openSceneIds.length <= 1}
              onClick={() => onClose(sceneId)}
            >
              <StudioIcon name="close" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
