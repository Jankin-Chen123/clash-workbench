import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import {
  emptyWorkspace,
  groupTypes,
  type Workspace,
  type Raw,
  type Source,
  type ProxyNode,
} from "../shared/types.js";
import { hash, HttpError } from "./config.js";
import { safeFetch } from "./network.js";
import { convertSubscription } from "./substore.js";
import { RE2JS } from "re2js";

function providerNodes(payload: Raw[], source: Source): ProxyNode[] {
  let nodes = nodesFromRaw(payload, source.id);
  try {
    if (
      (source.filter?.include?.length || 0) > 1000 ||
      (source.filter?.exclude?.length || 0) > 1000
    )
      throw new HttpError(400, "节点过滤表达式最多 1000 个字符");
    const include = source.filter?.include
      ? RE2JS.compile(source.filter.include)
      : undefined;
    const exclude = source.filter?.exclude
      ? RE2JS.compile(source.filter.exclude)
      : undefined;
    nodes = nodes.filter(
      (node) =>
        (!include || include.test(node.originalName)) &&
        (!exclude || !exclude.test(node.originalName)) &&
        !source.filter?.types?.includes(node.raw.type),
    );
    for (const node of nodes) {
      const {
        "additional-prefix": prefix = "",
        "additional-suffix": suffix = "",
        "proxy-name": replacements = [],
        "override-expr": expression,
        ...override
      } = source.override || {};
      if (
        !Array.isArray(replacements) ||
        replacements.length > 100 ||
        replacements.some(
          (item) =>
            typeof item.pattern !== "string" ||
            item.pattern.length > 1000 ||
            typeof item.target !== "string",
        )
      )
        throw new HttpError(400, "节点重命名表达式格式无效或数量过多");
      if (expression)
        throw new HttpError(
          400,
          "override-expr 需要由 Mihomo 动态执行，请先在源配置中将其转换为静态节点参数",
        );
      let name = node.originalName;
      for (const replacement of replacements)
        name = RE2JS.compile(replacement.pattern)
          .matcher(name)
          .replaceAll(replacement.target);
      node.originalName = `${prefix}${name}${suffix}`;
      node.name = node.originalName;
      node.raw = { ...node.raw, ...override };
    }
    return nodes;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      `来源「${source.name}」包含无效的过滤或重命名表达式`,
    );
  }
}

function providerHeaders(input: Raw = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([key]) =>
          ![
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
          ].includes(key.toLowerCase()),
      )
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(", ") : String(value),
      ]),
  );
}

export function parseYaml(text: string): any {
  const doc = parseDocument(text, { uniqueKeys: true, merge: true });
  if (doc.errors.length)
    throw new HttpError(400, "YAML 无法解析，请检查缩进和重复字段");
  try {
    return doc.toJS({ maxAliasCount: 100 });
  } catch {
    throw new HttpError(400, "YAML 引用展开过多");
  }
}

function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function nodesFromRaw(rawNodes: Raw[], sourceId: string): ProxyNode[] {
  if (!Array.isArray(rawNodes) || rawNodes.length > 10000)
    throw new HttpError(400, "每份来源最多导入 10000 个节点");
  const fingerprints = rawNodes.map((raw) => {
    const { name: _n, "dialer-proxy": _d, ...identity } = raw || {};
    return hash(stable(identity)).slice(0, 24);
  });
  const fingerprintCounts = new Map<string, number>();
  for (const fingerprint of fingerprints)
    fingerprintCounts.set(
      fingerprint,
      (fingerprintCounts.get(fingerprint) || 0) + 1,
    );
  const occurrences = new Map<string, number>();
  return rawNodes.map((raw, index) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      !raw.type ||
      !raw.server ||
      !raw.port
    )
      throw new HttpError(400, `第 ${index + 1} 个节点缺少协议、服务器或端口`);
    let fingerprint = fingerprints[index];
    if (fingerprintCounts.get(fingerprint)! > 1) {
      const alias = hash(String(raw.name || "")).slice(0, 10);
      const duplicateKey = `${fingerprint}:${alias}`;
      const occurrence = occurrences.get(duplicateKey) || 0;
      occurrences.set(duplicateKey, occurrence + 1);
      fingerprint = `${duplicateKey}:${occurrence}`;
    }
    const originalName = String(raw.name || `${raw.type} ${index + 1}`);
    return {
      id: `n:${sourceId}:${fingerprint}`,
      sourceId,
      name: originalName,
      originalName,
      raw: structuredClone(raw),
    };
  });
}

async function parseContent(text: string): Promise<Raw> {
  let raw: any;
  try {
    raw = parseYaml(text);
  } catch (error) {
    if (!text.includes("://")) throw error;
  }
  if (Array.isArray(raw)) return { proxies: raw };
  if (raw && typeof raw === "object") {
    for (const key of ["proxies", "proxy-groups", "rules"])
      if (raw[key] !== undefined && !Array.isArray(raw[key]))
        throw new HttpError(400, `${key} 必须是 YAML 列表`);
    return raw;
  }
  try {
    const converted = await convertSubscription(text);
    const parsed =
      typeof converted === "string" ? parseYaml(converted) : converted;
    const proxies = Array.isArray(parsed) ? parsed : parsed.proxies;
    if (!Array.isArray(proxies) || !proxies.length) throw new Error();
    return { proxies };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Sub-Store 未能解析该订阅，请检查服务和订阅格式");
  }
}

