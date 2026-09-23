import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const allowedExports = new Set([
  ".",
  "./host",
  "./model",
  "./package.json",
  "./plugins",
  "./protocol",
  "./resource-browser",
]);
const unexpectedExports = Object.keys(packageJson.exports).filter((entry) => !allowedExports.has(entry));
if (unexpectedExports.length) {
  throw new Error(`Altair core exposes non-kernel entry points: ${unexpectedExports.join(", ")}`);
}
const allowedDependencies = new Set(["@haneoka/vega-protocol", "semver"]);
const unexpectedDependencies = Object.keys(packageJson.dependencies ?? {}).filter(
  (dependency) => !allowedDependencies.has(dependency),
);
if (unexpectedDependencies.length) {
  throw new Error(`Altair core has non-kernel runtime dependencies: ${unexpectedDependencies.join(", ")}`);
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
});
if (packed.status !== 0) {
  throw new Error(`npm pack dry run failed:\n${packed.stderr || packed.stdout}`);
}
const report = JSON.parse(packed.stdout)[0];
const paths = report.files.map(({ path }) => path);
const forbiddenPath =
  /^dist\/(?:ai|commands|compile|control-flow|drafts|formats(?:\/|\.js)|history|project-plugins|resources|validation|vega(?:-project)?)(?:\.|\/|$)/u;
const forbiddenPaths = paths.filter((path) => forbiddenPath.test(path));
if (forbiddenPaths.length) {
  throw new Error(`Altair core package contains feature artifacts:\n${forbiddenPaths.join("\n")}`);
}
if (paths.some((path) => /^(?:apps|packages|src)\//u.test(path))) {
  throw new Error("Altair core package contains application or source trees");
}

const forbiddenRuntimeSymbols = [
  "ADV_COMMAND",
  "AltairHttpPluginCatalogProvider",
  "ProjectHistory",
  "adaptProseDeterministically",
  "buildStoryFlowGraph",
  "compileStoryProject",
  "compileVegaProject",
  "loadAltairPluginCatalog",
  "parseAdvStoryJson",
  "serializeAdvStoryJson",
  "storyJsonDraftConflict",
  "storyResourceAliases",
  "validateStoryProject",
];
for (const path of paths.filter((path) => path.endsWith(".js"))) {
  const source = readFileSync(resolve(root, path), "utf8");
  const matches = forbiddenRuntimeSymbols.filter((symbol) => source.includes(symbol));
  if (matches.length) {
    throw new Error(`${path} contains feature implementation symbols: ${matches.join(", ")}`);
  }
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u.test(source) || /\bglobalThis\.fetch\b/u.test(source)) {
    throw new Error(`${path} contains a network implementation`);
  }
}

const rootModule = await import(`${pathToFileURL(resolve(root, "dist/index.js")).href}?boundary-audit`);
const leakedExports = forbiddenRuntimeSymbols.filter((symbol) => symbol in rootModule);
if (leakedExports.length) {
  throw new Error(`Altair root exports feature implementations: ${leakedExports.join(", ")}`);
}
const allowedRuntimeExports = new Set([
  "ALTAIR_PLUGIN_API_VERSION",
  "ALTAIR_SUPPORTED_PLUGIN_API_VERSIONS",
  "AltairPluginHost",
  "STORY_PROJECT_VERSION",
  "assertStoryProjectProtocol",
  "cloneStoryValue",
  "createEmptyStoryProject",
  "createStoryId",
  "defineAltairPlugin",
  "defineAltairService",
  "findStoryScene",
  "importedStoryId",
  "storyDiagnostic",
]);
const unexpectedRuntimeExports = Object.keys(rootModule).filter((name) => !allowedRuntimeExports.has(name));
if (unexpectedRuntimeExports.length) {
  throw new Error(`Altair root has non-kernel runtime exports: ${unexpectedRuntimeExports.join(", ")}`);
}

console.log(`Altair core package boundary verified: ${report.entryCount} files, ${report.unpackedSize} unpacked bytes`);
