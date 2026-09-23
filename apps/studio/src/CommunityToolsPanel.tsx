import { useEffect, useMemo, useRef, useState } from "react";
import { StudioIcon } from "./StudioIcon";

type ModelPart = Record<string, unknown> & { path: string };
function parseGroup(source: string): {
  parts: ModelPart[];
  metadata: Record<string, unknown>[];
} {
  const parts: ModelPart[] = [];
  const metadata: Record<string, unknown>[] = [];
  source.split(/\r?\n/u).forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`第 ${index + 1} 行不是合法的 JSON`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`第 ${index + 1} 行必须是对象`);
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string" && record.path.trim()) parts.push(record as ModelPart);
    else if ("motions" in record || "expressions" in record || "import" in record) metadata.push(record);
    else throw new Error(`第 ${index + 1} 行缺少模型路径或动作/表情信息`);
  });
  return { parts, metadata };
}

export function CommunityToolsPanel({
  onClose,
  onInsert,
}: {
  readonly onClose: () => void;
  readonly onInsert: (source: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"transform" | "jsonl">("transform");
  const [target, setTarget] = useState("fig-center");
  const [transform, setTransform] = useState({
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    alpha: 1,
    duration: 500,
  });
  const [next, setNext] = useState(true);
  const [source, setSource] = useState("");
  const [filename, setFilename] = useState("character.jsonl");
  const [issue, setIssue] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const group = useMemo(() => {
    try {
      return parseGroup(source);
    } catch {
      return null;
    }
  }, [source]);
  const transformCommand = `setTransform:${JSON.stringify({ position: { x: transform.x, y: transform.y }, scale: { x: transform.scaleX, y: transform.scaleY }, rotation: transform.rotation, alpha: transform.alpha })} -target=${target} -duration=${transform.duration}${next ? " -next" : ""};`;
  const validTarget = Boolean(target.trim()) && !/[\s;=]/u.test(target);
  const save = () => {
    try {
      parseGroup(source);
      const url = URL.createObjectURL(new Blob([source], { type: "application/x-ndjson" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename.replace(/[\\/]/gu, "-");
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setIssue("");
    } catch (error) {
      setIssue(String(error));
    }
  };
  const move = (index: number, delta: number) => {
    if (!group || !group.parts[index + delta]) return;
    const parts = [...group.parts];
    [parts[index], parts[index + delta]] = [parts[index + delta]!, parts[index]!];
    // Keep unknown fields and header data. The explicit index follows the new
    // order only when the source format included it.
    setSource(
      [...parts.map((part, i) => ("index" in part ? { ...part, index: i } : part)), ...group.metadata]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
  };
  return (
    <dialog ref={dialog} className="terre-tool-dialog" onCancel={onClose} onClose={onClose}>
      <header>
        <h2>创作工具箱</h2>
        <button aria-label="关闭工具箱" onClick={onClose}>
          <StudioIcon name="close" />
        </button>
      </header>
      <nav aria-label="工具">
        <button aria-pressed={tab === "transform"} onClick={() => setTab("transform")}>
          变换脚本
        </button>
        <button aria-pressed={tab === "jsonl"} onClick={() => setTab("jsonl")}>
          JSONL 模型组
        </button>
      </nav>
      {tab === "transform" ? (
        <>
          <label>
            目标 ID
            <input value={target} onChange={(event) => setTarget(event.target.value)} />
          </label>
          <div className="terre-tool-fields">
            {Object.entries(transform).map(([key, value]) => (
              <label key={key}>
                {
                  (
                    {
                      x: "X 位置",
                      y: "Y 位置",
                      scaleX: "X 缩放",
                      scaleY: "Y 缩放",
                      rotation: "旋转（弧度）",
                      alpha: "不透明度",
                      duration: "时长（毫秒）",
                    } as Record<string, string>
                  )[key]
                }
                <input
                  type="number"
                  step={key === "duration" ? 1 : 0.01}
                  min={key === "duration" || key === "alpha" ? 0 : undefined}
                  max={key === "alpha" ? 1 : undefined}
                  value={value}
                  onChange={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isFinite(value))
                      setTransform((old) => ({
                        ...old,
                        [key]:
                          key === "alpha"
                            ? Math.max(0, Math.min(1, value))
                            : key === "duration"
                              ? Math.max(0, value)
                              : value,
                      }));
                  }}
                />
              </label>
            ))}
          </div>
          <label className="terre-check">
            <input type="checkbox" checked={next} onChange={(event) => setNext(event.target.checked)} />
            执行后继续（next）
          </label>
          <textarea aria-label="生成的 WebGAL 变换指令" readOnly value={transformCommand} />
          {!validTarget && <p role="alert">目标 ID 不能包含空格、分号或等号。</p>}
          <footer>
            <button
              disabled={!validTarget}
              onClick={() => {
                onInsert(transformCommand);
                onClose();
              }}
            >
              插入当前脚本
            </button>
            <button
              disabled={!validTarget}
              onClick={() =>
                void navigator.clipboard.writeText(transformCommand).catch((error) => setIssue(String(error)))
              }
            >
              复制指令
            </button>
          </footer>
        </>
      ) : (
        <>
          <label>
            打开 JSONL
            <input
              type="file"
              accept=".jsonl,.ndjson"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file)
                  void file
                    .text()
                    .then((text) => {
                      setSource(text);
                      setFilename(file.name);
                      setIssue("");
                    })
                    .catch((error) => setIssue(String(error)));
              }}
            />
          </label>
          <textarea
            aria-label="JSONL 模型组内容"
            placeholder={
              '{"index":0,"id":"body","path":"body/model.json"}\n{"motions":["idle"],"expressions":["default"]}'
            }
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          {group ? (
            <ol className="terre-model-parts">
              {group.parts.map((part, index) => (
                <li key={index}>
                  <span>
                    {String(part.id ?? index)} · {part.path}
                  </span>
                  <button aria-label={`上移部件 ${index + 1}`} disabled={!index} onClick={() => move(index, -1)}>
                    <StudioIcon name="chevron-up" />
                  </button>
                  <button
                    aria-label={`下移部件 ${index + 1}`}
                    disabled={index === group.parts.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <StudioIcon name="chevron-down" />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p role="alert">JSONL 格式有误，请检查每行对象。</p>
          )}
          <footer>
            <button disabled={!group?.parts.length} onClick={save}>
              保存 JSONL
            </button>
            <span>{group?.parts.length ?? 0} 个部件</span>
          </footer>
        </>
      )}
      {issue && <p role="alert">{issue}</p>}
    </dialog>
  );
}
