import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeCountry, groupNodesByCountry } from "../client/countries.js";
import type { ProxyNode } from "../shared/types.js";

test("country detection handles flags, Chinese names, English names and region codes", () => {
  for (const [name, expected] of [
    ["香港 HK 01", "HK"],
    ["🇯🇵 JP Tokyo", "JP"],
    ["Japan 02", "JP"],
    ["HK01", "HK"],
    ["Hong Kong 2", "HK"],
    ["🇺🇸 美国 3", "US"],
    ["SG-01", "SG"],
    ["United Kingdom 1", "GB"],
    ["台灣 01", "TW"],
    ["🇨🇳 台湾专线", "TW"],
    ["🇵🇹 线路", "PT"],
    ["德国-法兰克福", "DE"],
    ["首尔 02", "KR"],
  ]) {
    assert.equal(nodeCountry({ name, originalName: name }), expected, name);
  }
});

test("custom names fall back to the original name and unknown nodes stay available", () => {
  assert.equal(
    nodeCountry({ name: "我的专线", originalName: "日本 01" }),
    "JP",
  );
  for (const name of [
    "自动选择",
    "套餐信息",
    "premium-server",
    "U S ",
    "🇿🇿 未知",
    "",
    "return-path",
  ])
    assert.equal(nodeCountry({ name, originalName: name }), "unknown", name);
});

test("the country grouping combines interleaved nodes and keeps unknown entries last", () => {
  const names = ["香港 01", "日本 01", "HK 02", "自定义", "🇯🇵 日本 02"];
  const nodes: ProxyNode[] = names.map((name, index) => ({
    id: String(index),
    name,
    originalName: name,
    sourceId: "fixture",
    raw: {},
  }));
  const groups = groupNodesByCountry(nodes);
  assert.equal(groups.find((group) => group.code === "HK")!.name, "香港");
  assert.deepEqual(
    groups.find((group) => group.code === "HK")!.nodes.map((node) => node.id),
    ["0", "2"],
  );
  assert.deepEqual(
    groups.find((group) => group.code === "JP")!.nodes.map((node) => node.id),
    ["1", "4"],
  );
  assert.equal(groups.at(-1)!.code, "unknown");
  assert.equal(groups.flatMap((group) => group.nodes).length, nodes.length);
  assert.deepEqual(
    nodes.map((node) => node.name),
    names,
  );
  assert.deepEqual(groupNodesByCountry([]), []);
});
