import { stringify } from "yaml";
import { RE2JS } from "re2js";
import {
  builtinRefs,
  groupMembers,
  referenceName,
  splitRule,
  ruleTargetIndex,
  type Workspace,
  type Issue,
  type Raw,
} from "../shared/types.js";

export function validate(workspace: Workspace): Issue[] {
  const issues: Issue[] = [];
  const error = (message: string) => issues.push({ level: "error", message });
  const warn = (message: string) => issues.push({ level: "warning", message });
  for (const [name, provider] of Object.entries(
    workspace.base["rule-providers"] || {},
  ) as [string, Raw][]) {
    if (
      !provider ||
      !["http", "file", "inline"].includes(provider.type) ||
      !["classical", "domain", "ipcidr"].includes(provider.behavior)
    ) {
      error(`规则集「${name}」的类型或 behavior 无效`);
      continue;
    }
    if (provider.format && !["yaml", "text", "mrs"].includes(provider.format))
      error(`规则集「${name}」的格式无效`);
    if (provider.format === "mrs" && provider.behavior === "classical")
      error(`规则集「${name}」的 MRS 格式不能使用 classical`);
    if (provider.type === "http") {
      try {
        if (!["http:", "https:"].includes(new URL(provider.url).protocol))
          throw new Error();
      } catch {
        error(`规则集「${name}」缺少有效的 HTTP 地址`);
      }
    }
    if (provider.type === "inline" && !Array.isArray(provider.payload))
      error(`规则集「${name}」缺少内联 payload 列表`);
    if (provider.type === "file")
      warn(`规则集「${name}」引用客户端本地文件，请确认客户端存在该文件`);
  }
  const entities = [
    ...workspace.nodes,
    ...workspace.groups,
    ...workspace.chains,
  ];
  const names = new Set<string>(builtinRefs);
  const ids = new Set<string>(builtinRefs);
  for (const entity of entities) {
    if (names.has(entity.name))
      error(`名称「${entity.name}」重复或与内置策略重名`);
    if (ids.has(entity.id)) error("存在重复的对象 ID");
    names.add(entity.name);
    ids.add(entity.id);
  }
  for (const node of workspace.nodes) {
    if (
      !node.raw.type ||
      !node.raw.server ||
      !Number.isInteger(Number(node.raw.port)) ||
      Number(node.raw.port) < 1 ||
      Number(node.raw.port) > 65535
    )
      error(`节点「${node.name}」的服务器或端口无效`);
    if (node.dialer && !ids.has(node.dialer))
      error(`节点「${node.name}」的上游代理不存在`);
  }
  const edges = new Map<string, string[]>();
  for (const node of workspace.nodes)
    edges.set(node.id, node.dialer ? [node.dialer] : []);
  for (const group of workspace.groups) {
    try {
      if (group.match?.regex) RE2JS.compile(group.match.regex);
      if (group.match?.excludeRegex) RE2JS.compile(group.match.excludeRegex);
    } catch {
      error(`代理组「${group.name}」的过滤表达式无效`);
    }
    const members = groupMembers(workspace, group);
    if (
      !members.length &&
      !group.extra["include-all"] &&
      !group.extra["include-all-proxies"]
    )
      error(`代理组「${group.name}」为空`);
    if (
      group.match?.sourceId &&
      !workspace.sources.some((source) => source.id === group.match?.sourceId)
    )
      error(`代理组「${group.name}」的自动收纳来源不存在`);
    if (
      group.match?.sourceIds?.some(
        (id) => !workspace.sources.some((source) => source.id === id),
      )
    )
      error(`代理组「${group.name}」引用的节点提供者来源已被删除`);
    for (const ref of members)
      if (!ids.has(ref)) error(`代理组「${group.name}」引用了缺失节点或组`);
    edges.set(group.id, members);
  }
  for (const chain of workspace.chains) {
    if (chain.hops.length < 2) error(`链路「${chain.name}」至少需要两个节点`);
    if (new Set(chain.hops).size !== chain.hops.length)
      error(`链路「${chain.name}」重复经过同一节点`);
    for (const ref of chain.hops) {
      const node = workspace.nodes.find((node) => node.id === ref);
      if (!node)
        error(`链路「${chain.name}」包含缺失节点，链路各跳目前需选择具体节点`);
      if (
        node &&
        ["hysteria", "hysteria2", "tuic", "wireguard"].includes(node.raw.type)
      )
        warn(
          `链路「${chain.name}」使用 UDP 类协议，需确认前一跳支持承载其传输`,
        );
      if (node?.dialer)
        error(
          `链路「${chain.name}」包含已配置 dialer-proxy 的节点，请先明确其上游关系`,
        );
    }
    edges.set(chain.id, chain.hops);
  }
  const visited = new Set<string>();
  const path = new Set<string>();
  function visit(start: string) {
    const stack: { id: string; exiting: boolean }[] = [
      { id: start, exiting: false },
    ];
    while (stack.length) {
      const { id, exiting } = stack.pop()!;
      if (exiting) {
        path.delete(id);
        visited.add(id);
        continue;
      }
      if (path.has(id)) {
        error(`「${referenceName(workspace, id)}」存在循环引用`);
        continue;
      }
      if (visited.has(id)) continue;
      path.add(id);
      stack.push({ id, exiting: true });
      for (const next of edges.get(id) || [])
        stack.push({ id: next, exiting: false });
    }
  }
  for (const id of edges.keys()) visit(id);
  let matchSeen = false;
  for (const rule of workspace.rules.filter((rule) => rule.enabled)) {
    const parts = splitRule(rule.text);
    if (matchSeen) warn(`规则「${rule.text}」位于 MATCH 后，无法命中`);
    if (parts[0] === "MATCH") matchSeen = true;
    if (["GEOIP", "GEOSITE"].includes(parts[0]) && parts.length < 3)
      error(`规则「${rule.text}」缺少匹配条件或目标策略`);
    if (parts.length < 2) {
      error(`规则「${rule.text}」格式不完整`);
      continue;
    }
    if (!names.has(parts[ruleTargetIndex(parts)]) && parts[0] !== "SUB-RULE")
      error(`规则「${rule.text}」的目标策略不存在`);
    if (
      parts[0] === "RULE-SET" &&
      !workspace.base["rule-providers"]?.[parts[1]]
    )
      error(`规则集「${parts[1]}」未定义`);
  }
  if (!workspace.rules.some((rule) => rule.enabled))
    warn("没有启用的分流规则，Mihomo 将使用默认行为");
  if (!matchSeen) warn("没有 MATCH 兜底规则");
  if (workspace.base["sub-rules"])
    warn("包含高级子规则，请结合 Mihomo 校验和客户端运行结果确认引用");
  for (const source of workspace.sources)
    if (source.error)
      warn(`来源「${source.name}」刷新失败，当前使用保留的节点`);
  return issues.filter(
    (issue, index, all) =>
      all.findIndex(
        (item) => item.level === issue.level && item.message === issue.message,
      ) === index,
  );
}

