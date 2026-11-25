import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import { HttpError } from "./config.js";

export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

/** DNS is resolved once and pinned into the connection to prevent DNS rebinding. */
export async function safeFetch(
  input: string,
  options: {
    method?: "GET" | "POST";
    body?: string;
    headers?: Record<string, string>;
    maxBytes?: number;
  } = {},
  redirects = 0,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HttpError(400, "请输入有效的 HTTP 或 HTTPS 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new HttpError(400, "地址协议或认证形式不受支持");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const trusted = (process.env.TRUSTED_FETCH_HOSTS || "")
    .split(",")
    .map((host) => host.trim())
    .includes(hostname);
  const addresses = await lookup(hostname, { all: true }).catch(() => {
    throw new HttpError(400, "远程地址无法解析");
  });
  if (
    !addresses.length ||
    (!trusted && addresses.some((item) => !isPublicAddress(item.address)))
  )
    throw new HttpError(400, "远程地址必须指向公共网络");
  const address = addresses[0];
  const agent = new Agent({
    connect: {
      timeout: 12_000,
      lookup: (_host, opts, callback) => {
        if (opts.all) callback(null, [address] as any);
        else callback(null, address.address, address.family);
      },
    },
  });
  try {
    const response = await request(url, {
      dispatcher: agent,
      method: options.method || "GET",
      body: options.body,
      headers: {
        "user-agent": "ClashWorkbench/0.1 Mihomo",
        ...options.headers,
      },
      signal: AbortSignal.timeout(45_000),
    });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      response.body.destroy();
      if (
        redirects >= 3 ||
        !response.headers.location ||
        options.method === "POST"
      )
        throw new HttpError(400, "远程地址重定向失败");
      const destination = new URL(String(response.headers.location), url);
      const headers =
        destination.origin === url.origin
          ? options.headers
          : Object.fromEntries(
              Object.entries(options.headers || {}).filter(
                ([key]) =>
                  !["authorization", "cookie", "proxy-authorization"].includes(
                    key.toLowerCase(),
                  ),
              ),
            );
      return safeFetch(
        destination.href,
        { ...options, headers },
        redirects + 1,
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.body.destroy();
      throw new HttpError(400, `远程服务返回 HTTP ${response.statusCode}`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > (options.maxBytes || 5 * 1024 * 1024)) {
        response.body.destroy();
        throw new HttpError(400, "远程内容超过大小限制");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "无法连接远程服务，或请求已超时");
  } finally {
    await agent.close();
  }
}
