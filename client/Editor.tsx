import { useState, useMemo } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  useSortable,
  SortableContext,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Search,
  GripVertical,
  Plus,
  X,
  Settings2,
  Network,
  Link2,
  Globe2,
  Trash2,
  ArrowRight,
  SlidersHorizontal,
} from "lucide-react";
import {
  groupMembers,
  referenceName,
  groupTypes,
  renameReference,
  type Workspace,
  type ProxyNode,
  type ProxyGroup,
  type Chain,
} from "../shared/types";
import { Empty, Field, Modal } from "./ui";

export interface EditorProps {
  workspace: Workspace;
  update: (next: Workspace) => void;
}
export interface DragData {
  refs: string[];
  groupId?: string;
  chainId?: string;
  index?: number;
}

function NodeRow({
  node,
  selected,
  toggle,
  dragIds,
  edit,
}: {
  node: ProxyNode;
  selected: boolean;
  toggle: () => void;
  dragIds: string[];
  edit: () => void;
}) {
  const drag = useDraggable({
    id: `node:${node.id}`,
    data: { refs: selected ? dragIds : [node.id] } satisfies DragData,
  });
  return (
    <div
      ref={drag.setNodeRef}
      className={`node-row ${selected ? "selected" : ""} ${drag.isDragging ? "dragging" : ""}`}
    >
      <button
        className="drag-handle"
        aria-label={`拖动 ${node.name}`}
        {...drag.listeners}
        {...drag.attributes}
      >
        <GripVertical size={16} />
      </button>
      <input
        type="checkbox"
        checked={selected}
        onChange={toggle}
        aria-label={`选择 ${node.name}`}
      />
      <button className="node-name" onClick={edit}>
        <span>{node.name}</span>
        <small>
          {String(node.raw.type).toUpperCase()} · {node.raw.server}
        </small>
      </button>
    </div>
  );
}

