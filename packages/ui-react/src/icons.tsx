import { useSyncExternalStore, type ComponentType, type SVGProps } from "react";
import { materialSymbols } from "./material-symbols.js";

export type MaterialIconName = Exclude<keyof typeof materialSymbols, `${string}-filled`>;
export interface MaterialIconShapeProps extends Omit<
  SVGProps<SVGSVGElement>,
  "children" | "dangerouslySetInnerHTML" | "name"
> {
  size?: number | string;
}
export interface MaterialIconProps extends MaterialIconShapeProps {
  name: MaterialIconName;
}
export type MaterialIconComponent = ComponentType<MaterialIconShapeProps>;
let sprite: string | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function configureMaterialIcons(url?: string): void {
  if (sprite === url) return;
  sprite = url;
  for (const listener of listeners) listener();
}
export function MaterialIcon({
  name,
  size = 24,
  className,
  fill,
  strokeWidth: _strokeWidth,
  style,
  ...props
}: MaterialIconProps) {
  const source = useSyncExternalStore(
    subscribe,
    () => sprite,
    () => undefined,
  );
  const symbol = fill && fill !== "none" ? (`${name}-filled` as keyof typeof materialSymbols) : name;
  const shared = {
    ...props,
    className: `material-icon${className ? ` ${className}` : ""}`,
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    focusable: false,
    "aria-hidden": props["aria-label"] ? undefined : true,
    style: { fill: "currentColor", stroke: "none", ...style },
  } as const;
  return source ? (
    <svg {...shared}>
      <use href={`${source}#${symbol}`} />
    </svg>
  ) : (
    <svg {...shared} dangerouslySetInnerHTML={{ __html: materialSymbols[symbol] }} />
  );
}
function icon(name: MaterialIconName): MaterialIconComponent {
  return (props) => <MaterialIcon name={name} {...props} />;
}

export const AlertCircle = icon("error");
export const ArrowDown = icon("arrow_downward");
export const ArrowLeft = icon("arrow_back");
export const ArrowRight = icon("arrow_forward");
export const ArrowUp = icon("arrow_upward");
export const Box = icon("deployed_code");
export const Boxes = icon("deployed_code");
export const Braces = icon("data_object");
export const Bug = icon("bug_report");
export const Camera = icon("photo_camera");
export const Check = icon("check");
export const ChevronDown = icon("expand_more");
export const ChevronLeft = icon("chevron_left");
export const ChevronRight = icon("chevron_right");
export const ChevronUp = icon("expand_less");
export const Circle = icon("circle");
export const Clapperboard = icon("movie");
export const ClipboardPaste = icon("content_paste");
export const Clock = icon("schedule");
export const Code2 = icon("code");
export const Copy = icon("content_copy");
export const Download = icon("download");
export const ExternalLink = icon("open_in_new");
export const File = icon("draft");
export const FileImage = icon("image");
export const FilePlus2 = icon("note_add");
export const FileText = icon("description");
export const FileWarning = icon("file_present");
export const Film = icon("theaters");
export const Folder = icon("folder");
export const FolderOpen = icon("folder_open");
export const Gamepad2 = icon("sports_esports");
export const GanttChart = icon("view_timeline");
export const GripVertical = icon("drag_indicator");
export const Image = icon("image");
export const Import = icon("file_open");
export const Languages = icon("translate");
export const Layers = icon("layers");
export const LayoutList = icon("view_list");
export const Library = icon("video_library");
export const ListPlus = icon("playlist_add");
export const LoaderCircle = icon("progress_activity");
export const Lock = icon("lock");
export const Maximize = icon("fit_screen");
export const Maximize2 = icon("fullscreen");
export const MoreVertical = icon("more_vert");
export const Music = icon("music_note");
export const Music2 = icon("music_note");
export const Package = icon("inventory_2");
export const Palette = icon("palette");
export const PanelBottomClose = icon("collapse_content");
export const PanelBottomOpen = icon("expand_content");
export const PanelsTopLeft = icon("dashboard");
export const Pause = icon("pause");
export const PersonStanding = icon("accessibility_new");
export const Play = icon("play_arrow");
export const Plus = icon("add");
export const Puzzle = icon("extension");
export const RadioTower = icon("cell_tower");
export const Redo2 = icon("redo");
export const RefreshCw = icon("refresh");
export const RotateCcw = icon("replay");
export const Save = icon("save");
export const ScrollText = icon("article");
export const Search = icon("search");
export const Settings2 = icon("settings");
export const Shirt = icon("styler");
export const SlidersHorizontal = icon("tune");
export const Smile = icon("mood");
export const Sparkles = icon("auto_awesome");
export const Square = icon("stop");
export const Star = icon("star");
export const StepForward = icon("skip_next");
export const Trash2 = icon("delete");
export const Type = icon("text_fields");
export const Undo2 = icon("undo");
export const Unlock = icon("lock_open");
export const Upload = icon("upload");
export const UserRound = icon("person");
export const Video = icon("videocam");
export const WandSparkles = icon("auto_fix_high");
export const Workflow = icon("account_tree");
export const X = icon("close");
export const ZoomIn = icon("zoom_in");
export const ZoomOut = icon("zoom_out");
