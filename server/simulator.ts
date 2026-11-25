import ipaddr from "ipaddr.js";
import { parseYaml } from "./importer.js";
import { safeFetch } from "./network.js";
import { splitRule, ruleTargetIndex, type Workspace } from "../shared/types.js";

type Match = "yes" | "no" | "unknown";
function matches(type: string, value: string, input: string): Match {
  const domain = input.toLowerCase().replace(/\.$/, "");
  const expected = value.toLowerCase();
  if (type === "MATCH") return "yes";
  if (type === "DOMAIN") return domain === expected ? "yes" : "no";
  if (type === "DOMAIN-SUFFIX")
    return domain === expected || domain.endsWith(`.${expected}`)
      ? "yes"
      : "no";
  if (type === "DOMAIN-KEYWORD")
    return domain.includes(expected) ? "yes" : "no";
  if (["IP-CIDR", "IP-CIDR6"].includes(type)) {
    if (!ipaddr.isValid(input)) return "unknown";
    try {
      const address = ipaddr.process(input);
      const [network, bits] = ipaddr.parseCIDR(value);
      return address.kind() === network.kind() && address.match(network, bits)
        ? "yes"
        : "no";
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

export async function simulate(workspace: Workspace, input: string) {
  const uncertain: string[] = [];
  for (const [index, rule] of workspace.rules.entries()) {
    if (!rule.enabled) continue;
    const parts = splitRule(rule.text);
    let match: Match = matches(parts[0], parts[1], input);
    if (parts[0] === "RULE-SET") {
      const provider = workspace.base["rule-providers"]?.[parts[1]];
      try {
        if (!provider || provider.format === "mrs") throw new Error();
        let payload = provider.payload;
        if (provider.url) {
          const text = await safeFetch(provider.url);
          payload =
            provider.format === "text"
              ? text.split("\n")
              : parseYaml(text).payload;
        }
        if (!Array.isArray(payload)) throw new Error();
        match = "no";
        for (const item of payload) {
          const text = String(item).trim();
          if (!text || text.startsWith("#")) continue;
          let itemMatch: Match;
          if (provider.behavior === "domain") {
            const suffix = text.replace(/^\+\./, "").replace(/^\*\./, "");
            itemMatch = matches("DOMAIN-SUFFIX", suffix, input);
          } else if (provider.behavior === "ipcidr")
            itemMatch = matches("IP-CIDR", text, input);
          else {
            const p = splitRule(text);
            itemMatch = matches(p[0], p[1], input);
          }
          if (itemMatch === "yes") {
            match = "yes";
            break;
          }
          if (itemMatch === "unknown") match = "unknown";
        }
      } catch {
        match = "unknown";
      }
    }
    if (match === "unknown")
      uncertain.push(
        `第 ${index + 1} 条 ${parts[0]} 需要运行时信息或暂不可读取的规则集`,
      );
    if (match === "yes")
      return {
        index: index + 1,
        rule: rule.text,
        target: parts[ruleTargetIndex(parts)],
        uncertain,
        definitive: uncertain.length === 0,
      };
  }
  return { target: null, uncertain, definitive: uncertain.length === 0 };
}
