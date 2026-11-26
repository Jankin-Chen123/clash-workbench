import type { ProxyNode } from "../shared/types";

const countryCodes =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  );
const countries = new Set(countryCodes);
const chineseNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const traditionalNames = new Intl.DisplayNames(["zh-TW"], { type: "region" });
const englishNames = new Intl.DisplayNames(["en"], { type: "region" });
const aliases = new Map<string, string>();
const normalise = (name: string) => name.normalize("NFKC").toLowerCase();

for (const code of countries) {
  for (const name of [
    code,
    chineseNames.of(code),
    traditionalNames.of(code),
    englishNames.of(code),
  ]) {
    if (name) aliases.set(normalise(name), code);
  }
}

const commonAliases: Record<string, string[]> = {
  HK: ["香港", "Hong Kong", "HKG"],
  TW: ["台湾", "台灣", "臺灣", "Taiwan", "TWN", "台北", "臺北"],
  MO: ["澳门", "澳門", "Macau", "Macao"],
  CN: ["中国", "中國", "China", "大陆", "大陸", "北京", "上海", "广州", "深圳"],
  JP: ["日本", "Japan", "JPN", "东京", "東京", "大阪", "Tokyo", "Osaka"],
  SG: ["新加坡", "狮城", "獅城", "Singapore", "SGP"],
  US: [
    "美国",
    "美國",
    "USA",
    "United States",
    "U.S.",
    "洛杉矶",
    "洛杉磯",
    "纽约",
    "紐約",
    "西雅图",
    "圣何塞",
    "Los Angeles",
    "New York",
    "Seattle",
    "San Jose",
    "LAX",
  ],
  GB: ["英国", "英國", "UK", "Britain", "England", "伦敦", "倫敦", "London"],
  KR: ["韩国", "韓國", "South Korea", "Korea", "KOR", "首尔", "首爾", "Seoul"],
  KP: ["朝鲜", "朝鮮", "North Korea"],
  DE: ["德国", "德國", "Germany", "法兰克福", "法蘭克福", "Frankfurt"],
  FR: ["法国", "法國", "France", "巴黎", "Paris"],
  NL: ["荷兰", "荷蘭", "Netherlands", "Holland", "阿姆斯特丹", "Amsterdam"],
  RU: ["俄罗斯", "俄羅斯", "Russia", "莫斯科", "Moscow"],
  AU: ["澳大利亚", "澳大利亞", "澳洲", "Australia", "悉尼", "Sydney"],
  CA: [
    "加拿大",
    "Canada",
    "多伦多",
    "多倫多",
    "温哥华",
    "溫哥華",
    "Toronto",
    "Vancouver",
  ],
  TR: ["土耳其", "Turkey", "Türkiye"],
  VN: ["越南", "Viet Nam", "Vietnam"],
  AE: ["阿联酋", "阿聯酋", "UAE", "迪拜", "杜拜", "Dubai"],
  ZA: ["南非", "South Africa"],
  IN: ["印度", "India"],
  ID: ["印尼", "Indonesia"],
  MY: ["马来西亚", "馬來西亞", "Malaysia"],
  TH: ["泰国", "泰國", "Thailand", "曼谷", "Bangkok"],
  PH: ["菲律宾", "菲律賓", "Philippines"],
  NZ: ["新西兰", "紐西蘭", "New Zealand"],
  CH: ["瑞士", "Switzerland"],
  CZ: ["捷克", "Czech Republic", "Czechia"],
};
for (const [code, names] of Object.entries(commonAliases))
  for (const name of names) aliases.set(normalise(name), code);

const escapePattern = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namePattern = new RegExp(
  `(?<![a-z])(${[...aliases.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapePattern)
    .join("|")})(?![a-z])`,
  "u",
);
const flagPattern = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
const regionalIndicatorA = 0x1f1e6;

export function nodeCountry(
  node: Pick<ProxyNode, "name" | "originalName">,
): string {
  for (const name of [node.name, node.originalName]) {
    const flag = name.match(flagPattern)?.[0];
    const flagCode = flag
      ? [...flag]
          .map((letter) =>
            String.fromCharCode(
              letter.codePointAt(0)! - regionalIndicatorA + 65,
            ),
          )
          .join("")
      : undefined;
    const textCode = aliases.get(normalise(name).match(namePattern)?.[1] || "");
    // CN flags are also commonly used for explicitly named HK/TW/MO locations.
    if (flagCode && countries.has(flagCode))
      return flagCode === "CN" && ["HK", "TW", "MO"].includes(textCode || "")
        ? textCode!
        : flagCode;
    if (textCode) return textCode;
  }
  return "unknown";
}

export interface CountryNodes {
  code: string;
  name: string;
  nodes: ProxyNode[];
}

export function groupNodesByCountry(nodes: ProxyNode[]): CountryNodes[] {
  const groups = new Map<string, CountryNodes>();
  for (const node of nodes) {
    const code = nodeCountry(node);
    let group = groups.get(code);
    if (!group) {
      group = {
        code,
        name:
          code === "unknown"
            ? "未识别"
            : commonAliases[code]?.[0] || chineseNames.of(code)!,
        nodes: [],
      };
      groups.set(code, group);
    }
    group.nodes.push(node);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.code === "unknown") return 1;
    if (b.code === "unknown") return -1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}
