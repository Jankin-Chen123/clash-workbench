import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Plus,
  Trash2,
  Route,
  FlaskConical,
  LayoutTemplate,
  Sparkles,
} from "lucide-react";
import { type Rule } from "../shared/types";
import { type EditorProps } from "./Editor";
import { Field, Modal, Empty } from "./ui";
import { api } from "./api";

function RuleRow({
  rule,
  index,
  change,
  remove,
}: {
  rule: Rule;
  index: number;
  change: (rule: Rule) => void;
  remove: () => void;
}) {
  const sortable = useSortable({ id: rule.id });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`rule-row ${!rule.enabled ? "disabled-rule" : ""}`}
    >
      <button
        className="drag-handle"
        {...sortable.listeners}
        {...sortable.attributes}
        aria-label={`调整第 ${index + 1} 条规则顺序`}
      >
        <GripVertical size={16} />
      </button>
      <span className="rule-number">{index + 1}</span>
      <input
        type="checkbox"
        checked={rule.enabled}
        onChange={(event) => change({ ...rule, enabled: event.target.checked })}
        aria-label={`启用第 ${index + 1} 条规则`}
      />
      <input
        className="rule-input"
        aria-label={`第 ${index + 1} 条规则`}
        value={rule.text}
        onChange={(event) => change({ ...rule, text: event.target.value })}
      />
      <button
        className="icon-button"
        onClick={remove}
        aria-label={`删除第 ${index + 1} 条规则`}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

