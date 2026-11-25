import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

// The upstream parser may log malformed input containing credentials.
console.log =
  console.info =
  console.warn =
  console.error =
  console.debug =
    () => {};
// Use the upstream browser runtime so the parser has no Node file persistence.
globalThis.process = undefined;
const cache = new Map();
globalThis.$Plugins = {
  SubStoreCache: {
    get: (key) => cache.get(key),
    set: (key, value) => cache.set(key, value),
  },
};
try {
  const { parse, produce } = await import(
    pathToFileURL(workerData.modulePath).href
  );
  const nodes = parse(workerData.text);
  const output = produce(nodes, "ClashMeta");
  parentPort.postMessage({ output });
} catch {
  parentPort.postMessage({ error: true });
}