export function NodeLibrary({
  workspace,
  selected,
  setSelected,
  editNode,
  importNodes,
}: {
  workspace: Workspace;
  selected: string[];
  setSelected: (ids: string[]) => void;
  editNode: (id: string) => void;
  importNodes: () => void;
}) {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("");
  const [protocol, setProtocol] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(
    () =>
      workspace.nodes.filter(
        (node) =>
          (!source || node.sourceId === source) &&
          (!protocol || node.raw.type === protocol) &&
          node.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [workspace.nodes, source, protocol, search],
  );
  const visible = filtered.slice(page * 80, (page + 1) * 80);
  return (
    <aside className="node-library">
      <div className="panel-heading">
        <div>
          <h2>
            节点库 <span>{workspace.nodes.length}</span>
          </h2>
          <p>选择节点，拖入右侧编排</p>
        </div>
        <button
          className="icon-button"
          onClick={importNodes}
          aria-label="导入节点"
        >
          <Plus size={19} />
        </button>
      </div>
      <div className="library-filters">
        <div className="search">
          <Search size={16} />
          <input
            value={search}
            placeholder="搜索节点名称"
            aria-label="搜索节点"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="filter-row">
          <select
            aria-label="按来源筛选"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPage(0);
            }}
          >
            <option value="">全部来源</option>
            {workspace.sources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <select
            aria-label="按协议筛选"
            value={protocol}
            onChange={(event) => {
              setProtocol(event.target.value);
              setPage(0);
            }}
          >
            <option value="">全部协议</option>
            {[...new Set(workspace.nodes.map((node) => node.raw.type))].map(
              (type) => (
                <option key={type}>{type}</option>
              ),
            )}
          </select>
        </div>
      </div>
      <div className="selection-line">
        <label>
          <input
            type="checkbox"
            checked={
              visible.length > 0 &&
              visible.every((node) => selected.includes(node.id))
            }
            onChange={(event) =>
              setSelected(
                event.target.checked
                  ? [
                      ...new Set([
                        ...selected,
                        ...visible.map((node) => node.id),
                      ]),
                    ]
                  : selected.filter(
                      (id) => !visible.some((node) => node.id === id),
                    ),
              )
            }
          />{" "}
          本页全选
        </label>
        <span>
          {selected.length
            ? `已选 ${selected.length} 项`
            : `${filtered.length} 个节点`}
        </span>
      </div>
      <div className="node-list">
        {visible.map((node) => (
          <NodeRow
            key={node.id}
            node={node}
            selected={selected.includes(node.id)}
            dragIds={selected}
            toggle={() =>
              setSelected(
                selected.includes(node.id)
                  ? selected.filter((id) => id !== node.id)
                  : [...selected, node.id],
              )
            }
            edit={() => editNode(node.id)}
          />
        ))}
        {!visible.length && (
          <Empty
            icon={<Globe2 />}
            title={workspace.nodes.length ? "没有匹配的节点" : "从你的订阅开始"}
          >
            <p>
              导入订阅链接或 YAML 文件，
              <br />
              所有节点会在这里汇集。
            </p>
            <button className="secondary" onClick={importNodes}>
              导入来源
            </button>
          </Empty>
        )}
      </div>
      {filtered.length > 80 && (
        <div className="pagination">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span>
            {page + 1} / {Math.ceil(filtered.length / 80)}
          </span>
          <button
            disabled={(page + 1) * 80 >= filtered.length}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
      <div className="library-foot">
        <GripVertical size={15} />
        <span>支持多选拖拽，也可在组内点击添加</span>
      </div>
    </aside>
  );
}

function SortableMember({
  id,
  data,
  name,
  children,
}: {
  id: string;
  data: DragData;
  name: string;
  children: React.ReactNode;
}) {
  const sortable = useSortable({ id, data });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`member ${sortable.isDragging ? "dragging" : ""}`}
    >
      <button
        className="drag-handle"
        {...sortable.attributes}
        {...sortable.listeners}
        aria-label={`调整 ${name} 顺序`}
      >
        <GripVertical size={16} />
      </button>
      {children}
    </div>
  );
}

function AddMember({
  workspace,
  existing,
  add,
  nodesOnly = false,
}: {
  workspace: Workspace;
  existing: string[];
  add: (ref: string) => void;
  nodesOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const options = !open
    ? []
    : [
        ...workspace.nodes,
        ...(nodesOnly
          ? []
          : [
              ...workspace.groups,
              ...workspace.chains,
              { id: "DIRECT", name: "DIRECT" },
              { id: "REJECT", name: "REJECT" },
            ]),
      ]
        .filter(
          (item) =>
            !existing.includes(item.id) &&
            item.name.toLowerCase().includes(search.toLowerCase()),
        )
        .slice(0, 80);
  return (
    <div className="member-picker">
      <button
        className="add-member"
        aria-expanded={open}
        aria-label={nodesOnly ? "添加链路节点" : "添加组成员"}
        onClick={() => setOpen(!open)}
      >
        ＋ {nodesOnly ? "添加一跳" : "添加节点或策略"}
      </button>
      {open && (
        <div className="member-picker-menu">
          <input
            autoFocus
            aria-label="搜索可添加的成员"
            placeholder="搜索名称"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div>
            {options.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  add(item.id);
                  setOpen(false);
                  setSearch("");
                }}
              >
                {item.name}
              </button>
            ))}
            {!options.length && <small>没有匹配的成员</small>}
            {options.length === 80 && <small>输入关键词查找更多成员</small>}
          </div>
        </div>
      )}
    </div>
  );
}

