import { test } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { importWorkspace, nodesFromRaw } from "../server/importer.js";
import { compile, validate } from "../server/compiler.js";
import { check } from "../server/checker.js";
import {
  emptyWorkspace,
  renameReference,
  groupMembers,
  splitRule,
} from "../shared/types.js";
import { isPublicAddress, safeFetch } from "../server/network.js";
import { simulate } from "../server/simulator.js";
import { applyProposal } from "../server/ai.js";
import { convertSubscription } from "../server/substore.js";

const rawNodes = [
  { name: "香港入口", type: "socks5", server: "192.0.2.10", port: 1080 },
  { name: "日本出口", type: "socks5", server: "192.0.2.20", port: 1080 },
];
const fixture = () => ({
  ...emptyWorkspace(),
  nodes: nodesFromRaw(rawNodes, "source"),
  sources: [
    {
      id: "source",
      name: "本地",
      refreshedAt: new Date().toISOString(),
      warnings: [],
    },
  ],
});

test("full YAML import preserves DNS/TUN, expands inline providers, and round-trips group references", async () => {
  const original = {
    "mixed-port": 7890,
    dns: { enable: true, nameserver: ["1.1.1.1"] },
    tun: { enable: false, stack: "mixed" },
    proxies: rawNodes,
    "proxy-providers": {
      extra: {
        type: "inline",
        payload: [
          { name: "美国", type: "socks5", server: "192.0.2.30", port: 1080 },
        ],
      },
    },
    "proxy-groups": [
      { name: "选择", type: "select", proxies: ["香港入口"], use: ["extra"] },
    ],
    rules: ["MATCH,选择"],
  };
  const { workspace } = await importWorkspace({
    name: "完整配置",
    text: stringify(original),
  });
  const output = compile(workspace);
  assert.deepEqual(output.dns, original.dns);
  assert.deepEqual(output.tun, original.tun);
  assert.equal(workspace.nodes.length, 3);
  assert.deepEqual(output["proxy-groups"][0].proxies, ["香港入口", "美国"]);
  assert.equal(
    validate(workspace).filter((issue) => issue.level === "error").length,
    0,
  );
});

test("local provider import names the missing file and accepts supplied attachments", async () => {
  const text = stringify({
    "proxy-providers": {
      local: { type: "file", path: "./providers/nodes.yaml" },
    },
  });
  await assert.rejects(importWorkspace({ name: "本地", text }), /nodes.yaml/);
  const { workspace } = await importWorkspace({
    name: "本地",
    text,
    files: { "nodes.yaml": stringify({ proxies: rawNodes }) },
  });
  assert.equal(workspace.nodes.length, 2);
});

test("node identity ignores upstream renames and property order, retains duplicate aliases", () => {
  const first = nodesFromRaw([rawNodes[0]], "a")[0];
  const renamed = nodesFromRaw(
    [{ port: 1080, server: "192.0.2.10", type: "socks5", name: "新名称" }],
    "a",
  )[0];
  assert.equal(first.id, renamed.id);
  const duplicates = nodesFromRaw(
    [rawNodes[0], { ...rawNodes[0], name: "别名" }],
    "a",
  );
  assert.equal(duplicates.length, 2);
  assert.notEqual(duplicates[0].id, duplicates[1].id);
});

test("chain compilation clones each hop and leaves standalone nodes usable", async () => {
  const workspace = fixture();
  workspace.chains = [
    {
      id: "c",
      name: "日本固定出口",
      hops: workspace.nodes.map((node) => node.id),
    },
  ];
  workspace.groups = [
    {
      id: "g",
      name: "日常",
      type: "select",
      members: ["c", workspace.nodes[1].id],
      extra: {},
      excluded: [],
    },
  ];
  workspace.rules = [{ id: "r", text: "MATCH,日常", enabled: true }];
  const config = compile(workspace);
  assert.equal(config.proxies.length, 4);
  assert.equal(config.proxies[1]["dialer-proxy"], undefined);
  assert.equal(config.proxies[2]["dialer-proxy"], undefined);
  assert.equal(config.proxies[3].name, "日本固定出口");
  assert.equal(config.proxies[3]["dialer-proxy"], config.proxies[2].name);
  const result = await check(workspace);
  assert.deepEqual(
    result.issues.filter((issue) => issue.level === "error"),
    [],
  );
  assert.equal(result.coreChecked, true);
});

