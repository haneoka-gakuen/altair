import { AiError, type AiProfile, type AiRoutes } from "./services";
let database: Promise<IDBDatabase> | undefined;
const open = () =>
  (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("altair-device-ai", 1);
    request.onupgradeneeded = () => {
      for (const name of ["profiles", "credentials", "settings"]) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
async function read<T>(name: string, key?: string): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readonly"),
      store = tx.objectStore(name),
      request = key === undefined ? store.getAll() : store.get(key);
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}
export const readAiProfiles = () => read<AiProfile[]>("profiles");
export const readAiKey = async (id: string) => (await read<string | undefined>("credentials", id)) ?? "";
export const readAiRoutes = async () => (await read<AiRoutes | undefined>("settings", "routes")) ?? {};
export async function readAiConnection(id: string): Promise<{ profile?: AiProfile; key: string }> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["profiles", "credentials"], "readonly"),
      profile = tx.objectStore("profiles").get(id),
      key = tx.objectStore("credentials").get(id);
    tx.oncomplete = () =>
      resolve({ profile: profile.result as AiProfile | undefined, key: (key.result as string | undefined) ?? "" });
    tx.onabort = () => reject(tx.error);
  });
}
export async function saveAiProfile(profile: AiProfile, key?: string): Promise<AiProfile> {
  serviceProfile(profile);
  const db = await open();
  return new Promise<AiProfile>((resolve, reject) => {
    const tx = db.transaction(["profiles", "credentials"], "readwrite");
    const store = tx.objectStore("profiles"),
      current = store.get(profile.id);
    let saved: AiProfile, failure: Error | undefined;
    current.onsuccess = () => {
      const previous = current.result as AiProfile | undefined;
      if ((previous?.revision ?? 0) !== (profile.revision ?? 0)) {
        failure = new AiError({ code: "changed" });
        tx.abort();
        return;
      }
      saved = { ...profile, revision: (previous?.revision ?? 0) + 1 };
      store.put(saved, profile.id);
      if (key !== undefined) tx.objectStore("credentials").put(key, profile.id);
    };
    tx.oncomplete = () => resolve(saved);
    tx.onabort = () => reject(failure ?? tx.error);
  });
}
export async function saveAiRoutes(routes: AiRoutes) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put(routes, "routes");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
export async function deleteAiProfile(id: string) {
  const routes = await readAiRoutes();
  for (const task of ["edit", "director", "translate", "vision"] as const)
    if (routes[task]?.profileId === id) delete routes[task];
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["profiles", "credentials", "settings"], "readwrite");
    tx.objectStore("profiles").delete(id);
    tx.objectStore("credentials").delete(id);
    tx.objectStore("settings").put(routes, "routes");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
function serviceProfile(profile: AiProfile): void {
  if (
    !profile.id ||
    !profile.name.trim() ||
    !["responses", "chat", "anthropic", "gemini"].includes(profile.protocol) ||
    !["schema", "json", "prompt"].includes(profile.format) ||
    !Number.isInteger(profile.maxTokens) ||
    profile.maxTokens < 128 ||
    profile.maxTokens > 131072 ||
    !Number.isFinite(profile.timeoutSeconds) ||
    profile.timeoutSeconds < 5 ||
    profile.timeoutSeconds > 600 ||
    !Number.isInteger(profile.maxContextChars) ||
    profile.maxContextChars < 1000 ||
    profile.maxContextChars > 2_000_000
  )
    throw new AiError({ code: "settings" });
}
export async function exportAiSettings(): Promise<string> {
  return JSON.stringify(
    { format: "altair-ai-settings", version: 1, profiles: await readAiProfiles(), routes: await readAiRoutes() },
    null,
    2,
  );
}
