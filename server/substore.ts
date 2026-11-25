import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { HttpError } from "./config.js";

export function substoreAvailable() {
  return existsSync(resolve("bin/substore.mjs")) || !!process.env.SUBSTORE_URL;
}

export async function convertSubscription(text: string): Promise<string> {
  const modulePath = resolve("bin/substore.mjs");
  if (existsSync(modulePath)) {
    return new Promise((resolveResult, reject) => {
      const worker = new Worker(
        new URL("./substore-worker.mjs", import.meta.url),
        {
          workerData: { modulePath, text },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        },
      );
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new HttpError(400, "Sub-Store 解析超时，请缩小导入内容"));
      }, 15_000);
      const fail = () => {
        clearTimeout(timer);
        void worker.terminate();
        reject(
          new HttpError(400, "Sub-Store 未能解析该订阅，请检查节点链接格式"),
        );
      };
      worker.once("error", fail);
      worker.once("message", (result) => {
        clearTimeout(timer);
        void worker.terminate();
        if (result.error) fail();
        else resolveResult(result.output);
      });
      worker.once("exit", (code) => {
        if (code !== 0) fail();
      });
    });
  }
  if (!process.env.SUBSTORE_URL)
    throw new HttpError(
      400,
      "请先运行 npm run setup，安装 Sub-Store 节点解析组件",
    );
  try {
    const response = await fetch(
      `${process.env.SUBSTORE_URL.replace(/\/$/, "")}/api/proxy/parse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: text, client: "ClashMeta" }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const converted: any = await response.json();
    if (!response.ok || converted.status !== "success") throw new Error();
    return converted.data.par_res;
  } catch {
    throw new HttpError(400, "Sub-Store 适配服务不可用");
  }
}