test("group and node cycles and missing chain members block publication", () => {
  const workspace = fixture();
  workspace.groups = [
    {
      id: "a",
      name: "A",
      type: "select",
      members: ["b"],
      excluded: [],
      extra: {},
    },
    {
      id: "b",
      name: "B",
      type: "select",
      members: ["a"],
      excluded: [],
      extra: {},
    },
  ];
  workspace.chains = [
    { id: "c", name: "缺失链", hops: [workspace.nodes[0].id, "missing"] },
  ];
  const issues = validate(workspace);
  assert.ok(issues.some((issue) => /循环/.test(issue.message)));
  assert.ok(issues.some((issue) => /缺失/.test(issue.message)));
});

test("automatic group membership includes new nodes and honours explicit exclusions", () => {
  const workspace = fixture();
  const group = {
    id: "g",
    name: "香港",
    type: "select" as const,
    members: [],
    match: { sourceId: "source", contains: "香港|HK" },
    extra: {},
    excluded: [] as string[],
  };
  assert.deepEqual(groupMembers(workspace, group), [workspace.nodes[0].id]);
  group.excluded.push(workspace.nodes[0].id);
  assert.deepEqual(groupMembers(workspace, group), []);
});

test("renaming updates rule targets including no-resolve and preserves logical commas", () => {
  const workspace = fixture();
  workspace.groups = [
    {
      id: "g",
      name: "旧名称",
      type: "select",
      members: ["DIRECT"],
      extra: {},
      excluded: [],
    },
  ];
  workspace.rules = [
    {
      id: "r",
      text: "AND,((DOMAIN,a.com),(NETWORK,TCP)),旧名称",
      enabled: true,
    },
    { id: "r2", text: "IP-CIDR,192.0.2.0/24,旧名称,no-resolve", enabled: true },
  ];
  const updated = renameReference(workspace, "g", "新名称");
  assert.equal(
    updated.rules[0].text,
    "AND,((DOMAIN,a.com),(NETWORK,TCP)),新名称",
  );
  assert.equal(updated.rules[1].text, "IP-CIDR,192.0.2.0/24,新名称,no-resolve");
  assert.equal(splitRule(updated.rules[0].text).length, 3);
});

test("simulation respects order and reports earlier unresolved runtime rules", async () => {
  const workspace = fixture();
  workspace.rules = [
    { id: "a", text: "PROCESS-NAME,chrome.exe,REJECT", enabled: true },
    { id: "b", text: "DOMAIN-SUFFIX,github.com,DIRECT", enabled: true },
    { id: "c", text: "MATCH,REJECT", enabled: true },
  ];
  const result = await simulate(workspace, "api.github.com");
  assert.equal(result.target, "DIRECT");
  assert.equal(result.index, 2);
  assert.equal(result.definitive, false);
  assert.ok(result.uncertain.length);
});

test("AI proposals reject unknown policies and can create groups before referring to them", () => {
  const workspace = fixture();
  assert.throws(
    () =>
      applyProposal(workspace, {
        summary: "",
        rules: ["MATCH,不存在"],
        groups: [],
      }),
    /不存在/,
  );
  const next = applyProposal(workspace, {
    summary: "",
    rules: ["MATCH,新增组"],
    groups: [{ name: "新增组", type: "select", members: ["香港入口"] }],
  });
  assert.equal(next.groups[0].members[0], workspace.nodes[0].id);
});

test("private, mapped, link-local and reserved addresses are blocked", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "0.0.0.0",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  await assert.rejects(safeFetch("http://127.0.0.1/"), /公共网络/);
  await assert.rejects(safeFetch("file:///etc/passwd"), /协议/);
});

test("reused Sub-Store parser imports URI and Base64 subscriptions", async () => {
  const uri = "ss://YWVzLTEyOC1nY206cGFzc3dvcmQ=@example.com:8388#Example";
  const text = await convertSubscription(Buffer.from(uri).toString("base64"));
  assert.match(text, /example.com/);
  const { workspace } = await importWorkspace({ name: "URI", text: uri });
  assert.equal(workspace.nodes[0].raw.type, "ss");
  assert.equal(workspace.nodes[0].raw.port, 8388);
});