function GroupCard({
  group,
  workspace,
  update,
  configure,
}: EditorProps & { group: ProxyGroup; configure: () => void }) {
  const drop = useDroppable({
    id: `group:${group.id}`,
    data: { groupId: group.id },
  });
  const members = groupMembers(workspace, group);
  const [visibleLimit, setVisibleLimit] = useState(100);
  const visible = members.slice(0, visibleLimit);
  const ids = visible.map((ref) => `member:${group.id}:${ref}`);
  function remove(ref: string) {
    const next = structuredClone(workspace);
    const target = next.groups.find((item) => item.id === group.id)!;
    target.members = target.members.filter((item) => item !== ref);
    target.excluded = [...new Set([...target.excluded, ref])];
    update(next);
  }
  function add(ref: string) {
    const next = structuredClone(workspace);
    const target = next.groups.find((item) => item.id === group.id)!;
    target.members = [...new Set([...target.members, ref])];
    target.excluded = target.excluded.filter((item) => item !== ref);
    update(next);
  }
  return (
    <section
      ref={drop.setNodeRef}
      className={`group-card ${drop.isOver ? "drop-over" : ""}`}
    >
      <div className="group-heading">
        <div className="group-symbol">
          <Network size={19} />
        </div>
        <div>
          <h3>{group.name}</h3>
          <span>
            {
              {
                select: "手动选择",
                "url-test": "自动测速",
                fallback: "故障转移",
                "load-balance": "负载均衡",
              }[group.type]
            }{" "}
            · {members.length} 项
          </span>
        </div>
        <button
          className="icon-button"
          onClick={configure}
          aria-label={`设置 ${group.name}`}
        >
          <Settings2 size={17} />
        </button>
      </div>
      {group.match && (
        <div className="auto-label">
          <SlidersHorizontal size={13} />
          自动收纳 · {group.match.contains || "全部节点"}
        </div>
      )}
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="group-members">
          {visible.map((ref) => (
            <SortableMember
              key={ref}
              id={`member:${group.id}:${ref}`}
              name={referenceName(workspace, ref)}
              data={{ refs: [ref], groupId: group.id }}
            >
              <span className="member-name">
                {referenceName(workspace, ref)}
              </span>
              <button
                className="icon-button small"
                onClick={() => remove(ref)}
                aria-label={`从 ${group.name} 移除 ${referenceName(workspace, ref)}`}
              >
                <X size={14} />
              </button>
            </SortableMember>
          ))}
          {!members.length && (
            <div className="drop-hint">
              <Plus size={22} />
              <span>把节点拖到这里</span>
            </div>
          )}
          {visible.length < members.length && (
            <button
              className="text-button"
              onClick={() => setVisibleLimit(visibleLimit + 100)}
            >
              再显示 100 项 · 共 {members.length} 项
            </button>
          )}
        </div>
      </SortableContext>
      <div className="group-footer">
        <AddMember
          workspace={workspace}
          existing={[group.id, ...members]}
          add={add}
        />
      </div>
    </section>
  );
}

