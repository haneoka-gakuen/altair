import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  StoryFlowEdge,
  StoryFlowGraph,
  StoryFlowNode,
} from "@haneoka/altair-plugin-flow";
import { StudioIcon } from "./StudioIcon";

export interface FlowViewProps {
  readonly graph: StoryFlowGraph;
  readonly selectedNodeId: string;
  readonly selectedSceneId: string;
  readonly onSelectNode: (node: StoryFlowNode) => void;
  readonly onSelectScene: (sceneId: string) => void;
}

interface PositionedNode {
  readonly node: StoryFlowNode;
  readonly x: number;
  readonly y: number;
}

interface FlowLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PositionedNode[];
  readonly positions: ReadonlyMap<string, PositionedNode>;
  readonly lanes: ReadonlyArray<{
    readonly sceneId: string;
    readonly sceneName: string;
    readonly x: number;
    readonly width: number;
  }>;
}

const NODE_WIDTH = 196;
const NODE_HEIGHT = 68;
const SCENE_WIDTH = 236;
const SCENE_GAP = 72;
const ROW_HEIGHT = 96;

const layoutGraph = (graph: StoryFlowGraph): FlowLayout => {
  const sceneOrder = [
    ...new Set(
      graph.nodes.flatMap((node) =>
        node.sceneId && node.kind !== "unresolved" ? [node.sceneId] : [],
      ),
    ),
  ];
  const positions: PositionedNode[] = [];
  const canvasHeight = Math.max(
    430,
    110 +
      Math.max(
        2,
        ...sceneOrder.map(
          (sceneId) =>
            graph.nodes.filter(
              (node) => node.sceneId === sceneId && node.kind !== "unresolved",
            ).length,
        ),
      ) *
        ROW_HEIGHT,
  );
  positions.push({
    node: graph.nodes.find(({ id }) => id === graph.entryNodeId)!,
    x: 24,
    y: 74,
  });
  positions.push({
    node: graph.nodes.find(({ id }) => id === graph.exitNodeId)!,
    x: 24,
    y: canvasHeight - NODE_HEIGHT - 42,
  });
  const lanes = sceneOrder.map((sceneId, sceneIndex) => {
    const nodes = graph.nodes
      .filter((node) => node.sceneId === sceneId && node.kind !== "unresolved")
      .sort((left, right) => {
        const rank = (node: StoryFlowNode): number =>
          node.kind === "scene-entry"
            ? -1
            : node.kind === "scene-exit"
              ? Number.MAX_SAFE_INTEGER
              : node.commandIndex ?? 0;
        return rank(left) - rank(right);
      });
    const x = 260 + sceneIndex * (SCENE_WIDTH + SCENE_GAP);
    nodes.forEach((node, index) => positions.push({ node, x: x + 20, y: 66 + index * ROW_HEIGHT }));
    return {
      sceneId,
      sceneName: nodes[0]?.sceneName || sceneId,
      x,
      width: SCENE_WIDTH,
    };
  });
  const unresolved = graph.nodes.filter(({ kind }) => kind === "unresolved");
  const unresolvedX = 260 + sceneOrder.length * (SCENE_WIDTH + SCENE_GAP);
  unresolved.forEach((node, index) =>
    positions.push({ node, x: unresolvedX + 20, y: 66 + index * ROW_HEIGHT }),
  );
  const width = Math.max(
    720,
    unresolved.length
      ? unresolvedX + SCENE_WIDTH + 32
      : 260 + sceneOrder.length * (SCENE_WIDTH + SCENE_GAP) + 32,
  );
  return {
    width,
    height: canvasHeight,
    nodes: positions,
    positions: new Map(positions.map((item) => [item.node.id, item] as const)),
    lanes,
  };
};

const edgePath = (edge: StoryFlowEdge, layout: FlowLayout): string => {
  const source = layout.positions.get(edge.from);
  const target = layout.positions.get(edge.to);
  if (!source || !target) return "";
  const sourceCenterY = source.y + NODE_HEIGHT / 2;
  const targetCenterY = target.y + NODE_HEIGHT / 2;
  if (source.x === target.x) {
    const side = source.x + NODE_WIDTH + 28;
    return `M ${source.x + NODE_WIDTH} ${sourceCenterY} C ${side} ${sourceCenterY}, ${side} ${targetCenterY}, ${target.x + NODE_WIDTH} ${targetCenterY}`;
  }
  const forward = target.x > source.x;
  const sourceX = forward ? source.x + NODE_WIDTH : source.x;
  const targetX = forward ? target.x : target.x + NODE_WIDTH;
  const bend = Math.max(52, Math.abs(targetX - sourceX) * 0.42);
  return `M ${sourceX} ${sourceCenterY} C ${sourceX + (forward ? bend : -bend)} ${sourceCenterY}, ${targetX + (forward ? -bend : bend)} ${targetCenterY}, ${targetX} ${targetCenterY}`;
};

