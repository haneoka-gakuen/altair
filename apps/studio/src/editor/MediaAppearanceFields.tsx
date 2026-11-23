import { NumberInput } from "@haneoka/altair-ui-react";
import type { JsonObject, JsonValue } from "@haneoka/altair";
import { MEDIA_BLEND_MODES, MEDIA_MASK_SHAPES, STAGE_MEDIA_ANIMATION_CHANNELS } from "@haneoka/vega-protocol";
import { PropertyClipEditor } from "./PropertyClipEditor";
import { tr } from "./i18n";
const object = (v: JsonValue | undefined): JsonObject => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

export function ClipGainFields({ args, update }: { args: JsonObject; update(value: JsonObject): void }) {
  return (
    <details style={{ gridColumn: "1 / -1" }}>
      <summary>{tr("Volume automation")}</summary>
      <PropertyClipEditor
        value={args.gainAnimation ?? { durationSeconds: Number(args.durationSeconds), tracks: [] }}
        channels={[{ channel: "volume", label: tr("Volume"), value: 1 }]}
        onChange={update}
      />
    </details>
  );
}

export function TimelineCompositionFields({
  appearance,
  durationSeconds,
  update,
}: {
  appearance: JsonValue | undefined;
  durationSeconds: number;
  update(composition: JsonObject): void;
}) {
  if (!appearance || typeof appearance !== "object" || Array.isArray(appearance)) return null;
  const patch = (fields: JsonObject) => update({ ...appearance, ...fields });
  return (
    <>
      <label>
        {tr("Aspect ratio")}
        <NumberInput
          min={0.01}
          step="0.01"
          value={Number(appearance.aspectRatio)}
          onCommit={(aspectRatio) => {
            if (aspectRatio > 0) patch({ aspectRatio });
          }}
        />
      </label>
      <label>
        {tr("Include dialogue")}
        <input
          type="checkbox"
          checked={appearance.includeDialogue !== false}
          onChange={(event) => patch({ includeDialogue: event.currentTarget.checked })}
        />
      </label>
      <label>
        {tr("Transparent background")}
        <input
          type="checkbox"
          checked={appearance.transparentBackground === true}
          onChange={(event) => patch({ transparentBackground: event.currentTarget.checked })}
        />
      </label>
      <MediaPlacementFields appearance={appearance} update={patch} />
      <MediaAppearanceFields args={appearance} update={patch} durationSeconds={durationSeconds} />
    </>
  );
}
const defaultPoints = [
  [0, -0.5],
  [0.5, 0],
  [0, 0.5],
  [-0.5, 0],
];
const shapeLabels = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  "half-plane": "Linear mask",
  band: "Band mask",
  triangle: "Triangle",
  star: "Star",
  heart: "Heart",
  polygon: "Polygon",
};
const blendLabels = {
  normal: "Normal blend",
  multiply: "Multiply",
  screen: "Screen blend",
  add: "Additive blend",
  overlay: "Overlay blend",
};
export function MediaAppearanceFields({
  args,
  update,
  durationSeconds = Number(args.durationSeconds ?? 0),
}: {
  args: JsonObject;
  update(patch: Record<string, JsonValue>): void;
  durationSeconds?: number;
}) {
  const mask = object(args.mask),
    grade = object(args.colorGrade);
  const shape = typeof mask.shape === "string" ? mask.shape : "none";
  const setMask = (fields: JsonObject) => update({ mask: { ...mask, ...fields } });
  const setGrade = (fields: JsonObject) => update({ colorGrade: { ...grade, ...fields } });
  const filters = Array.isArray(args.rasterFilters) ? args.rasterFilters.map(object) : [];
  const addFilter = (kind: string) =>
    update({
      rasterFilters: [
        ...filters,
        kind === "pixelate"
          ? { kind, strength: 1, blockHeight: 0.0144 }
          : kind === "scanlines"
            ? { kind, strength: 1, lineHeight: 0.0025, darkness: 0.14 }
            : { kind, strength: 1, levels: 6 },
      ],
    });
  const channelLabels = {
    x: "Position X",
    y: "Position Y",
    scaleX: "Scale X",
    scaleY: "Scale Y",
    rotationDegrees: "Rotation (°)",
    flipHorizontal: "Flip horizontally",
    flipVertical: "Flip vertically",
    opacity: "Opacity",
    blurRadius: "Blur radius (px)",
    "mask.centerX": "Center X",
    "mask.centerY": "Center Y",
    "mask.width": "Region width",
    "mask.height": "Region height",
    "mask.rotationDegrees": "Mask rotation (°)",
    "mask.radius": "Corner radius",
    "mask.feather": "Edge feather",
    "colorGrade.exposure": "Exposure (EV)",
    "colorGrade.contrast": "Contrast",
    "colorGrade.saturation": "Saturation",
    "colorGrade.temperature": "Color temperature",
    "colorGrade.tint": "Color tint",
    "colorGrade.strength": "Strength",
  } as const;
  const geometry = ["x", "y", "scaleX", "scaleY", "rotationDegrees", "flipHorizontal", "flipVertical"];
  const channels = STAGE_MEDIA_ANIMATION_CHANNELS.filter(
    (channel) =>
      (shape !== "none" || !channel.startsWith("mask.")) && (args.scope !== "below" || !geometry.includes(channel)),
  ).map((channel) => {
    const property = channel.split(".").at(-1)!;
    const source = channel.startsWith("mask.") ? mask : channel.startsWith("colorGrade.") ? grade : args;
    const fallback = ["scaleX", "scaleY", "opacity", "width", "height", "strength"].includes(property)
      ? 1
      : property.startsWith("center")
        ? 0.5
        : 0;
    return { channel, label: tr(channelLabels[channel]), value: Number(source[property] ?? fallback) };
  });
  return (
    <>
      <details style={{ gridColumn: "1 / -1" }}>
        <summary>{tr("Media appearance")}</summary>
        <div className="timeline-timing">
          <label>
            {tr("Blend mode")}
            <select value={String(args.blendMode ?? "normal")} onChange={(e) => update({ blendMode: e.target.value })}>
              {MEDIA_BLEND_MODES.map((b) => (
                <option key={b} value={b}>
                  {tr(blendLabels[b])}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr("Mask shape")}
            <select
              value={shape}
              onChange={(e) =>
                e.target.value === "none"
                  ? update({ mask: null })
                  : setMask({
                      shape: e.target.value,
                      ...(e.target.value === "polygon" && !Array.isArray(mask.points) ? { points: defaultPoints } : {}),
                    })
              }
            >
              <option value="none">{tr("None")}</option>
              {MEDIA_MASK_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {tr(shapeLabels[s])}
                </option>
              ))}
            </select>
          </label>
          {shape !== "none" && (
            <>
              {(
                [
                  ["centerX", "Center X", 0.5, -2, 3],
                  ["centerY", "Center Y", 0.5, -2, 3],
                  ["width", "Region width", 1, 0, 4],
                  ["height", "Region height", 1, 0, 4],
                  ["rotationDegrees", "Mask rotation (°)", 0, -36000, 36000],
                  ["feather", "Edge feather", 0, 0, 1],
                  ["radius", "Corner radius", 0, 0, 1],
                  ["strokePixels", "Mask stroke width", 0, 0, 40],
                ] as const
              )
                .filter(([k]) => k !== "radius" || shape === "rectangle")
                .map(([key, label, def, min, max]) => (
                  <label key={key}>
                    {tr(label)}
                    <NumberInput
                      value={Number(mask[key] ?? def)}
                      min={min}
                      max={max}
                      step="0.01"
                      onCommit={(v) => {
                        if (v >= min && v <= max) setMask({ [key]: v });
                      }}
                    />
                  </label>
                ))}
              <label>
                {tr("Invert mask")}
                <input
                  type="checkbox"
                  checked={mask.invert === true}
                  onChange={(e) => setMask({ invert: e.target.checked })}
                />
              </label>
              {Number(mask.strokePixels) > 0 && (
                <>
                  <label>
                    {tr("Stroke color")}
                    <input
                      type="color"
                      value={String(mask.strokeColor ?? "#ffffff")}
                      onChange={(e) => setMask({ strokeColor: e.target.value })}
                    />
                  </label>
                  <label>
                    {tr("Stroke only")}
                    <input
                      type="checkbox"
                      checked={mask.strokeOnly === true}
                      onChange={(e) => setMask({ strokeOnly: e.target.checked })}
                    />
                  </label>
                </>
              )}
              {shape === "polygon" && (
                <fieldset style={{ gridColumn: "1 / -1" }}>
                  <legend>{tr("Polygon vertices")}</legend>
                  {(Array.isArray(mask.points) ? mask.points : defaultPoints).map((value, i, all) => {
                    const point = Array.isArray(value) ? value : [0, 0];
                    return (
                      <div className="timeline-settings" key={i}>
                        {[0, 1].map((axis) => (
                          <label key={axis}>
                            {(axis ? "Y" : "X") + (i + 1)}
                            <NumberInput
                              min="-1"
                              max="1"
                              step=".01"
                              value={Number(point[axis])}
                              onCommit={(v) => {
                                if (v >= -1 && v <= 1)
                                  setMask({
                                    points: all.map((p, j) =>
                                      j !== i ? p : axis ? [Number(point[0]), v] : [v, Number(point[1])],
                                    ),
                                  });
                              }}
                            />
                          </label>
                        ))}
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={all.length <= 3}
                          onClick={() => setMask({ points: all.filter((_, j) => j !== i) })}
                        >
                          {tr("Remove")}
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={Array.isArray(mask.points) && mask.points.length >= 16}
                    onClick={() =>
                      setMask({ points: [...(Array.isArray(mask.points) ? mask.points : defaultPoints), [0, 0.5]] })
                    }
                  >
                    {tr("Add vertex")}
                  </button>
                </fieldset>
              )}
            </>
          )}
          {(
            [
              ["exposure", "Exposure (EV)", -16, 16],
              ["contrast", "Contrast", -100, 100],
              ["saturation", "Saturation", -100, 100],
              ["temperature", "Color temperature", -100, 100],
              ["tint", "Color tint", -100, 100],
            ] as const
          ).map(([k, label, min, max]) => (
            <label key={k}>
              {tr(label)}
              <NumberInput
                min={min}
                max={max}
                step={k === "exposure" ? 0.05 : 1}
                value={Number(grade[k] ?? 0)}
                onCommit={(v) => {
                  if (v >= min && v <= max) setGrade({ [k]: v });
                }}
              />
            </label>
          ))}
          {Object.keys(grade).length > 0 && (
            <button type="button" className="secondary-button" onClick={() => update({ colorGrade: null })}>
              {tr("Reset color grade")}
            </button>
          )}
          <label>
            {tr("Add raster filter")}
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) addFilter(e.target.value);
              }}
            >
              <option value="">{tr("None")}</option>
              <option value="pixelate">{tr("Pixelate")}</option>
              <option value="posterize">{tr("Posterize")}</option>
              <option value="scanlines">{tr("Scanlines")}</option>
            </select>
          </label>
          {filters.map((f, i) => {
            const kind = String(f.kind),
              key = kind === "pixelate" ? "blockHeight" : kind === "scanlines" ? "lineHeight" : "levels";
            const set = (k: string, v: number) =>
              update({ rasterFilters: filters.map((item, j) => (i === j ? { ...item, [k]: v } : item)) });
            return (
              <fieldset key={i} style={{ gridColumn: "1 / -1" }}>
                <legend>
                  {tr(kind === "pixelate" ? "Pixelate" : kind === "scanlines" ? "Scanlines" : "Posterize")}
                </legend>
                <label>
                  {tr(kind === "posterize" ? "Color levels" : "Cell height")}
                  <NumberInput
                    min={kind === "posterize" ? 2 : 0.0001}
                    max={kind === "posterize" ? 256 : 1}
                    step={kind === "posterize" ? 1 : 0.0001}
                    value={Number(f[key])}
                    onCommit={(v) => {
                      if (v >= (kind === "posterize" ? 2 : 0.0001) && v <= (kind === "posterize" ? 256 : 1))
                        set(key, v);
                    }}
                  />
                </label>
                <label>
                  {tr("Strength")}
                  <NumberInput
                    min={0}
                    max={1}
                    step={0.05}
                    value={Number(f.strength ?? 1)}
                    onCommit={(v) => {
                      if (v >= 0 && v <= 1) set("strength", v);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => update({ rasterFilters: filters.filter((_, j) => j !== i) })}
                >
                  {tr("Remove")}
                </button>
              </fieldset>
            );
          })}
        </div>
      </details>
      {durationSeconds > 0 && (
        <details style={{ gridColumn: "1 / -1" }}>
          <summary>{tr("Animation curves")}</summary>
          <PropertyClipEditor
            channels={channels}
            value={args.visualAnimation ?? { durationSeconds, tracks: [] }}
            onChange={(visualAnimation) => update({ visualAnimation })}
          />
        </details>
      )}
    </>
  );
}

const mediaGeometry = [
  { key: "x", label: "Left (%)", min: -400, max: 400, initial: 0 },
  { key: "y", label: "Top (%)", min: -400, max: 400, initial: 0 },
  { key: "width", label: "Width (%)", min: 0.1, max: 400, initial: 1 },
  { key: "height", label: "Height (%)", min: 0.1, max: 400, initial: 1 },
  { key: "opacity", label: "Opacity (%)", min: 0, max: 100, initial: 1 },
] as const;

export function MediaPlacementFields({
  appearance: args,
  update,
  fullFrame = false,
}: {
  appearance: JsonObject;
  update(patch: JsonObject): void;
  fullFrame?: boolean;
}) {
  return (
    <>
      {!fullFrame && (
        <label>
          {tr("Fit mode")}
          <select value={String(args.fit ?? "contain")} onChange={(event) => update({ fit: event.target.value })}>
            <option value="contain">{tr("Contain")}</option>
            <option value="cover">{tr("Cover")}</option>
            <option value="stretch">{tr("Stretch")}</option>
          </select>
        </label>
      )}
      {mediaGeometry
        .filter(({ key }) => !fullFrame || key === "opacity")
        .map(({ key, label, min, max, initial }) => (
          <label key={key}>
            {tr(label)}
            <NumberInput
              value={Number((Number(args[key] ?? initial) * 100).toFixed(4))}
              min={min}
              max={max}
              step="0.1"
              onCommit={(value) => {
                if (value >= min && value <= max) update({ [key]: value / 100 });
              }}
            />
          </label>
        ))}
      {(
        [
          ["rotationDegrees", "Rotation (°)", -36000, 36000],
          ["blurRadius", "Blur radius (px)", 0, 128],
          ["fadeInSeconds", "Fade in (s)", 0, Number.MAX_SAFE_INTEGER],
          ["fadeOutSeconds", "Fade out (s)", 0, Number.MAX_SAFE_INTEGER],
        ] as const
      )
        .filter(([key]) => !fullFrame || key !== "rotationDegrees")
        .map(([key, label, min, max]) => (
          <label key={key}>
            {tr(label)}
            <NumberInput
              min={min}
              max={max}
              step="0.01"
              value={Number(args[key] ?? 0)}
              onCommit={(value) => {
                if (value >= min && value <= max) update({ [key]: value });
              }}
            />
          </label>
        ))}
      {!fullFrame &&
        (
          [
            ["flipHorizontal", "Flip horizontally"],
            ["flipVertical", "Flip vertically"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {tr(label)}
            <input
              type="checkbox"
              checked={args[key] === true}
              onChange={(event) => update({ [key]: event.currentTarget.checked })}
            />
          </label>
        ))}
    </>
  );
}