export function Rules({
  workspace,
  update,
  projectId,
  save,
  run,
  openAI,
}: EditorProps & {
  projectId: string;
  save: () => Promise<any>;
  run: (fn: () => Promise<void>) => void;
  openAI: () => void;
}) {
  const [template, setTemplate] = useState(false);
  const [provider, setProvider] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [target, setTarget] = useState(workspace.groups[0]?.name || "DIRECT");
  const [providerName, setProviderName] = useState("");
  const [url, setUrl] = useState("");
  const [behavior, setBehavior] = useState("classical");
  const [format, setFormat] = useState("yaml");
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<any>();
  const [page, setPage] = useState(0);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const options = [
    "DIRECT",
    "REJECT",
    ...workspace.groups.map((group) => group.name),
    ...workspace.chains.map((chain) => chain.name),
    ...workspace.nodes.map((node) => node.name),
  ];
  const visible = workspace.rules.slice(page * 100, (page + 1) * 100);
  function addRules(texts: string[], replace = false) {
    const rules = texts
      .filter((text) => text.trim() && !text.trim().startsWith("#"))
      .map((text) => ({
        id: crypto.randomUUID(),
        text: text.trim(),
        enabled: true,
      }));
    update({
      ...workspace,
      rules: replace ? rules : [...rules, ...workspace.rules],
    });
    setPage(0);
  }
  return (
    <div className="rules-view">
      <div className="section-heading">
        <div>
          <h2>
            分流规则 <span className="count">{workspace.rules.length}</span>
          </h2>
          <p>自上而下匹配，首条命中的规则决定流量去向。</p>
        </div>
        <button className="secondary" onClick={openAI}>
          <Sparkles size={16} />用 AI 编辑
        </button>
      </div>
      <div className="rules-toolbar">
        <button
          className="secondary"
          onClick={() => {
            setBulkText("");
            setBulk(true);
          }}
        >
          <Plus size={16} />
          添加规则
        </button>
        <button className="secondary" onClick={() => setTemplate(true)}>
          <LayoutTemplate size={16} />
          使用模板
        </button>
        <button className="secondary" onClick={() => setProvider(true)}>
          接入规则集
        </button>
      </div>
      <div className="rule-table">
        <div className="table-head">
          <span>顺序 / 启用</span>
          <span>匹配条件与目标策略</span>
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={({ active, over }) => {
            if (!over || active.id === over.id) return;
            const from = workspace.rules.findIndex(
              (rule) => rule.id === active.id,
            );
            const to = workspace.rules.findIndex((rule) => rule.id === over.id);
            update({
              ...workspace,
              rules: arrayMove(workspace.rules, from, to),
            });
          }}
        >
          <SortableContext
            items={visible.map((rule) => rule.id)}
            strategy={verticalListSortingStrategy}
          >
            {visible.map((rule, index) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                index={page * 100 + index}
                change={(changed) =>
                  update({
                    ...workspace,
                    rules: workspace.rules.map((item) =>
                      item.id === rule.id ? changed : item,
                    ),
                  })
                }
                remove={() =>
                  update({
                    ...workspace,
                    rules: workspace.rules.filter(
                      (item) => item.id !== rule.id,
                    ),
                  })
                }
              />
            ))}
          </SortableContext>
        </DndContext>
        {!workspace.rules.length && (
          <Empty icon={<Route />} title="给流量安排去向">
            <p>从模板开始，或让 AI 根据你的使用习惯编写规则。</p>
          </Empty>
        )}
        {workspace.rules.length > 100 && (
          <div className="pagination">
            <button disabled={!page} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span>
              {page + 1} / {Math.ceil(workspace.rules.length / 100)}
            </span>
            <button
              disabled={(page + 1) * 100 >= workspace.rules.length}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </div>
      <div className="simulation">
        <div>
          <FlaskConical size={20} />
          <h3>规则试算</h3>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await save();
              setTestResult(
                await api(`/projects/${projectId}/simulate`, "POST", {
                  input: testInput,
                }),
              );
            });
          }}
        >
          <input
            required
            aria-label="试算域名或 IP"
            placeholder="输入域名或 IP，例如 github.com"
            value={testInput}
            onChange={(event) => setTestInput(event.target.value)}
          />
          <button className="secondary">查看去向</button>
        </form>
        {testResult && (
          <div className="simulation-result">
            <strong>
              {testResult.target
                ? `${testResult.definitive ? "命中" : "已知条件下命中"} ${testResult.target}`
                : "没有找到可确定的匹配"}
            </strong>
            {testResult.rule && (
              <code>
                第 {testResult.index} 条 · {testResult.rule}
              </code>
            )}
            {testResult.uncertain.map((line: string) => (
              <small key={line}>{line}</small>
            ))}
          </div>
        )}
      </div>
      {!!Object.keys(workspace.base["rule-providers"] || {}).length && (
        <div className="providers-list">
          <h3>已接入规则集</h3>
          {Object.entries(workspace.base["rule-providers"]).map(
            ([name, value]: [string, any]) => (
              <div key={name}>
                <span>
                  {name}
                  <small>
                    {value.behavior} · {value.format || "yaml"}
                  </small>
                </span>
                <button
                  className="icon-button"
                  aria-label={`删除规则集 ${name}`}
                  onClick={() => {
                    const next = structuredClone(workspace);
                    delete next.base["rule-providers"][name];
                    update(next);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ),
          )}
        </div>
      )}
      {bulk && (
        <Modal title="添加规则" close={() => setBulk(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              addRules(bulkText.split("\n"));
              setBulk(false);
            }}
          >
            <Field
              label="每行一条 Mihomo 规则"
              hint="添加到规则列表顶部，可拖动调整顺序"
            >
              <textarea
                className="code-input"
                rows={9}
                required
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
                placeholder={
                  "DOMAIN-SUFFIX,github.com,开发组\nDOMAIN-SUFFIX,example.com,DIRECT"
                }
              />
            </Field>
            <button className="primary">添加到草稿</button>
          </form>
        </Modal>
      )}
      {template && (
        <Modal title="使用分流模板" close={() => setTemplate(false)}>
          <p className="muted">
            模板会替换当前规则。规则集来自 Loyalsoldier/clash-rules，采用
            GPL-3.0 许可，客户端定期更新。
          </p>
          <Field label="其他流量走哪个策略">
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {options.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </Field>
          <div className="template-card">
            <h3>国内直连，其余代理</h3>
            <p>私有地址和国内域名直连，其他流量使用你选择的策略。</p>
            <a
              href="https://github.com/Loyalsoldier/clash-rules"
              target="_blank"
              rel="noreferrer"
            >
              查看规则集来源
            </a>
          </div>
          <button
            className="primary"
            onClick={() => {
              const next = structuredClone(workspace);
              next.base["rule-providers"] = {
                ...next.base["rule-providers"],
                private: {
                  type: "http",
                  behavior: "domain",
                  url: "https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/private.txt",
                  path: "./ruleset/private.yaml",
                  interval: 86400,
                },
                direct: {
                  type: "http",
                  behavior: "domain",
                  url: "https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/direct.txt",
                  path: "./ruleset/direct.yaml",
                  interval: 86400,
                },
              };
              next.rules = [
                "RULE-SET,private,DIRECT",
                "RULE-SET,direct,DIRECT",
                "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
                "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
                "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
                `MATCH,${target}`,
              ].map((text) => ({
                id: crypto.randomUUID(),
                text,
                enabled: true,
              }));
              update(next);
              setTemplate(false);
            }}
          >
            应用模板到草稿
          </button>
        </Modal>
      )}
      {provider && (
        <Modal title="接入外部规则集" close={() => setProvider(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const next = structuredClone(workspace);
              next.base["rule-providers"] = {
                ...next.base["rule-providers"],
                [providerName]: {
                  type: "http",
                  behavior,
                  format,
                  url,
                  path: `./ruleset/${providerName}.${format}`,
                  interval: 86400,
                },
              };
              next.rules.unshift({
                id: crypto.randomUUID(),
                text: `RULE-SET,${providerName},${target}`,
                enabled: true,
              });
              update(next);
              setProvider(false);
            }}
          >
            <Field label="规则集名称">
              <input
                required
                pattern="[A-Za-z0-9_-]+"
                value={providerName}
                onChange={(event) => setProviderName(event.target.value)}
                placeholder="github"
              />
            </Field>
            <Field label="规则集 URL">
              <input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://…"
              />
            </Field>
            <div className="form-grid">
              <Field label="内容类型">
                <select
                  value={behavior}
                  onChange={(event) => setBehavior(event.target.value)}
                >
                  <option value="classical">classical</option>
                  <option value="domain">domain</option>
                  <option value="ipcidr">ipcidr</option>
                </select>
              </Field>
              <Field label="文件格式">
                <select
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                >
                  <option value="yaml">YAML</option>
                  <option value="text">文本</option>
                  <option value="mrs">MRS</option>
                </select>
              </Field>
            </div>
            <Field label="命中后使用的策略">
              <select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                {options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </Field>
            <button className="primary">接入并添加规则</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