const nodeBadge = (node: StoryFlowNode): string =>
  ({
    "project-entry": "ENTRY",
    "project-exit": "EXIT",
    "scene-entry": "SCENE",
    "scene-exit": "RETURN",
    command: node.opcode === null ? "SOURCE" : "COMMAND",
    choice: "CHOICE",
    jump: "JUMP",
    "scene-call": "CALL",
    "scene-return": "RETURN",
    condition: "WHEN",
    end: "END",
    "scene-marker": "MARKER",
    unresolved: "MISSING",
  })[node.kind];

const edgeLabel = (edge: StoryFlowEdge): string => {
  if (edge.kind === "choice") return `Choice: ${edge.choiceText}`;
  if (edge.kind === "scene-call") return `Call scene ${edge.targetSceneId}`;
  if (edge.kind === "scene-return") return `Return from ${edge.fromSceneId}`;
  if (edge.kind === "jump") return edge.targetLabel ? `Jump to ${edge.targetLabel}` : `Jump to ${edge.targetSceneId}`;
  return edge.label || edge.kind;
};

export function FlowView({
  graph,
  selectedNodeId,
  selectedSceneId,
  onSelectNode,
  onSelectScene,
}: FlowViewProps) {
  const baseLayout = useMemo(() => layoutGraph(graph), [graph]);
  const [nodeOffsets, setNodeOffsets] = useState<
    Readonly<Record<string, { readonly x: number; readonly y: number }>>
  >({});
  const [viewport, setViewport] = useState({ x: 20, y: 18, scale: 1 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<
    | {
        readonly kind: "pan";
        readonly pointerId: number;
        readonly startX: number;
        readonly startY: number;
        readonly originX: number;
        readonly originY: number;
      }
    | {
        readonly kind: "node";
        readonly pointerId: number;
        readonly nodeId: string;
        readonly startX: number;
        readonly startY: number;
        readonly originX: number;
        readonly originY: number;
      }
    | null
  >(null);
  const layout = useMemo<FlowLayout>(() => {
    const nodes = baseLayout.nodes.map((item) => {
      const offset = nodeOffsets[item.node.id];
      return offset
        ? { ...item, x: item.x + offset.x, y: item.y + offset.y }
        : item;
    });
    return {
      ...baseLayout,
      nodes,
      positions: new Map(nodes.map((item) => [item.node.id, item] as const)),
    };
  }, [baseLayout, nodeOffsets]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selected = graph.nodes.find(({ id }) => id === selectedNodeId) ?? graph.nodes[0];
  const outgoing = selected ? graph.edges.filter(({ from }) => from === selected.id) : [];

  useEffect(() => {
    const valid = new Set(graph.nodes.map(({ id }) => id));
    setNodeOffsets((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => valid.has(id))),
    );
  }, [graph]);

  const clampScale = (value: number): number =>
    Math.max(0.35, Math.min(2.2, value));

  const setScaleAroundCenter = (scale: number): void => {
    const element = scrollRef.current;
    if (!element) return;
    const nextScale = clampScale(scale);
    const centerX = element.clientWidth / 2;
    const centerY = element.clientHeight / 2;
    setViewport((current) => {
      const worldX = (centerX - current.x) / current.scale;
      const worldY = (centerY - current.y) / current.scale;
      return {
        x: centerX - worldX * nextScale,
        y: centerY - worldY * nextScale,
        scale: nextScale,
      };
    });
  };

  const fitGraph = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    const scale = clampScale(
      Math.min(
        (element.clientWidth - 40) / baseLayout.width,
        (element.clientHeight - 40) / baseLayout.height,
      ),
    );
    setViewport({ x: 20, y: 20, scale });
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest(".flow-node, .flow-controls")) return;
    interaction.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginNodeDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    item: PositionedNode,
  ): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const offset = nodeOffsets[item.node.id] ?? { x: 0, y: 0 };
    interaction.current = {
      kind: "node",
      pointerId: event.pointerId,
      nodeId: item.node.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = interaction.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - active.startX;
    const deltaY = event.clientY - active.startY;
    if (active.kind === "pan") {
      setViewport((current) => ({
        ...current,
        x: active.originX + deltaX,
        y: active.originY + deltaY,
      }));
      return;
    }
    const base = baseLayout.positions.get(active.nodeId);
    if (!base) return;
    setNodeOffsets((current) => ({
      ...current,
      [active.nodeId]: {
        x: Math.max(
          -base.x,
          Math.min(
            baseLayout.width - NODE_WIDTH - base.x,
            active.originX + deltaX / viewport.scale,
          ),
        ),
        y: Math.max(
          -base.y,
          Math.min(
            baseLayout.height - NODE_HEIGHT - base.y,
            active.originY + deltaY / viewport.scale,
          ),
        ),
      },
    }));
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (interaction.current?.pointerId !== event.pointerId) return;
    interaction.current = null;
  };

  const zoomAtPointer = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    setViewport((current) => {
      const scale = clampScale(
        current.scale * (event.deltaY > 0 ? 0.9 : 1.1),
      );
      const worldX = (pointerX - current.x) / current.scale;
      const worldY = (pointerY - current.y) / current.scale;
      return {
        x: pointerX - worldX * scale,
        y: pointerY - worldY * scale,
        scale,
      };
    });
  };

  const focusNode = (node: StoryFlowNode | undefined): void => {
    if (!node) return;
    onSelectNode(node);
    requestAnimationFrame(() => buttons.current.get(node.id)?.focus());
  };

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, item: PositionedNode): void => {
    const candidates = layout.nodes.filter(({ node }) => node.id !== item.node.id);
    const inDirection = candidates.filter((candidate) => {
      if (event.key === "ArrowUp") return candidate.y < item.y;
      if (event.key === "ArrowDown") return candidate.y > item.y;
      if (event.key === "ArrowLeft") return candidate.x < item.x;
      if (event.key === "ArrowRight") return candidate.x > item.x;
      return false;
    });
    const distance = (candidate: PositionedNode): number => {
      const dx = candidate.x - item.x;
      const dy = candidate.y - item.y;
      return Math.hypot(dx, dy) + (event.key === "ArrowUp" || event.key === "ArrowDown" ? Math.abs(dx) * 2 : Math.abs(dy) * 2);
    };
    let next =
      event.key === "Home"
        ? layout.positions.get(graph.entryNodeId)
        : event.key === "End"
          ? layout.positions.get(graph.exitNodeId)
          : inDirection.sort((left, right) => distance(left) - distance(right))[0];
    if (!next) return;
    event.preventDefault();
    focusNode(next.node);
  };

  const selectScene = (sceneId: string): void => {
    onSelectScene(sceneId);
    focusNode(
      layout.nodes.find(
        ({ node }) => node.sceneId === sceneId && node.kind === "scene-entry",
      )?.node,
    );
  };

  return (
    <div className="flow-view">
      <div className="flow-scene-tabs" aria-label="Story scenes" role="navigation">
        {layout.lanes.map((lane) => (
          <button
            aria-current={selectedSceneId === lane.sceneId ? "page" : undefined}
            className={selectedSceneId === lane.sceneId ? "selected" : ""}
            key={lane.sceneId}
            onClick={() => selectScene(lane.sceneId)}
          >
            {lane.sceneName}
          </button>
        ))}
        <span aria-live="polite">
          {graph.nodes.filter(({ reachable }) => reachable).length}/{graph.nodes.length} reachable
        </span>
      </div>
      <p className="sr-only" id="flow-keyboard-help">
        Use arrow keys to move between flow nodes. Home selects project start and End selects project end.
      </p>
      <div
        aria-describedby="flow-keyboard-help"
        aria-label="Story control-flow graph"
        className="flow-scroll"
        onPointerCancel={endPointer}
        onPointerDown={beginPan}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onWheel={zoomAtPointer}
        ref={scrollRef}
        role="region"
        tabIndex={0}
      >
        <div
          aria-label="Flow zoom controls"
          className="flow-controls"
          onPointerDown={(event) => event.stopPropagation()}
          role="group"
        >
          <button
            aria-label="Zoom out"
            onClick={() => setScaleAroundCenter(viewport.scale / 1.2)}
            title="Zoom out"
          >
            <StudioIcon name="zoom-out" />
          </button>
          <span>{Math.round(viewport.scale * 100)}%</span>
          <button
            aria-label="Zoom in"
            onClick={() => setScaleAroundCenter(viewport.scale * 1.2)}
            title="Zoom in"
          >
            <StudioIcon name="zoom-in" />
          </button>
          <button aria-label="Fit graph" onClick={fitGraph} title="Fit graph">
            <StudioIcon name="fit" />
          </button>
          <button
            aria-label="Reset graph layout"
            onClick={() => {
              setNodeOffsets({});
              setViewport({ x: 20, y: 18, scale: 1 });
            }}
            title="Reset graph layout"
          >
            <StudioIcon name="reset" />
          </button>
        </div>
        <div
          className="flow-canvas"
          style={{
            height: layout.height,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
            width: layout.width,
          }}
        >
          {layout.lanes.map((lane) => (
            <div
              aria-hidden="true"
              className="flow-lane"
              key={lane.sceneId}
              style={
                {
                  "--flow-lane-left": `${lane.x}px`,
                  "--flow-lane-width": `${lane.width}px`,
                } as CSSProperties
              }
            >
              <span>{lane.sceneName}</span>
            </div>
          ))}
          <svg aria-hidden="true" className="flow-edges" height={layout.height} width={layout.width}>
            <defs>
              <marker id="altair-flow-arrow" markerHeight="7" markerWidth="8" orient="auto" refX="7" refY="3.5">
                <path d="M0,0 L8,3.5 L0,7 Z" />
              </marker>
            </defs>
            {graph.edges.map((edge) => (
              <path
                className={`flow-edge edge-${edge.kind}${edge.condition ? ` outcome-${edge.condition.outcome}` : ""}`}
                d={edgePath(edge, layout)}
                key={edge.id}
                markerEnd="url(#altair-flow-arrow)"
              >
                <title>{edgeLabel(edge)}</title>
              </path>
            ))}
          </svg>
          {layout.nodes.map((item) => (
            <button
              aria-label={`${nodeBadge(item.node)}: ${item.node.label}${item.node.condition ? `, condition ${item.node.condition}` : ""}`}
              aria-pressed={selected?.id === item.node.id}
              className={[
                "flow-node",
                `node-${item.node.kind}`,
                selected?.id === item.node.id ? "selected" : "",
                item.node.reachable ? "" : "unreachable",
              ]
                .filter(Boolean)
                .join(" ")}
              key={item.node.id}
              onClick={() => onSelectNode(item.node)}
              onKeyDown={(event) => navigate(event, item)}
              onPointerDown={(event) => beginNodeDrag(event, item)}
              ref={(element) => {
                if (element) buttons.current.set(item.node.id, element);
                else buttons.current.delete(item.node.id);
              }}
              style={{ left: item.x, top: item.y }}
              tabIndex={selected?.id === item.node.id ? 0 : -1}
              type="button"
            >
              <span className="flow-node-badge">{nodeBadge(item.node)}</span>
              <b>{item.node.label}</b>
              {item.node.condition && <small>when {item.node.condition}</small>}
              {!item.node.reachable && <small>unreachable</small>}
            </button>
          ))}
        </div>
      </div>
      <div className="flow-inspector" aria-live="polite">
        <div>
          <span>Selected node</span>
          <b>{selected?.label || "None"}</b>
          <small>
            {selected?.sceneName || "Project"} · {selected?.kind}
          </small>
        </div>
        <div>
          <span>Outgoing flow</span>
          {outgoing.length ? (
            <ul>
              {outgoing.map((edge) => <li key={edge.id}>{edgeLabel(edge)}</li>)}
            </ul>
          ) : (
            <small>No outgoing edge</small>
          )}
        </div>
        <div>
          <span>Graph diagnostics</span>
          <b className={graph.diagnostics.some(({ severity }) => severity === "error") ? "bad" : ""}>
            {graph.diagnostics.filter(({ severity }) => severity === "error").length} errors ·{" "}
            {graph.diagnostics.filter(({ severity }) => severity === "warning").length} warnings
          </b>
        </div>
      </div>
    </div>
  );
}
