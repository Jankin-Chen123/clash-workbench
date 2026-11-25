import { RE2JS } from "re2js";

export type Raw = Record<string, any>;
export type Ref = string;

export interface ProxyNode {
  id: string;
  sourceId: string;
  name: string;
  originalName: string;
  raw: Raw;
  dialer?: Ref;
}

export interface Source {
  id: string;
  name: string;
  url?: string;
  provider?: string;
  override?: Raw;
  filter?: { include?: string; exclude?: string; types?: string[] };
  headers?: Record<string, string>;
  refreshedAt: string;
  error?: string;
  warnings: string[];
}

export interface ProxyGroup {
  id: string;
  name: string;
  type: "select" | "url-test" | "fallback" | "load-balance";
  members: Ref[];
  match?: {
    sourceId: string;
    contains: string;
    sourceIds?: string[];
    regex?: string;
    excludeRegex?: string;
    excludeTypes?: string[];
  };
  excluded: Ref[];
  extra: Raw;
}

export interface Chain {
  id: string;
  name: string;
  hops: Ref[];
}

export interface Rule {
  id: string;
  text: string;
  enabled: boolean;
}

export interface Workspace {
  name: string;
  base: Raw;
  nodes: ProxyNode[];
  sources: Source[];
  groups: ProxyGroup[];
  chains: Chain[];
  rules: Rule[];
}

export interface Issue {
  level: "error" | "warning";
  message: string;
}

export interface Project {
  id: string;
  revision: number;
  draft: Workspace;
  publishedAt?: string;
  publishError?: string;
  subscriptionUrl?: string;
}

export interface AIProposal {
  summary: string;
  rules: string[];
  groups: { name: string; type: ProxyGroup["type"]; members: string[] }[];
}

export const builtinRefs = [
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
];
export const groupTypes = [
  "select",
  "url-test",
  "fallback",
  "load-balance",
] as const;

export function emptyWorkspace(name = "我的订阅"): Workspace {
  return {
    name,
    base: {
      "mixed-port": 7890,
      "allow-lan": false,
      mode: "rule",
      "log-level": "info",
      dns: {
        enable: true,
        nameserver: [
          "https://dns.alidns.com/dns-query",
          "https://cloudflare-dns.com/dns-query",
        ],
      },
    },
    nodes: [],
    sources: [],
    groups: [],
    chains: [],
    rules: [],
  };
}

export function referenceName(workspace: Workspace, ref: Ref): string {
  return (
    [...workspace.nodes, ...workspace.groups, ...workspace.chains].find(
      (item) => item.id === ref,
    )?.name ?? ref
  );
}

export function groupMembers(workspace: Workspace, group: ProxyGroup): Ref[] {
  let include: RE2JS | undefined;
  let exclude: RE2JS | undefined;
  try {
    if (group.match?.regex) include = RE2JS.compile(group.match.regex);
    if (group.match?.excludeRegex)
      exclude = RE2JS.compile(group.match.excludeRegex);
  } catch {
    return group.members;
  }
  const matches = group.match
    ? workspace.nodes
        .filter(
          (node) =>
            (!group.match!.sourceId ||
              node.sourceId === group.match!.sourceId) &&
            (!group.match!.sourceIds ||
              group.match!.sourceIds.includes(node.sourceId)) &&
            group
              .match!.contains.split("|")
              .some((term) =>
                node.originalName
                  .toLowerCase()
                  .includes(term.toLowerCase().trim()),
              ) &&
            (!include || include.test(node.originalName)) &&
            (!exclude || !exclude.test(node.originalName)) &&
            !group.match!.excludeTypes?.includes(node.raw.type),
        )
        .map((node) => node.id)
    : [];
  return [...new Set([...group.members, ...matches])].filter(
    (ref) => !group.excluded.includes(ref),
  );
}

export function splitRule(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++;
    if (text[index] === ")") depth--;
    if (text[index] === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

export function ruleTargetIndex(parts: string[]): number {
  return parts.at(-1)?.toLowerCase() === "no-resolve"
    ? parts.length - 2
    : parts.length - 1;
}

export function renameReference(
  workspace: Workspace,
  ref: string,
  name: string,
): Workspace {
  const result = structuredClone(workspace);
  const item = [...result.nodes, ...result.groups, ...result.chains].find(
    (item) => item.id === ref,
  );
  if (!item) return result;
  const previous = item.name;
  item.name = name;
  for (const rule of result.rules) {
    const parts = splitRule(rule.text);
    if (parts[ruleTargetIndex(parts)] === previous)
      parts[ruleTargetIndex(parts)] = name;
    rule.text = parts.join(",");
  }
  return result;
}
