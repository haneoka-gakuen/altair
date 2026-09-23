import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { StudioIcon, type StudioIconName } from "./StudioIcon";
import type { StudioThemePreference } from "./theme";
import "./terre-workbench.css";

export type WorkbenchTab = "config" | "view" | "settings" | "help" | "export" | "insert" | "tools";
export interface WorkbenchAction {
  readonly id: string;
  readonly tab: WorkbenchTab;
  readonly label: string;
  readonly icon: StudioIconName;
  readonly disabled?: boolean;
  readonly active?: boolean;
  readonly run: () => void;
}

interface Props {
  readonly children: ReactNode;
  readonly projectName: string;
  readonly documentPath: string;
  readonly dirtyCount: number;
  readonly sceneCount: number;
  readonly status: string;
  readonly debugHeight: number;
  readonly actions: readonly WorkbenchAction[];
  readonly theme: StudioThemePreference;
  readonly onTheme: (theme: StudioThemePreference) => void;
  readonly onOpenProject: () => Promise<boolean>;
  readonly busy: boolean;
  readonly chinese: boolean;
}

/** Project manager and authoring workbench. */
export function TerreWorkbench(props: Props) {
  const [dashboard, setDashboard] = useState(true);
  const [tab, setTab] = useState<WorkbenchTab>("config");
  const [ribbon, setRibbon] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const value = Number(localStorage.getItem("altair.terre.sidebar-width"));
      return value >= 280 && value <= 900 ? value : 440;
    } catch {
      return 440;
    }
  });
  const text = (zh: string, en: string) => (props.chinese ? zh : en);
  const tabs: [WorkbenchTab, string][] = [
    ["config", text("配置", "Configure")],
    ["view", text("视图", "View")],
    ["settings", text("设置", "Settings")],
    ["help", text("帮助", "Help")],
    ["export", text("导出", "Export")],
    ["insert", text("添加语句", "Add sentence")],
    ["tools", text("工具箱", "Toolbox")],
  ];
  const resize = (value: number) => {
    const next = Math.max(280, Math.min(value, Math.max(280, window.innerWidth - 480)));
    setSidebarWidth(next);
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem("altair.terre.sidebar-width", String(sidebarWidth));
      } catch {
        /* Storage is optional. */
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [sidebarWidth]);
  const open = async () => {
    if (await props.onOpenProject()) setDashboard(false);
  };
  return (
    <div
      className="terre-root"
      style={
        {
          "--terre-sidebar-width": `${sidebarWidth}px`,
          "--debug-dock-height": `${props.debugHeight}px`,
        } as CSSProperties
      }
    >
      {dashboard && (
        <section className="terre-dashboard" aria-label={text("项目管理", "Projects")}>
          <header className="terre-dashboard-brand">
            <span>Altair</span>
            <small>{text("游戏创作工具", "Game authoring")}</small>
          </header>
          <nav className="terre-dashboard-nav" aria-label={text("工作区", "Workspace")}>
            <button className="selected">
              <StudioIcon name="play" />
              {text("游戏", "Games")}
            </button>
            <button
              onClick={() => {
                setDashboard(false);
                setTab("tools");
                setRibbon(true);
              }}
            >
              <StudioIcon name="package" />
              {text("工具箱", "Toolbox")}
            </button>
            <button
              onClick={() => {
                setDashboard(false);
                setTab("settings");
                setRibbon(true);
              }}
            >
              <StudioIcon name="palette" />
              {text("设置", "Settings")}
            </button>
          </nav>
          <section className="terre-project-list">
            <div className="terre-project-list-title">
              <h2>{text("我的游戏", "My games")}</h2>
              <button disabled={props.busy} onClick={() => void open()}>
                <StudioIcon name="folder-open" />
                {text("打开项目", "Open project")}
              </button>
            </div>
            <button className="terre-project-card selected" onClick={() => setDashboard(false)}>
              <span className="terre-project-icon">
                <StudioIcon name="scene" size={32} />
              </span>
              <span>
                <strong>{props.projectName}</strong>
                <small>
                  {props.sceneCount} {text("个场景", "scenes")}
                </small>
              </span>
              <StudioIcon name="chevron-right" />
            </button>
          </section>
          <section className="terre-project-detail">
            <div className="terre-project-cover">
              <StudioIcon name="scene" size={64} />
            </div>
            <h1>{props.projectName}</h1>
            <p>{props.documentPath}</p>
            <button className="terre-primary" onClick={() => setDashboard(false)}>
              <StudioIcon name="code" />
              {text("编辑游戏", "Edit game")}
            </button>
            <button disabled={props.busy} onClick={() => void open()}>
              <StudioIcon name="folder-open" />
              {text("打开其他项目", "Open another project")}
            </button>
            {props.dirtyCount > 0 && (
              <p role="status">
                {props.dirtyCount} {text("个文件有未保存修改", "files have unsaved changes")}
              </p>
            )}
          </section>
        </section>
      )}
      <main className={`studio-shell terre-workbench${ribbon ? " has-ribbon" : ""}`} hidden={dashboard}>
        <a className="skip-link" href="#authoring-heading">
          {text("转到脚本编辑", "Skip to script editor")}
        </a>
        <header className="terre-topbar">
          <button
            className="terre-home"
            aria-label={text("返回项目管理", "Back to projects")}
            onClick={() => setDashboard(true)}
          >
            <StudioIcon name="chevron-left" />
            <strong>Altair</strong>
          </button>
          <div className="terre-tabs" role="tablist" aria-label={text("功能区", "Ribbon")}>
            {tabs.map(([id, label], index) => (
              <button
                key={id}
                id={`ribbon-${id}`}
                role="tab"
                tabIndex={id === tab ? 0 : -1}
                aria-selected={id === tab}
                aria-controls="terre-ribbon"
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : event.key === "ArrowLeft"
                        ? (index + tabs.length - 1) % tabs.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? tabs.length - 1
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  setTab(tabs[next]![0]);
                  setRibbon(true);
                  document.getElementById(`ribbon-${tabs[next]![0]}`)?.focus();
                }}
                onClick={() => {
                  setTab(id);
                  setRibbon(true);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="terre-project-title" title={props.projectName}>
            {props.projectName}
          </span>
          <button aria-expanded={ribbon} onClick={() => setRibbon(!ribbon)}>
            <StudioIcon name={ribbon ? "panel-close" : "panel-open"} />
            {text("功能区显示", "Ribbon display")}
          </button>
          <label className="terre-theme">
            <StudioIcon name="palette" />
            <select
              aria-label={text("主题", "Theme")}
              value={props.theme}
              onChange={(event) => props.onTheme(event.target.value as StudioThemePreference)}
            >
              <option value="light">{text("浅色", "Light")}</option>
              <option value="dark">{text("深色", "Dark")}</option>
              <option value="system">{text("跟随系统", "System")}</option>
            </select>
          </label>
        </header>
        {ribbon && (
          <div id="terre-ribbon" className="terre-ribbon" role="tabpanel" aria-labelledby={`ribbon-${tab}`}>
            {props.actions
              .filter((action) => action.tab === tab)
              .map((action) => (
                <button key={action.id} disabled={action.disabled} aria-pressed={action.active} onClick={action.run}>
                  <StudioIcon name={action.icon} size={24} />
                  <span>{action.label}</span>
                </button>
              ))}
          </div>
        )}
        {props.children}
        <div
          className="terre-splitter"
          role="separator"
          tabIndex={0}
          aria-label={text("调整预览区宽度", "Resize preview sidebar")}
          aria-orientation="vertical"
          aria-valuenow={Math.round(sidebarWidth)}
          aria-valuemin={280}
          aria-valuemax={Math.max(280, window.innerWidth - 480)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              resize(sidebarWidth + (event.key === "ArrowRight" ? 20 : -20));
            }
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        />
        <footer className="terre-status">
          <span>{props.documentPath}</span>
          <span>
            {props.dirtyCount
              ? `${props.dirtyCount} ${text("个文件未保存", "unsaved files")}`
              : text("已保存", "Saved")}
          </span>
          <span>{props.status}</span>
        </footer>
      </main>
    </div>
  );
}
