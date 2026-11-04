export function authoredTypeLabelKey(plugin: string, name: string): string | undefined {
  const core: Record<string, string> = {
    timeline: "Timeline",
    audioClip: "Audio clip",
    sequence: "Sequence",
    note: "Note",
    jump: "Jump to scene",
    call: "Call scene",
    return: "Return",
    end: "End story",
    branch: "Conditional branch",
    setVariable: "Set variable",
    input: "Text input",
    unlock: "Unlock gallery item",
    dialogue: "Dialogue visibility",
  };
  const effects: Record<string, string> = {
    "effect.dialoguePortrait": "Dialogue portrait",
    "effect.figureDiff": "Portrait difference",
    "effect.intro": "Fullscreen text",
    "effect.setTransform": "Transform",
    "effect.setTempAnimation": "Animation",
    "effect.setTempAnimationV2": "Animation",
    "effect.setAnimation": "Animation",
    "effect.setFilter": "Visual filters",
    "effect.pixiPerform": "Visual effect",
    "effect.pixiInit": "Clear WebGAL weather",
  };
  const system: Record<string, string> = {
    SetVariable: "Set variable",
    Branch: "Conditional branch",
    JumpScene: "Jump to scene",
    CallScene: "Call scene",
    ReturnScene: "Return",
    Input: "Text input",
    Unlock: "Unlock gallery item",
    FlowCheckpoint: "Checkpoint",
    SetSetting: "Setting",
    End: "End story",
    SceneMarker: "Scene",
    SetDialogueVisibility: "Dialogue visibility",
  };
  if (plugin === "haneoka.altair-webgal" && name.startsWith("system.")) return system[name.slice(7)] ?? "System";
  if (plugin === "haneoka.altair") return core[name];
  if (plugin === "haneoka.altair-webgal") return effects[name];
  return undefined;
}