test("imported provider filtering and prefixes preserve dynamic group behaviour", async () => {
  const { workspace } = await importWorkspace({
    name: "提供者",
    text: stringify({
      proxies: [
        { name: "本地 SOCKS", type: "socks5", server: "192.0.2.5", port: 1080 },
      ],
      "proxy-providers": {
        airport: {
          type: "inline",
          override: { "additional-prefix": "机场 · ", udp: false },
          payload: [
            ...rawNodes,
            {
              name: "HK US test",
              type: "socks5",
              server: "192.0.2.40",
              port: 1080,
            },
          ],
        },
      },
      "proxy-groups": [
        {
          name: "香港",
          type: "select",
          use: ["airport"],
          filter: "(?i)香港|hk",
          "exclude-filter": "test",
        },
        { name: "本地", type: "select", "include-all-proxies": true },
      ],
      rules: ["MATCH,香港"],
    }),
  });
  assert.deepEqual(compile(workspace)["proxy-groups"][0].proxies, [
    "机场 · 香港入口",
  ]);
  assert.deepEqual(compile(workspace)["proxy-groups"][1].proxies, [
    "本地 SOCKS",
  ]);
  const providerSource = workspace.sources.find((source) => source.provider)!;
  assert.equal(
    workspace.nodes.find((node) => node.sourceId === providerSource.id)!.raw
      .udp,
    false,
  );
  workspace.nodes.push(
    ...nodesFromRaw(
      [
        {
          name: "机场 · HK 新节点",
          type: "socks5",
          server: "192.0.2.50",
          port: 1080,
        },
      ],
      providerSource.id,
    ),
  );
  assert.equal(groupMembers(workspace, workspace.groups[0]).length, 2);
  assert.equal(
    validate(workspace).filter((issue) => issue.level === "error").length,
    0,
  );
});

test("a plain imported node subscription automatically collects later nodes", async () => {
  const { workspace } = await importWorkspace({
    name: "节点订阅",
    text: stringify({ proxies: rawNodes }),
  });
  assert.equal(workspace.groups[0].members.length, 0);
  workspace.nodes.push(
    ...nodesFromRaw(
      [{ name: "新增节点", type: "socks5", server: "192.0.2.80", port: 1080 }],
      workspace.sources[0].id,
    ),
  );
  assert.equal(groupMembers(workspace, workspace.groups[0]).length, 3);
  await assert.rejects(
    importWorkspace({ name: "无效", text: "proxies: bad-value" }),
    /YAML 列表/,
  );
});

test("large reference graphs are validated without recursive call-stack exhaustion", () => {
  const workspace = emptyWorkspace();
  workspace.nodes = Array.from({ length: 10000 }, (_, index) => ({
    id: `n${index}`,
    name: `节点${index}`,
    originalName: `节点${index}`,
    sourceId: "fixture",
    raw: { type: "socks5", server: "192.0.2.1", port: 1080 },
    dialer: index < 9999 ? `n${index + 1}` : undefined,
  }));
  workspace.rules = [{ id: "r", text: "MATCH,DIRECT", enabled: true }];
  assert.equal(
    validate(workspace).filter((issue) => issue.level === "error").length,
    0,
  );
  workspace.nodes[9999].dialer = "n0";
  assert.ok(
    validate(workspace).some((issue) => issue.message.includes("循环")),
  );
});

test("geodata placeholders do not bypass syntax errors in original rules or providers", () => {
  const workspace = fixture();
  workspace.rules = [{ id: "r", text: "GEOIP,DIRECT", enabled: true }];
  workspace.base["rule-providers"] = {
    bad: {
      type: "http",
      behavior: "classical",
      format: "mrs",
      url: "https://example.com/rules.mrs",
    },
  };
  const issues = validate(workspace);
  assert.ok(issues.some((issue) => issue.message.includes("缺少匹配")));
  assert.ok(issues.some((issue) => issue.message.includes("MRS")));
});

test("logical geosite rules and DNS policies pass offline core structure checks", async () => {
  const workspace = fixture();
  workspace.base.dns = {
    enable: true,
    nameserver: ["1.1.1.1"],
    fallback: ["8.8.8.8"],
    "fallback-filter": { geoip: true, "geoip-code": "CN", geosite: ["cn"] },
    "nameserver-policy": { "geosite:cn": ["1.1.1.1"] },
    "fake-ip-filter": ["geosite:cn"],
  };
  workspace.rules = [
    {
      id: "logic",
      text: "AND,((GEOSITE,cn),(NETWORK,TCP)),DIRECT",
      enabled: true,
    },
    { id: "fallback", text: "MATCH,DIRECT", enabled: true },
  ];
  const result = await check(workspace);
  assert.equal(result.coreChecked, true, JSON.stringify(result.issues));
  assert.ok(result.issues.some((issue) => issue.message.includes("占位")));
});
