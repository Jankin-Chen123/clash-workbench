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

type ResolvedAddress = { address: string; family: number };
const fakeIpRange = ipaddr.parseCIDR("198.18.0.0/15");

export function isFakeIpAddress(address: string) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.kind() === "ipv4" && parsed.match(fakeIpRange);
  } catch {
    return false;
  }
}

async function resolveRealAddresses(
  hostname: string,
): Promise<ResolvedAddress[]> {
  const providers = [
    { url: "https://dns.alidns.com/resolve", address: "223.5.5.5" },
    { url: "https://cloudflare-dns.com/dns-query", address: "1.1.1.1" },
  ];
  for (const provider of providers) {
    // Bootstrap through a fixed public IP, preserving the resolver's TLS hostname.
    const agent = new Agent({
      connect: {
        timeout: 5000,
        lookup: (_host, options, callback) => {
          if (options.all)
            callback(null, [{ address: provider.address, family: 4 }] as any);
          else callback(null, provider.address, 4);
        },
      },
    });
    try {
      const results = await Promise.allSettled(
        [1, 28].map(async (type) => {
          const url = new URL(provider.url);
          url.searchParams.set("name", hostname);
          url.searchParams.set("type", String(type));
          const response = await request(url, {
            dispatcher: agent,
            headers: { accept: "application/dns-json" },
            signal: AbortSignal.timeout(5000),
          });
          if (response.statusCode !== 200) {
            response.body.destroy();
            throw new Error("DNS response failed");
          }
          const text = await response.body.text();
          if (text.length > 65536) throw new Error("DNS response too large");
          const body = JSON.parse(text);
          if (body.Status !== 0 || !Array.isArray(body.Answer)) return [];
          return body.Answer.filter(
            (record: any) =>
              record.type === type &&
              typeof record.data === "string" &&
              ipaddr.isValid(record.data),
          ).map((record: any) => ({
            address: record.data,
            family: type === 1 ? 4 : 6,
          }));
        }),
      );
      const addresses = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      if (addresses.length) return addresses;
    } finally {
      await agent.close();
    }
  }
  throw new HttpError(
    400,
    "检测到代理 Fake-IP，查询真实公网地址失败，请检查公共 DNS 服务的连接",
  );
}

export async function selectSafeAddresses(
  hostname: string,
  addresses: ResolvedAddress[],
  trusted: boolean,
  resolveFakeIp: (
    hostname: string,
  ) => Promise<ResolvedAddress[]> = resolveRealAddresses,
): Promise<ResolvedAddress[]> {
  let resolved = addresses;
  if (
    !trusted &&
    !ipaddr.isValid(hostname) &&
    resolved.length &&
    resolved.every((item) => isFakeIpAddress(item.address))
  ) {
    resolved = await resolveFakeIp(hostname);
  }
  if (
    !resolved.length ||
    (!trusted && resolved.some((item) => !isPublicAddress(item.address)))
  )
    throw new HttpError(400, "远程地址必须指向公共网络");
  return resolved;
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
  const systemAddresses = await lookup(hostname, { all: true }).catch(() => {
    throw new HttpError(400, "远程地址无法解析");
  });
  const addresses = await selectSafeAddresses(
    hostname,
    systemAddresses,
    trusted,
  );
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
