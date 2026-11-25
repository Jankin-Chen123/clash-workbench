import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { compile, validate } from "./compiler.js";
import {
  splitRule,
  ruleTargetIndex,
  type Workspace,
  type Issue,
} from "../shared/types.js";

const execute = promisify(execFile);
export const mihomoPath = resolve(
  process.env.MIHOMO_PATH ||
    (process.platform === "win32" ? "bin/mihomo.exe" : "bin/mihomo"),
);
export async function coreAvailable() {
  try {
    await access(mihomoPath);
    return true;
  } catch {
    return false;
  }
}

export async function check(
  workspace: Workspace,
): Promise<{ issues: Issue[]; coreChecked: boolean }> {
  const issues = validate(workspace);
  if (issues.some((issue) => issue.level === "error"))
    return { issues, coreChecked: false };
  if (!(await coreAvailable())) {
    issues.push({
      level: "error",
      message: "尚未安装 Mihomo 校验内核。请运行 npm run setup:mihomo 后发布",
    });
    return { issues, coreChecked: false };
  }
  const directory = await mkdtemp(join(tmpdir(), "clash-check-"));
  try {
    const config = compile(workspace);
    // Test mode must never read user-selected server files or download arbitrary resources.
    // Client-side resource loading is represented by deterministic inline fixtures for syntax checks.
    delete config["external-ui"];
    delete config["external-ui-url"];
    delete config["geox-url"];
    delete config["global-ua"];
    delete config["profile"];
    delete config["secret"];
    delete config["external-controller"];
    delete config["external-controller-tls"];
    delete config["external-controller-unix"];
    delete config["external-controller-pipe"];
    delete config["listeners"];
    delete config["tunnels"];
    delete config["authentication"];
    for (const proxy of config.proxies) {
      if (proxy["private-key-file"] || proxy["certificate"]) {
        issues.push({
          level: "error",
          message: `节点「${proxy.name}」使用本地证书或私钥文件，请改用内联内容后校验`,
        });
        return { issues, coreChecked: false };
      }
    }
    const providers = config["rule-providers"] || {};
    for (const [name, provider] of Object.entries(providers) as [
      string,
      any,
    ][]) {
      providers[name] = {
        type: "inline",
        behavior: provider.behavior || "classical",
        payload:
          provider.behavior === "ipcidr"
            ? ["192.0.2.0/24"]
            : provider.behavior === "domain"
              ? ["example.invalid"]
              : ["DOMAIN,example.invalid"],
      };
    }
    const rewriteRule = (rule: string) => {
      const parts = splitRule(rule);
      if (["GEOIP", "GEOSITE"].includes(parts[0]))
        return `DOMAIN,example.invalid,${parts[ruleTargetIndex(parts)]}`;
      return rule.replace(
        /\b(?:GEOIP|GEOSITE),[^,()]+(?:,no-resolve)?/g,
        "DOMAIN,example.invalid",
      );
    };
    config.rules = config.rules.map(rewriteRule);
    if (config["sub-rules"])
      for (const key of Object.keys(config["sub-rules"]))
        config["sub-rules"][key] = config["sub-rules"][key].map(rewriteRule);
    // File paths in DNS/TLS are not passed into the server-side core process.
    if (config.dns) {
      config.dns = {
        ...config.dns,
        "use-hosts": false,
        "use-system-hosts": false,
      };
      if (config.dns["fallback-filter"])
        config.dns["fallback-filter"] = {
          ...config.dns["fallback-filter"],
          geoip: false,
          geosite: [],
        };
      if (config.dns["nameserver-policy"])
        config.dns["nameserver-policy"] = Object.fromEntries(
          Object.entries(config.dns["nameserver-policy"]).map(
            ([domain, resolvers]) => [
              domain.startsWith("geosite:") ? "+.example.invalid" : domain,
              resolvers,
            ],
          ),
        );
      if (Array.isArray(config.dns["fake-ip-filter"]))
        config.dns["fake-ip-filter"] = config.dns["fake-ip-filter"].map(
          (domain: string) =>
            domain.startsWith("geosite:") ? "*.example.invalid" : domain,
        );
    }
    const filename = join(directory, "config.yaml");
    await writeFile(filename, stringify(config));
    try {
      await execute(mihomoPath, ["-t", "-d", directory, "-f", filename], {
        timeout: 20_000,
        maxBuffer: 512 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          USERPROFILE: directory,
        },
      });
    } catch {
      issues.push({
        level: "error",
        message:
          "Mihomo 未通过语法或协议参数校验，请检查节点参数及高级设置。内核日志可能包含凭据，已隐藏",
      });
      return { issues, coreChecked: false };
    }
    if (
      Object.keys(providers).length ||
      /GEOIP|GEOSITE/.test(workspace.rules.map((rule) => rule.text).join("\n"))
    )
      issues.push({
        level: "warning",
        message:
          "内核已检查配置结构。远程规则集与地理数据库需由客户端加载，当前校验使用内联占位数据",
      });
    return { issues, coreChecked: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