export function compile(workspace: Workspace): Raw {
  const config = structuredClone(workspace.base);
  const names = new Map(
    [...workspace.nodes, ...workspace.groups, ...workspace.chains].map(
      (item) => [item.id, item.name],
    ),
  );
  const proxies: Raw[] = workspace.nodes.map((node) => ({
    ...node.raw,
    name: node.name,
    ...(node.dialer
      ? { "dialer-proxy": names.get(node.dialer) || node.dialer }
      : {}),
  }));
  const used = new Set(
    [...workspace.nodes, ...workspace.groups, ...workspace.chains].map(
      (item) => item.name,
    ),
  );
  for (const chain of workspace.chains) {
    let previous: string | undefined;
    chain.hops.forEach((ref, index) => {
      const node = workspace.nodes.find((node) => node.id === ref);
      if (!node) return;
      let name =
        index === chain.hops.length - 1
          ? chain.name
          : `__chain_${chain.id}_${index + 1}`;
      while (index !== chain.hops.length - 1 && used.has(name)) name += "_";
      used.add(name);
      const raw: Raw = { ...node.raw, name };
      delete raw["dialer-proxy"];
      if (previous) raw["dialer-proxy"] = previous;
      proxies.push(raw);
      previous = name;
    });
  }
  config.proxies = proxies;
  config["proxy-groups"] = workspace.groups.map((group) => ({
    ...group.extra,
    name: group.name,
    type: group.type,
    proxies: groupMembers(workspace, group).map((ref) => names.get(ref) || ref),
    ...(group.type === "select"
      ? {}
      : {
          url: group.extra.url || "https://www.gstatic.com/generate_204",
          interval: group.extra.interval || 300,
        }),
  }));
  config.rules = workspace.rules
    .filter((rule) => rule.enabled)
    .map((rule) => rule.text);
  return config;
}

export function compileYaml(workspace: Workspace) {
  return stringify(compile(workspace), { lineWidth: 0 });
}
