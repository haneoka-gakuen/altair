import {
  Box,
  Braces,
  Bug,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Clapperboard,
  Code2,
  Download,
  ExternalLink,
  File,
  FilePlus2,
  FolderOpen,
  GripVertical,
  Image,
  ListPlus,
  Languages,
  Maximize2,
  Music2,
  Package,
  Palette,
  PanelBottomClose,
  PanelBottomOpen,
  PanelsTopLeft,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RadioTower,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  StepForward,
  Trash2,
  Type,
  Undo2,
  Video,
  WandSparkles,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type StudioIconName =
  | "add"
  | "altair"
  | "audio"
  | "breakpoint"
  | "bug"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "close"
  | "code"
  | "data"
  | "download"
  | "drag"
  | "external"
  | "file"
  | "file-add"
  | "fit"
  | "font"
  | "folder-open"
  | "image"
  | "insert"
  | "languages"
  | "model"
  | "package"
  | "palette"
  | "panel-close"
  | "panel-open"
  | "panels"
  | "pause"
  | "play"
  | "redo"
  | "refresh"
  | "radio"
  | "reset"
  | "save"
  | "scene"
  | "search"
  | "sparkles"
  | "step-forward"
  | "trash"
  | "undo"
  | "video"
  | "workflow"
  | "zoom-in"
  | "zoom-out";

const ICONS: Readonly<Record<StudioIconName, LucideIcon>> = Object.freeze({
  add: Plus,
  altair: Sparkles,
  audio: Music2,
  breakpoint: Circle,
  bug: Bug,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  close: X,
  code: Code2,
  data: Braces,
  download: Download,
  drag: GripVertical,
  external: ExternalLink,
  file: File,
  "file-add": FilePlus2,
  fit: Maximize2,
  font: Type,
  "folder-open": FolderOpen,
  image: Image,
  insert: ListPlus,
  languages: Languages,
  model: Box,
  package: Package,
  palette: Palette,
  "panel-close": PanelBottomClose,
  "panel-open": PanelBottomOpen,
  panels: PanelsTopLeft,
  pause: Pause,
  play: Play,
  redo: Redo2,
  refresh: RefreshCw,
  radio: RadioTower,
  reset: RotateCcw,
  save: Save,
  scene: Clapperboard,
  search: Search,
  sparkles: WandSparkles,
  "step-forward": StepForward,
  trash: Trash2,
  undo: Undo2,
  video: Video,
  workflow: Workflow,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
});

export interface StudioIconProps extends Omit<LucideProps, "children" | "name"> {
  readonly name: StudioIconName;
  readonly size?: number | string;
}

export function StudioIcon({ className, name, size = 16, ...props }: StudioIconProps) {
  const Icon = ICONS[name];
  const classes = className ? `studio-icon ${className}` : "studio-icon";
  return (
    <Icon
      aria-hidden="true"
      className={classes}
      data-icon={name}
      focusable="false"
      size={size}
      strokeWidth={1.8}
      {...props}
    />
  );
}