export interface ImportInput {
  name: string;
  text?: string;
  url?: string;
  files?: Record<string, string>;
}

export async function importWorkspace(
  input: ImportInput,
  existing?: Workspace,
): Promise<{ workspace: Workspace; warnings: string[] }> {
  const text = input.url ? await safeFetch(input.url) : input.text || "";
  const raw = await parseContent(text);
  const workspace = existing ? structuredClone(existing) : emptyWorkspace();
  const useFullConfig =
    !workspace.sources.length &&
    (Array.isArray(raw.rules) || Array.isArray(raw["proxy-groups"]));
  const warnings: string[] = [];
  const allNewNodes: ProxyNode[] = [];
  const importedSources: Source[] = [];
  const root: Source = {
    id: randomUUID(),
    name: input.name,
    url: input.url,
    refreshedAt: new Date().toISOString(),
    warnings: [],
  };
  const rootNodes = nodesFromRaw(raw.proxies || [], root.id);
  allNewNodes.push(...rootNodes);
  importedSources.push(root);
  const providerMembers = new Map<string, string[]>();
  const providers = raw["proxy-providers"] || {};
  if (Object.keys(providers).length + workspace.sources.length + 1 > 100)
    throw new HttpError(400, "每个项目最多 100 个来源");
  for (const [providerName, value] of Object.entries(providers)) {
    const provider = value as Raw;
    const source: Source = {
      id: randomUUID(),
      name: `${input.name} / ${providerName}`,
      provider: providerName,
      url: provider.url,
      override: provider.override,
      filter: {
        include: provider.filter,
        exclude: provider["exclude-filter"],
        types: provider["exclude-type"]?.split("|"),
      },
      headers: providerHeaders(provider.header),
      refreshedAt: new Date().toISOString(),
      warnings: [],
    };
    let payload = provider.payload;
    if (provider.type === "http" && provider.url)
      payload = (
        await parseContent(
          await safeFetch(provider.url, { headers: source.headers }),
        )
      ).proxies;
    if (provider.type === "file") {
      const file =
        input.files?.[provider.path] ??
        input.files?.[
          String(provider.path).replaceAll("\\", "/").split("/").at(-1)!
        ];
      if (!file)
        throw new HttpError(
          400,
          `节点提供者 ${providerName} 缺少本地文件 ${provider.path}，请补传后重试`,
        );
      payload = (await parseContent(file)).proxies;
    }
    if (!Array.isArray(payload))
      throw new HttpError(400, `节点提供者 ${providerName} 没有可读取的节点`);
    const nodes = providerNodes(payload, source);
    allNewNodes.push(...nodes);
    if (allNewNodes.length + workspace.nodes.length > 10000)
      throw new HttpError(400, "每个项目最多 10000 个节点");
    importedSources.push(source);
    providerMembers.set(
      providerName,
      nodes.map((node) => node.id),
    );
  }
  if (allNewNodes.length > 10000)
    throw new HttpError(400, "单次导入最多 10000 个节点");
  if (!allNewNodes.length && !useFullConfig)
    throw new HttpError(400, "未找到可导入的节点");
  const names = new Set(
    [...workspace.nodes, ...workspace.groups, ...workspace.chains].map(
      (item) => item.name,
    ),
  );
  for (const node of allNewNodes) {
    const baseName =
      node.name.replace(/[\r\n,]/g, " ").slice(0, 100) || "未命名节点";
    let name = baseName;
    let suffix = 2;
    while (
      names.has(name) ||
      ["DIRECT", "REJECT", "PASS", "COMPATIBLE", "REJECT-DROP"].includes(name)
    )
      name = `${baseName} (${suffix++})`;
    if (name !== node.originalName)
      warnings.push(`节点「${node.originalName}」已命名为「${name}」`);
    node.name = name;
    names.add(name);
  }
  workspace.nodes.push(...allNewNodes);
  workspace.sources.push(...importedSources);
  const nameToRef = new Map(
    allNewNodes.map((node) => [node.originalName, node.id]),
  );
  if (useFullConfig) {
    const {
      proxies: _p,
      "proxy-providers": _pp,
      "proxy-groups": _g,
      rules: _r,
      ...base
    } = raw;
    workspace.base = base;
    for (const group of raw["proxy-groups"] || []) {
      if (nameToRef.has(group.name) || names.has(group.name))
        throw new HttpError(
          400,
          `代理组名称「${group.name}」与节点重名，请先在原文件中改名`,
        );
      nameToRef.set(group.name, randomUUID());
      names.add(group.name);
    }
    for (const group of raw["proxy-groups"] || []) {
      const { name, type, proxies = [], use = [], ...extra } = group;
      const members = [
        ...proxies.map((ref: string) => nameToRef.get(ref) || ref),
        ...use.flatMap(
          (provider: string) =>
            providerMembers.get(provider) || [`missing-provider:${provider}`],
        ),
      ];
      if (type === "relay") {
        workspace.chains.push({
          id: nameToRef.get(name)!,
          name,
          hops: members,
        });
        warnings.push(`旧版 relay 组「${name}」已转换为链路，请检查跳转顺序`);
      } else {
        if (!groupTypes.includes(type))
          throw new HttpError(
            400,
            `暂不支持代理组类型 ${type}，请先调整为受支持的组类型`,
          );
        const includeAll =
          extra["include-all"] ||
          extra["include-all-proxies"] ||
          extra["include-all-providers"];
        const allSources =
          extra["include-all"] ||
          (extra["include-all-proxies"] && extra["include-all-providers"]);
        const sourceIds = allSources
          ? undefined
          : extra["include-all-providers"]
            ? importedSources
                .filter((source) => source.provider)
                .map((source) => source.id)
            : extra["include-all-proxies"]
              ? [root.id]
              : use
                  .map(
                    (provider: string) =>
                      importedSources.find(
                        (source) => source.provider === provider,
                      )?.id,
                  )
                  .filter(Boolean);
        const match =
          includeAll || use.length
            ? {
                sourceId: "",
                contains: "",
                sourceIds,
                regex: extra.filter,
                excludeRegex: extra["exclude-filter"],
                excludeTypes: extra["exclude-type"]?.split("|"),
              }
            : undefined;
        // Explicit entries stay pinned. Provider selections remain dynamic for future refreshes.
        const explicitMembers = proxies.map(
          (ref: string) => nameToRef.get(ref) || ref,
        );
        delete extra["include-all"];
        delete extra["include-all-proxies"];
        delete extra["include-all-providers"];
        if (match) {
          delete extra.filter;
          delete extra["exclude-filter"];
          delete extra["exclude-type"];
        }
        workspace.groups.push({
          id: nameToRef.get(name)!,
          name,
          type,
          members: match
            ? explicitMembers
            : ([...new Set(members)] as string[]),
          match,
          excluded: [],
          extra,
        });
      }
    }
    workspace.rules = (raw.rules || []).map((text: string) => ({
      id: randomUUID(),
      text: String(text),
      enabled: true,
    }));
  } else if (!existing?.sources.length) {
    workspace.groups.push({
      id: randomUUID(),
      name: "代理选择",
      type: "select",
      members: [],
      match: { sourceId: "", contains: "" },
      excluded: [],
      extra: {},
    });
    workspace.rules.push({
      id: randomUUID(),
      text: "MATCH,代理选择",
      enabled: true,
    });
  }
  for (const node of allNewNodes) {
    if (node.raw["dialer-proxy"])
      node.dialer =
        nameToRef.get(node.raw["dialer-proxy"]) ||
        [...workspace.groups, ...workspace.nodes].find(
          (item) => item.name === node.raw["dialer-proxy"],
        )?.id ||
        node.raw["dialer-proxy"];
    delete node.raw["dialer-proxy"];
  }
  root.warnings = warnings;
  return { workspace, warnings };
}