export function Groups({ workspace, update }: EditorProps) {
  const [editing, setEditing] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<ProxyGroup["type"]>("select");
  const [auto, setAuto] = useState(false);
  const [source, setSource] = useState("");
  const [contains, setContains] = useState("");
  const [regex, setRegex] = useState("");
  const [excludeRegex, setExcludeRegex] = useState("");
  function configure(group?: ProxyGroup) {
    setEditing(group?.id);
    setCreating(true);
    setName(group?.name || "");
    setType(group?.type || "select");
    setAuto(!!group?.match);
    setSource(
      group?.match?.sourceIds ? "__imported__" : group?.match?.sourceId || "",
    );
    setContains(group?.match?.contains || "");
    setRegex(group?.match?.regex || "");
    setExcludeRegex(group?.match?.excludeRegex || "");
  }
  function save(event: React.FormEvent) {
    event.preventDefault();
    let next = editing
      ? renameReference(workspace, editing, name)
      : structuredClone(workspace);
    const group = editing
      ? next.groups.find((group) => group.id === editing)!
      : {
          id: crypto.randomUUID(),
          name,
          type,
          members: [],
          excluded: [],
          extra: {},
        };
    group.type = type;
    group.match = auto
      ? {
          ...group.match,
          sourceId: source === "__imported__" ? "" : source,
          sourceIds:
            source === "__imported__" ? group.match?.sourceIds : undefined,
          contains,
          regex: regex || undefined,
          excludeRegex: excludeRegex || undefined,
        }
      : undefined;
    if (!editing) next.groups.push(group);
    update(next);
    setCreating(false);
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>代理组</h2>
          <p>按用途收纳节点，决定流量如何选择出口。</p>
        </div>
        <button className="secondary" onClick={() => configure()}>
          <Plus size={16} />
          新建代理组
        </button>
      </div>
      <div className="groups-grid">
        {workspace.groups.map((group) => (
          <GroupCard
            key={group.id}
            workspace={workspace}
            update={update}
            group={group}
            configure={() => configure(group)}
          />
        ))}
        <button className="new-group" onClick={() => configure()}>
          <Plus size={25} />
          <span>新建代理组</span>
        </button>
      </div>
      {creating && (
        <Modal
          title={editing ? "代理组设置" : "新建代理组"}
          close={() => setCreating(false)}
        >
          <form onSubmit={save}>
            <Field label="名称">
              <input
                required
                maxLength={120}
                pattern="[^,\r\n]+"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </Field>
            <Field label="选择方式">
              <select
                value={type}
                onChange={(event) =>
                  setType(event.target.value as ProxyGroup["type"])
                }
              >
                {groupTypes.map((type) => (
                  <option key={type} value={type}>
                    {
                      {
                        select: "手动选择",
                        "url-test": "自动测速",
                        fallback: "故障转移",
                        "load-balance": "负载均衡",
                      }[type]
                    }
                  </option>
                ))}
              </select>
            </Field>
            <label className="check-label">
              <input
                type="checkbox"
                checked={auto}
                onChange={(event) => setAuto(event.target.checked)}
              />
              自动收纳新节点
            </label>
            {auto && (
              <>
                <Field label="节点来源">
                  <select
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                  >
                    <option value="">所有来源</option>
                    {source === "__imported__" && (
                      <option value="__imported__">配置导入时关联的来源</option>
                    )}
                    {workspace.sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="名称包含"
                  hint="用 | 分隔多个关键词，例如 香港|HK；留空匹配所有节点"
                >
                  <input
                    value={contains}
                    onChange={(event) => setContains(event.target.value)}
                  />
                </Field>
                <details>
                  <summary>高级过滤 · 兼容 Mihomo 正则</summary>
                  <Field label="包含表达式">
                    <input
                      value={regex}
                      onChange={(event) => setRegex(event.target.value)}
                      placeholder="例如 (?i)香港|HK"
                    />
                  </Field>
                  <Field label="排除表达式">
                    <input
                      value={excludeRegex}
                      onChange={(event) => setExcludeRegex(event.target.value)}
                    />
                  </Field>
                </details>
                <p className="muted">
                  已手动添加的固定成员会保留。新节点按条件自动加入，自动成员可在组内移除。
                </p>
              </>
            )}
            {editing && (
              <p className="muted">
                删除会影响引用这个组的其他组和分流规则，发布检查会列出需要修复的位置。
              </p>
            )}
            <div className="modal-actions">
              {editing && (
                <button
                  type="button"
                  className="danger text-button"
                  onClick={() => {
                    update({
                      ...workspace,
                      groups: workspace.groups.filter(
                        (group) => group.id !== editing,
                      ),
                    });
                    setCreating(false);
                  }}
                >
                  <Trash2 size={16} />
                  删除代理组
                </button>
              )}
              <button className="primary">保存代理组</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ChainCard({
  workspace,
  update,
  chain,
}: EditorProps & { chain: Chain }) {
  const drop = useDroppable({
    id: `chain:${chain.id}`,
    data: { chainId: chain.id },
  });
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(chain.name);
  function setHops(hops: string[]) {
    update({
      ...workspace,
      chains: workspace.chains.map((item) =>
        item.id === chain.id ? { ...item, hops } : item,
      ),
    });
  }
  return (
    <section
      ref={drop.setNodeRef}
      className={`chain-card ${drop.isOver ? "drop-over" : ""}`}
    >
      <div className="chain-heading">
        <div className="group-symbol">
          <Link2 size={19} />
        </div>
        <div>
          <h3>{chain.name}</h3>
          <p>本机出发，按从左到右的顺序连接</p>
        </div>
        <button
          className="icon-button"
          aria-label={`编辑链路 ${chain.name}`}
          onClick={() => setEdit(true)}
        >
          <Settings2 size={17} />
        </button>
      </div>
      <div className="chain-path">
        <div className="endpoint">
          <Globe2 size={20} />
          <span>本机</span>
        </div>
        <ArrowRight size={19} className="path-arrow" />
        <SortableContext
          items={chain.hops.map(
            (ref, index) => `hop:${chain.id}:${index}:${ref}`,
          )}
          strategy={horizontalListSortingStrategy}
        >
          {chain.hops.map((ref, index) => (
            <div className="hop-wrapper" key={`${ref}:${index}`}>
              <SortableMember
                id={`hop:${chain.id}:${index}:${ref}`}
                name={referenceName(workspace, ref)}
                data={{ refs: [ref], chainId: chain.id, index }}
              >
                <div>
                  <small>
                    {index === chain.hops.length - 1 ? "出口节点" : "中转节点"}
                  </small>
                  <strong>{referenceName(workspace, ref)}</strong>
                </div>
                <button
                  className="icon-button small"
                  aria-label={`移除第 ${index + 1} 跳`}
                  onClick={() =>
                    setHops(chain.hops.filter((_, i) => i !== index))
                  }
                >
                  <X size={14} />
                </button>
              </SortableMember>
              <ArrowRight size={19} className="path-arrow" />
            </div>
          ))}
        </SortableContext>
        <div className="endpoint">
          <Globe2 size={20} />
          <span>目标网站</span>
        </div>
      </div>
      <div className="chain-bottom">
        <AddMember
          workspace={workspace}
          existing={chain.hops}
          nodesOnly
          add={(ref) => setHops([...chain.hops, ref])}
        />
        <small>{chain.hops.length} 跳 · 链路可加入任意代理组</small>
      </div>
      {edit && (
        <Modal title="链路设置" close={() => setEdit(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              update(renameReference(workspace, chain.id, name));
              setEdit(false);
            }}
          >
            <Field label="复合节点名称">
              <input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="modal-actions">
              <button
                type="button"
                className="danger text-button"
                onClick={() => {
                  update({
                    ...workspace,
                    chains: workspace.chains.filter(
                      (item) => item.id !== chain.id,
                    ),
                  });
                  setEdit(false);
                }}
              >
                删除链路
              </button>
              <button className="primary">保存</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function Chains({ workspace, update }: EditorProps) {
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>链式代理</h2>
          <p>将不同节点连成一条路线，最后一跳决定出口 IP。</p>
        </div>
        <button
          className="secondary"
          onClick={() =>
            update({
              ...workspace,
              chains: [
                ...workspace.chains,
                {
                  id: crypto.randomUUID(),
                  name: `新链路 ${workspace.chains.length + 1}`,
                  hops: [],
                },
              ],
            })
          }
        >
          <Plus size={16} />
          新建链路
        </button>
      </div>
      <div className="chain-list">
        {workspace.chains.map((chain) => (
          <ChainCard
            key={chain.id}
            workspace={workspace}
            update={update}
            chain={chain}
          />
        ))}
      </div>
      {!workspace.chains.length && (
        <Empty icon={<Link2 size={30} />} title="搭出你的第一条代理链">
          <p>
            先创建链路，再从节点库拖入至少两个节点。
            <br />
            每条链独立编译，保留节点的其他用途。
          </p>
        </Empty>
      )}
    </>
  );
}
