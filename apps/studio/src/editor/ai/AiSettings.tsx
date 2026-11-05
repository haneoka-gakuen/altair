import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { X, Plus, Trash2, Download, RefreshCw } from "@haneoka/altair-ui-react";
import { tr, useStudioI18n } from "../i18n";
import { downloadStudioFile } from "../studio-host";
import {
  AI_PRESETS,
  AI_TASKS,
  AiError,
  aiFailure,
  profileFromPreset,
  serviceUrl,
  type AiFailure,
  type AiProfile,
  type AiRoutes,
} from "./services";
import {
  readAiProfiles,
  readAiKey,
  readAiRoutes,
  saveAiProfile,
  saveAiRoutes,
  deleteAiProfile,
  exportAiSettings,
} from "./storage";
import { completeAi, discoverAiModels } from "./client";
import "./ai.css";
export const AI_SETTINGS_CHANGED = "altair-ai-settings-changed";
export const aiErrorText = (error: unknown) => {
  const failure = aiFailure(error);
  return tr(`ai.error.${failure.code}`, { status: failure.status });
};

export function AiSettings({ onClose }: { onClose(): void }) {
  const { i18n } = useStudioI18n();
  const [profileLoading, setProfileLoading] = useState(true);
  const [profiles, setProfiles] = useState<AiProfile[]>([]),
    [routes, setRoutes] = useState<AiRoutes>({});
  const [selected, setSelected] = useState(""),
    [draft, setDraft] = useState<AiProfile>();
  const [key, setKey] = useState(""),
    [showKey, setShowKey] = useState(false),
    [preset, setPreset] = useState("openai");
  const [tab, setTab] = useState<"services" | "tasks">("services"),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  const [failure, setFailure] = useState<AiFailure>();
  const operation = useRef<AbortController | undefined>(undefined);
  const notify = () => window.dispatchEvent(new Event(AI_SETTINGS_CHANGED));
  useEffect(() => {
    let live = true;
    void Promise.all([readAiProfiles(), readAiRoutes()])
      .then(([items, routing]) => {
        if (!live) return;
        setProfiles(items);
        setRoutes(routing);
        setSelected(items[0]?.id ?? "");
        if (!items.length) setProfileLoading(false);
      })
      .catch((error) => live && setFailure(aiFailure(error)));
    return () => {
      live = false;
      operation.current?.abort();
    };
  }, []);
  useEffect(() => {
    let live = true;
    const profile = profiles.find((item) => item.id === selected);
    if (profile) {
      setProfileLoading(true);
      setKey("");
      setDraft(profile);
      void readAiKey(profile.id)
        .then((value) => {
          if (live) {
            setKey(value);
            setProfileLoading(false);
          }
        })
        .catch((error) => {
          if (live) {
            setFailure(aiFailure(error));
            setProfileLoading(false);
          }
        });
    }
    return () => {
      live = false;
    };
  }, [selected, profiles]);
  const edit = (values: Partial<AiProfile>) => {
    setDraft((value) => (value ? { ...value, ...values, probe: undefined } : undefined));
    setFailure(undefined);
    setStatus("");
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setFailure(undefined);
    setStatus("");
    try {
      await action(controller.signal);
    } catch (error) {
      setFailure(aiFailure(error));
    } finally {
      if (operation.current === controller) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  };
  const save = async (profile = draft): Promise<AiProfile> => {
    if (!profile) throw new AiError({ code: "url" });
    serviceUrl(profile, "models");
    let value = {
      ...profile,
      name:
        profile.name.trim() || tr(AI_PRESETS.find((item) => item.id === profile.preset)?.label ?? "ai.customService"),
    };
    value = await saveAiProfile(value, key);
    const nextRoutes = { ...routes };
    const old = profiles.find((item) => item.id === value.id);
    for (const task of AI_TASKS)
      if (
        (!profiles.length && !nextRoutes[task]) ||
        (nextRoutes[task]?.profileId === value.id &&
          (!nextRoutes[task]?.model || nextRoutes[task]?.model === old?.model))
      )
        nextRoutes[task] = { profileId: value.id, model: value.model };
    await saveAiRoutes(nextRoutes);
    setRoutes(nextRoutes);
    setProfiles((items) => [...items.filter((item) => item.id !== value.id), value]);
    notify();
    return value;
  };
  const add = () => {
    const profile = profileFromPreset(preset);
    profile.name = tr(profile.name);
    setSelected(profile.id);
    setDraft(profile);
    setKey("");
    setProfileLoading(false);
    setFailure(undefined);
    setStatus("");
  };
  const discover = () =>
    run(async (signal) => {
      const profile = await save();
      const models = await discoverAiModels(profile, signal);
      const next = await saveAiProfile({ ...profile, models });
      setProfiles((items) => items.map((item) => (item.id === next.id ? next : item)));
      setDraft(next);
      setStatus(tr("ai.modelCount", { count: models.length }));
      notify();
    });
  const probe = () =>
    run(async (signal) => {
      const profile = await save();
      try {
        const text = await completeAi(
          profile,
          {
            system: "Return JSON only.",
            prompt: "Return an object with ok equal to true.",
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
            maxTokens: Math.min(1024, profile.maxTokens),
          },
          signal,
        );
        if (JSON.parse(text)?.ok !== true) throw new AiError({ code: "invalidResponse" });
        const next = await saveAiProfile({
          ...profile,
          probe: { testedAt: new Date().toISOString(), model: profile.model, ok: true },
        });
        setProfiles((items) => items.map((item) => (item.id === next.id ? next : item)));
        setDraft(next);
        setStatus(tr("ai.connected"));
        notify();
      } catch (error) {
        const next = await saveAiProfile({
          ...profile,
          probe: { testedAt: new Date().toISOString(), model: profile.model, ok: false, failure: aiFailure(error) },
        });
        setProfiles((items) => items.map((item) => (item.id === next.id ? next : item)));
        setDraft(next);
        throw error;
      }
    });
  const remove = () =>
    run(async () => {
      if (!draft) return;
      await deleteAiProfile(draft.id);
      const items = await readAiProfiles();
      setProfiles(items);
      setRoutes(await readAiRoutes());
      setSelected(items[0]?.id ?? "");
      setDraft(items[0]);
      setKey("");
      notify();
    });
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content ai-settings-dialog" aria-describedby={undefined} aria-busy={busy}>
          <header className="ai-dialog-header">
            <Dialog.Title>{tr("ai.services")}</Dialog.Title>
            <span className="ai-device">{tr("ai.device")}</span>
            <Dialog.Close className="icon-button" aria-label={tr("Close")} disabled={busy || profileLoading}>
              <X size={20} />
            </Dialog.Close>
          </header>
          <div
            className="ai-tabs"
            role="tablist"
            aria-label={tr("ai.services")}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "services"
                  : event.key === "End"
                    ? "tasks"
                    : tab === "services"
                      ? "tasks"
                      : "services";
              setTab(next);
              event.currentTarget.querySelector<HTMLButtonElement>(`#ai-tab-${next}`)?.focus();
            }}
          >
            <button
              role="tab"
              id="ai-tab-services"
              aria-controls="ai-settings-panel"
              tabIndex={tab === "services" ? 0 : -1}
              aria-selected={tab === "services"}
              onClick={() => setTab("services")}
            >
              {tr("ai.services")}
            </button>
            <button
              role="tab"
              id="ai-tab-tasks"
              aria-controls="ai-settings-panel"
              tabIndex={tab === "tasks" ? 0 : -1}
              aria-selected={tab === "tasks"}
              onClick={() => setTab("tasks")}
            >
              {tr("ai.taskModels")}
            </button>
          </div>
          <div className="ai-settings-body" role="tabpanel" id="ai-settings-panel" aria-labelledby={`ai-tab-${tab}`}>
            {tab === "tasks" ? (
              <div className="ai-task-routes">
                {AI_TASKS.map((task) => {
                  const route = routes[task],
                    profile = profiles.find((item) => item.id === route?.profileId);
                  return (
                    <section key={task} className="ai-section">
                      <h3>{tr(`ai.task.${task}`)}</h3>
                      <label className="field">
                        <span>{tr("ai.service")}</span>
                        <select
                          value={route?.profileId ?? ""}
                          disabled={busy || profileLoading}
                          onChange={(event) => {
                            const profile = profiles.find((item) => item.id === event.target.value);
                            setRoutes((current) => ({
                              ...current,
                              [task]: profile ? { profileId: profile.id, model: profile.model } : undefined,
                            }));
                          }}
                        >
                          <option value="">{tr("ai.notAssigned")}</option>
                          {profiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>{tr("ai.model")}</span>
                        <input
                          disabled={!profile || busy}
                          value={route?.model ?? ""}
                          list={`ai-task-${task}`}
                          onChange={(event) =>
                            setRoutes((current) => ({
                              ...current,
                              [task]: { profileId: profile!.id, model: event.target.value },
                            }))
                          }
                        />
                        <datalist id={`ai-task-${task}`}>
                          {profile?.models?.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name}
                            </option>
                          ))}
                        </datalist>
                      </label>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="ai-settings-layout">
                <aside className="ai-services-list">
                  <label className="field">
                    <span>{tr("ai.preset")}</span>
                    <select
                      value={preset}
                      onChange={(event) => setPreset(event.target.value)}
                      disabled={busy || profileLoading}
                    >
                      {AI_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {tr(preset.label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="secondary-button" onClick={add} disabled={busy || profileLoading}>
                    <Plus size={20} />
                    {tr("ai.addService")}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy || profileLoading}
                    onClick={() =>
                      void run(async () => {
                        const items = await readAiProfiles();
                        setProfiles(items);
                        setRoutes(await readAiRoutes());
                        setSelected(items.find((item) => item.id === selected)?.id ?? items[0]?.id ?? "");
                      })
                    }
                  >
                    <RefreshCw size={20} />
                    {tr("Refresh")}
                  </button>
                  <div className="ai-profile-choices">
                    {profiles.map((profile) => (
                      <button
                        key={profile.id}
                        aria-pressed={selected === profile.id}
                        disabled={busy || profileLoading}
                        onClick={() => {
                          setProfileLoading(true);
                          setKey("");
                          setSelected(profile.id);
                          setFailure(undefined);
                          setStatus("");
                        }}
                      >
                        <strong>{profile.name}</strong>
                        <span>{profile.model || tr("ai.model")}</span>
                      </button>
                    ))}
                  </div>
                </aside>
                {draft ? (
                  <fieldset className="ai-profile-form" disabled={busy || profileLoading}>
                    <label className="field">
                      <span>{tr("Name")}</span>
                      <input value={draft.name} onChange={(event) => edit({ name: event.target.value })} />
                    </label>
                    <label className="field">
                      <span>{tr("ai.protocol")}</span>
                      <select
                        value={draft.protocol}
                        onChange={(event) =>
                          edit({ protocol: event.target.value as AiProfile["protocol"], format: "prompt" })
                        }
                      >
                        <option value="responses">OpenAI Responses</option>
                        <option value="chat">OpenAI Chat Completions</option>
                        <option value="anthropic">Anthropic Messages</option>
                        <option value="gemini">Gemini</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>{tr("ai.endpoint")}</span>
                      <input
                        type="url"
                        value={draft.endpoint}
                        aria-invalid={failure?.code === "url"}
                        onChange={(event) => edit({ endpoint: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>{tr("ai.authentication")}</span>
                      <select
                        value={draft.keyRequired ? "key" : "none"}
                        onChange={(event) => edit({ keyRequired: event.target.value === "key" })}
                      >
                        <option value="key">API Key</option>
                        <option value="none">{tr("ai.noKey")}</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>API Key</span>
                      <span className="ai-key-input">
                        <input
                          aria-label="API Key"
                          type={showKey ? "text" : "password"}
                          value={key}
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={4096}
                          aria-invalid={failure?.code === "key" || failure?.status === 401}
                          onChange={(event) => {
                            setKey(event.target.value);
                            edit({});
                          }}
                        />
                        <button type="button" onClick={() => setShowKey((show) => !show)}>
                          {tr(showKey ? "ai.hideKey" : "ai.showKey")}
                        </button>
                      </span>
                    </label>
                    <label className="field">
                      <span>{tr("ai.model")}</span>
                      <input
                        value={draft.model}
                        list="ai-profile-models"
                        aria-invalid={failure?.code === "model"}
                        onChange={(event) => edit({ model: event.target.value })}
                      />
                      <datalist id="ai-profile-models">
                        {draft.models?.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))}
                      </datalist>
                    </label>
                    <div className="ai-button-row">
                      <button className="secondary-button" onClick={() => void discover()}>
                        <RefreshCw size={20} />
                        {tr("ai.discoverModels")}
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => void probe()}
                        disabled={!draft.model || profileLoading}
                      >
                        {tr("ai.testConnection")}
                      </button>
                    </div>
                    <details className="argument-section">
                      <summary>{tr("ai.generation")}</summary>
                      <div className="ai-section">
                        <label className="field">
                          <span>{tr("ai.outputFormat")}</span>
                          <select
                            value={draft.format}
                            onChange={(event) => edit({ format: event.target.value as AiProfile["format"] })}
                          >
                            <option value="schema">JSON Schema</option>
                            {draft.protocol !== "anthropic" && <option value="json">JSON</option>}
                            <option value="prompt">{tr("ai.promptJson")}</option>
                          </select>
                        </label>
                        {(
                          [
                            ["maxTokens", "ai.outputTokens", 128, 131072],
                            ["maxContextChars", "ai.contextChars", 1000, 2000000],
                            ["timeoutSeconds", "ai.timeout", 5, 600],
                          ] as const
                        ).map(([field, label, min, max]) => (
                          <label className="field" key={field}>
                            <span>{tr(label)}</span>
                            <input
                              type="number"
                              min={min}
                              max={max}
                              step={1}
                              value={draft[field]}
                              onChange={(event) => edit({ [field]: event.target.valueAsNumber })}
                            />
                          </label>
                        ))}
                      </div>
                    </details>
                    {draft.probe && (
                      <dl className="ai-probe">
                        <dt>{tr("ai.lastConnection")}</dt>
                        <dd>
                          {draft.probe.ok
                            ? tr("ai.connected")
                            : tr(`ai.error.${draft.probe.failure?.code ?? "network"}`, {
                                status: draft.probe.failure?.status,
                              })}
                        </dd>
                        <dt>{tr("ai.model")}</dt>
                        <dd>{draft.probe.model}</dd>
                        <dt>{tr("ai.testedAt")}</dt>
                        <dd>{new Date(draft.probe.testedAt).toLocaleString(i18n.resolvedLanguage)}</dd>
                      </dl>
                    )}
                  </fieldset>
                ) : (
                  <div className="empty-panel">{tr("ai.addService")}</div>
                )}
              </div>
            )}
          </div>
          <footer className="ai-settings-footer">
            <span role="status" className="ai-status">
              {failure ? tr(`ai.error.${failure.code}`, { status: failure.status }) : status}
            </span>
            <div className="ai-button-row">
              <button
                className="icon-button"
                aria-label={tr("ai.exportSettings")}
                disabled={busy || profileLoading}
                onClick={() =>
                  void run(async () =>
                    downloadStudioFile(
                      new Blob([await exportAiSettings()], { type: "application/json" }),
                      "ai-settings.json",
                    ),
                  )
                }
              >
                <Download size={20} />
              </button>
              {tab === "services" && draft && (
                <button
                  className="icon-button"
                  aria-label={tr("Remove")}
                  disabled={busy || profileLoading}
                  onClick={() => void remove()}
                >
                  <Trash2 size={20} />
                </button>
              )}
              {busy ? (
                <button className="secondary-button" onClick={() => operation.current?.abort()}>
                  {tr("Cancel")}
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={profileLoading || (tab === "services" && !draft)}
                  onClick={() =>
                    void run(async () => {
                      if (tab === "services") await save();
                      else {
                        await saveAiRoutes(routes);
                        notify();
                      }
                      setStatus(tr("ai.saved"));
                    })
                  }
                >
                  {tr("Save")}
                </button>
              )}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