export async function refreshSources(workspace: Workspace): Promise<Workspace> {
  const result = structuredClone(workspace);
  for (const source of result.sources.filter((source) => source.url)) {
    try {
      const raw = await parseContent(
        await safeFetch(source.url!, { headers: source.headers }),
      );
      let nodes = providerNodes(raw.proxies || [], source);
      if (!nodes.length && raw["proxy-providers"]) {
        source.refreshedAt = new Date().toISOString();
        source.error = undefined;
        continue;
      }
      if (!nodes.length)
        throw new HttpError(400, "来源未返回节点，已保留原节点");
      const previous = result.nodes.filter(
        (node) => node.sourceId === source.id,
      );
      const usedNames = new Set(
        [
          ...result.nodes.filter((node) => node.sourceId !== source.id),
          ...result.groups,
          ...result.chains,
        ].map((item) => item.name),
      );
      nodes = nodes.map((node) => {
        const old = previous.find((item) => item.id === node.id);
        if (old) {
          node.name = old.name;
          node.dialer = old.dialer;
        }
        if (!old && node.raw["dialer-proxy"])
          node.dialer =
            [...result.groups, ...result.nodes, ...nodes].find(
              (item) => item.name === node.raw["dialer-proxy"],
            )?.id || node.raw["dialer-proxy"];
        let name = node.name;
        let suffix = 2;
        while (usedNames.has(name)) name = `${node.name} (${suffix++})`;
        node.name = name;
        usedNames.add(name);
        delete node.raw["dialer-proxy"];
        return node;
      });
      result.nodes = [
        ...result.nodes.filter((node) => node.sourceId !== source.id),
        ...nodes,
      ];
      source.refreshedAt = new Date().toISOString();
      source.error = undefined;
    } catch (error) {
      source.error =
        error instanceof HttpError ? error.message : "刷新失败，已保留原节点";
    }
  }
  return result;
}
