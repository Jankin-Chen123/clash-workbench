import { useEffect, useState, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  Layers3,
  Network,
  Link2,
  Route,
  Upload,
  Sparkles,
  Settings2,
  LogOut,
  Plus,
  Undo2,
  Save,
  Check,
  X,
  CloudUpload,
  ChevronRight,
  FileCode2,
  LoaderCircle,
} from "lucide-react";
import { parseDocument, stringify } from "yaml";
import {
  type Workspace,
  type Project,
  groupMembers,
  renameReference,
  referenceName,
} from "../shared/types";
import { api, ApiError } from "./api";
import { Auth, type User } from "./Auth";
import { Modal, Loading, Field } from "./ui";
import { NodeLibrary, Groups, Chains, type DragData } from "./Editor";
import { Rules } from "./Rules";
import { Sources, ImportModal, Advanced } from "./Sources";
import { AIEditor, Settings } from "./AI";
import { Publish } from "./Publish";

const tabs = [
  { id: "groups", label: "代理组", icon: Network },
  { id: "chains", label: "链式代理", icon: Link2 },
  { id: "rules", label: "分流规则", icon: Route },
  { id: "ai", label: "AI 助手", icon: Sparkles },
  { id: "sources", label: "订阅来源", icon: Upload },
  { id: "advanced", label: "高级配置", icon: FileCode2 },
  { id: "publish", label: "发布订阅", icon: CloudUpload },
];

export default function App() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User>();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project>();
  const projectRef = useRef<Project | undefined>(undefined);
  projectRef.current = project;
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [history, setHistory] = useState<Workspace[]>([]);
  const [tab, setTab] = useState("groups");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [move, setMove] = useState(false);
  const [drag, setDrag] = useState<DragData>();
  const [nodeId, setNodeId] = useState<string>();
  const [nodeText, setNodeText] = useState("");
  const [nodeError, setNodeError] = useState("");
  const lock = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function sync(next: Project) {
    setProject(next);
    projectRef.current = next;
    setProjects((current) =>
      current.some((p) => p.id === next.id)
        ? current.map((p) => (p.id === next.id ? next : p))
        : [...current, next],
    );
    setDirty(false);
    dirtyRef.current = false;
    setHistory([]);
  }
  function update(workspace: Workspace) {
    if (!projectRef.current) return;
    setHistory((current) => [
      ...current.slice(-39),
      structuredClone(projectRef.current!.draft),
    ]);
    const next = { ...projectRef.current, draft: workspace };
    projectRef.current = next;
    setProject(next);
    setDirty(true);
    dirtyRef.current = true;
    setNotice("");
  }
  async function save(): Promise<Project> {
    const current = projectRef.current!;
    if (!dirtyRef.current) return current;
    const next = await api<Project>(`/projects/${current.id}`, "PUT", {
      workspace: current.draft,
      revision: current.revision,
    });
    sync(next);
    return next;
  }
  function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    void fn()
      .catch((error) => setError((error as Error).message))
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  }
  async function loadProjects() {
    const list = await api<Project[]>("/projects");
    setProjects(list);
    if (list[0]) sync(list[0]);
  }
  useEffect(() => {
    void (async () => {
      try {
        const me = await api<User>("/me");
        setUser(me);
        await loadProjects();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          setError((error as Error).message);
          setLoading(false);
          return;
        }
        try {
          setNeedsSetup((await api("/auth/status")).needsSetup);
        } catch {
          setError("无法连接工作台服务，请检查后端是否启动");
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (dirtyRef.current) event.preventDefault();
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  function onDragEnd({ active, over }: DragEndEvent) {
    setDrag(undefined);
    if (!over || !project) return;
    const data = active.data.current as DragData;
    const target = over.data.current as Partial<DragData>;
    const next = structuredClone(project.draft);
    const targetGroup =
      target?.groupId ||
      (String(over.id).startsWith("group:")
        ? String(over.id).slice(6)
        : undefined);
    const targetChain =
      target?.chainId ||
      (String(over.id).startsWith("chain:")
        ? String(over.id).slice(6)
        : undefined);
    if (targetChain) {
      const chain = next.chains.find((chain) => chain.id === targetChain)!;
      if (
        data.chainId === targetChain &&
        target.index !== undefined &&
        data.index !== undefined
      )
        chain.hops = arrayMove(chain.hops, data.index, target.index);
      else
        chain.hops = [
          ...chain.hops,
          ...data.refs.filter(
            (ref) =>
              next.nodes.some((node) => node.id === ref) &&
              !chain.hops.includes(ref),
          ),
        ];
      update(next);
      return;
    }
    if (!targetGroup) return;
    const group = next.groups.find((group) => group.id === targetGroup)!;
    const currentMembers = groupMembers(next, group);
    if (data.groupId === targetGroup) {
      const from = currentMembers.indexOf(data.refs[0]);
      const to = currentMembers.indexOf(target.refs?.[0] || "");
      if (from >= 0 && to >= 0)
        group.members = arrayMove(currentMembers, from, to);
    } else {
      group.members = [
        ...new Set([
          ...group.members,
          ...data.refs.filter((ref) => ref !== group.id),
        ]),
      ];
      group.excluded = group.excluded.filter((ref) => !data.refs.includes(ref));
      if (move && data.groupId) {
        const source = next.groups.find((group) => group.id === data.groupId)!;
        source.members = source.members.filter(
          (ref) => !data.refs.includes(ref),
        );
        source.excluded = [...new Set([...source.excluded, ...data.refs])];
      }
    }
    update(next);
  }
  if (loading) return <Loading />;
  if (!user)
    return (
      <>
        <Auth
          needsSetup={needsSetup}
          onLogin={(next) => {
            setUser(next);
            run(loadProjects);
          }}
        />
        {error && (
          <div className="global-error" role="alert">
            {error}
          </div>
        )}
      </>
    );
  const workspace = project?.draft;
  const node = workspace?.nodes.find((node) => node.id === nodeId);
  const editorProps = workspace ? { workspace, update } : undefined;
  const showLibrary = !!workspace && ["groups", "chains"].includes(tab);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Clash Workbench 首页">
          <div className="brand-icon">
            <Layers3 size={23} />
          </div>
          <span>
            Clash
            <br />
            <b>Workbench</b>
          </span>
        </a>
        <div className="project-picker">
          <label htmlFor="project-select">当前项目</label>
          <div>
            <select
              id="project-select"
              value={project?.id || ""}
              onChange={(event) => {
                const id = event.target.value;
                run(async () => {
                  await save();
                  sync(await api(`/projects/${id}`));
                  setSelected([]);
                });
              }}
            >
              {!projects.length && <option value="">尚无项目</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.draft.name}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label="创建项目"
              onClick={() => setCreating(true)}
            >
              <Plus size={17} />
            </button>
          </div>
        </div>
        <nav aria-label="工作台导航">
          {tabs.map((item) => (
            <button
              key={item.id}
              disabled={busy}
              aria-label={item.label}
              className={tab === item.id ? "active" : ""}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "ai" && <span className="nav-ai">AI</span>}
              {item.id === "publish" && dirty && (
                <span className="unsaved-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="engine-label">
            <span />
            Mihomo 配置工作台
          </div>
          <button
            className={tab === "settings" ? "active" : ""}
            onClick={() => setTab("settings")}
          >
            <Settings2 size={18} />
            设置
          </button>
          <div className="account">
            <div className="avatar">{user.email[0].toUpperCase()}</div>
            <span title={user.email}>
              {user.email}
              <small>{user.admin ? "管理员" : "个人空间"}</small>
            </span>
            <button
              className="icon-button"
              aria-label="退出登录"
              onClick={() =>
                run(async () => {
                  if (project) await save();
                  await api("/auth/logout", "POST", {});
                  setUser(undefined);
                  setProject(undefined);
                  setProjects([]);
                })
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作台</span>
            <ChevronRight size={14} />
            <strong>
              {tab === "settings" ? "设置" : project?.draft.name || "开始使用"}
            </strong>
          </div>
          <div className="topbar-actions">
            {project && (
              <>
                <span className={`save-status ${dirty ? "is-dirty" : ""}`}>
                  {busy ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : dirty ? (
                    <span className="unsaved-dot" />
                  ) : (
                    <Check size={14} />
                  )}
                  {busy
                    ? "正在处理"
                    : dirty
                      ? "草稿有未保存更改"
                      : "草稿已保存"}
                </span>
                <button
                  className="icon-button"
                  aria-label="撤销上次编辑"
                  disabled={!history.length || busy}
                  onClick={() => {
                    const previous = history.at(-1)!;
                    setHistory(history.slice(0, -1));
                    setProject({ ...project, draft: previous });
                    setDirty(true);
                  }}
                >
                  <Undo2 size={18} />
                </button>
                <button
                  className="secondary"
                  disabled={!dirty || busy}
                  onClick={() =>
                    run(async () => {
                      await save();
                      setNotice("草稿已保存");
                    })
                  }
                >
                  <Save size={16} />
                  保存
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => setTab("publish")}
                >
                  <CloudUpload size={16} />
                  发布
                </button>
              </>
            )}
          </div>
        </header>
        <button
          className="mobile-account icon-button"
          disabled={busy}
          aria-label="项目与账号"
          onClick={() => setAccountMenu(true)}
        >
          <Settings2 size={18} />
        </button>
        {error && (
          <div className="notice error app-notice" role="alert">
            <span>{error}</span>
            {project && (
              <button
                className="text-button"
                onClick={() =>
                  run(async () => {
                    if (
                      !dirty ||
                      window.confirm(
                        "重新载入会丢弃当前未保存的编辑。确定继续？",
                      )
                    )
                      sync(await api(`/projects/${project.id}`));
                  })
                }
              >
                重新载入
              </button>
            )}
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="notice success app-notice" role="status">
            <Check size={17} />
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="workspace-body" aria-busy={busy}>
          <fieldset className="busy-fieldset" disabled={busy}>
            {tab === "settings" ? (
              <main className="main-content">
                <Settings user={user} run={run} />
              </main>
            ) : workspace && project ? (
              <DndContext
                sensors={sensors}
                collisionDetection={(args) => {
                  const collisions = pointerWithin(args);
                  return collisions.length ? collisions : closestCenter(args);
                }}
                onDragStart={({ active }) =>
                  setDrag(active.data.current as DragData)
                }
                onDragEnd={onDragEnd}
                onDragCancel={() => setDrag(undefined)}
              >
                {showLibrary && (
                  <NodeLibrary
                    workspace={workspace}
                    selected={selected}
                    setSelected={setSelected}
                    editNode={(id) => {
                      setNodeId(id);
                      setNodeText(
                        stringify(
                          workspace.nodes.find((node) => node.id === id)!.raw,
                        ),
                      );
                      setNodeError("");
                    }}
                    importNodes={() => setImporting(true)}
                  />
                )}
                <main
                  className={`main-content ${showLibrary ? "with-library" : ""}`}
                  key={`${project.id}:${tab}`}
                >
                  {showLibrary && (
                    <div className="editor-topline">
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={move}
                          onChange={(event) => setMove(event.target.checked)}
                        />
                        跨组拖动时移出原组
                      </label>
                    </div>
                  )}
                  {tab === "groups" && <Groups {...editorProps!} />}
                  {tab === "chains" && <Chains {...editorProps!} />}
                  {tab === "rules" && (
                    <Rules
                      {...editorProps!}
                      projectId={project.id}
                      save={save}
                      run={run}
                      openAI={() => setTab("ai")}
                    />
                  )}
                  {tab === "sources" && (
                    <Sources
                      {...editorProps!}
                      importNodes={() => setImporting(true)}
                      refresh={() =>
                        run(async () => {
                          await save();
                          sync(
                            await api(
                              `/projects/${project.id}/refresh`,
                              "POST",
                              {},
                            ),
                          );
                          setSelected([]);
                          setNotice("来源刷新完成，请检查变化和发布状态");
                        })
                      }
                    />
                  )}
                  {tab === "advanced" && <Advanced {...editorProps!} />}
                  {tab === "ai" && (
                    <AIEditor
                      project={project}
                      dirty={dirty}
                      save={save}
                      update={update}
                      run={run}
                      busy={busy}
                      openSettings={() => setTab("settings")}
                    />
                  )}
                  {tab === "publish" && (
                    <Publish
                      project={project}
                      save={save}
                      sync={sync}
                      run={run}
                      busy={busy}
                    />
                  )}
                </main>
                <DragOverlay>
                  {drag && (
                    <div className="drag-overlay">
                      <Layers3 size={18} />
                      {drag.refs.length > 1
                        ? `${drag.refs.length} 个节点`
                        : referenceName(workspace, drag.refs[0])}
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
            ) : (
              <main className="project-welcome">
                <div className="welcome-mark">
                  <Layers3 size={42} />
                </div>
                <span className="eyebrow">CLASH WORKBENCH</span>
                <h1>你的网络，从这里开始。</h1>
                <p>汇集订阅，编排出口，让分流规则贴合你的日常。</p>
                <button className="primary" onClick={() => setCreating(true)}>
                  <Plus size={18} />
                  创建第一个项目
                </button>
              </main>
            )}
          </fieldset>
        </div>
        <footer className="statusbar">
          <span>
            {workspace
              ? `${workspace.sources.length} 个来源 · ${workspace.nodes.length} 个节点 · ${workspace.groups.length} 个代理组`
              : "个人订阅与配置空间"}
          </span>
          <span>Clash Workbench · v0.1</span>
        </footer>
      </div>
      {accountMenu && (
        <Modal title="项目与账号" close={() => setAccountMenu(false)}>
          <Field label="当前项目">
            <select
              value={project?.id || ""}
              onChange={(event) => {
                const id = event.target.value;
                run(async () => {
                  await save();
                  sync(await api(`/projects/${id}`));
                  setSelected([]);
                  setAccountMenu(false);
                });
              }}
            >
              {!projects.length && <option value="">尚无项目</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.draft.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="account-menu-actions">
            <button
              className="secondary"
              onClick={() => {
                setAccountMenu(false);
                setCreating(true);
              }}
            >
              <Plus size={16} />
              新建项目
            </button>
            <button
              className="secondary"
              onClick={() => {
                setAccountMenu(false);
                setTab("settings");
              }}
            >
              <Settings2 size={16} />
              模型与邀请设置
            </button>
            <button
              className="secondary"
              onClick={() =>
                run(async () => {
                  if (project) await save();
                  await api("/auth/logout", "POST", {});
                  setAccountMenu(false);
                  setUser(undefined);
                  setProject(undefined);
                  setProjects([]);
                })
              }
            >
              <LogOut size={16} />
              退出登录
            </button>
          </div>
        </Modal>
      )}
      {creating && (
        <Modal title="新建配置项目" close={() => setCreating(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                if (project) await save();
                const next = await api<Project>("/projects", "POST", {
                  name: projectName,
                });
                sync(next);
                setCreating(false);
                setProjectName("");
                setTab("groups");
                setSelected([]);
                setImporting(true);
              });
            }}
          >
            <Field label="项目名称">
              <input
                required
                maxLength={100}
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="例如 日常网络"
                autoFocus
              />
            </Field>
            <button className="primary">创建并导入来源</button>
          </form>
        </Modal>
      )}
      {importing && project && (
        <ImportModal
          close={() => setImporting(false)}
          submit={async (input) => {
            const current = await save();
            const result = await api(`/projects/${project.id}/import`, "POST", {
              ...input,
              revision: current.revision,
            });
            sync(result.project);
            setNotice(
              `已导入 ${result.project.draft.nodes.length - current.draft.nodes.length} 个节点${result.warnings.length ? `，有 ${result.warnings.length} 条提示，请在来源中查看` : ""}`,
            );
          }}
        />
      )}
      {node && workspace && (
        <Modal
          title={`编辑节点 · ${node.name}`}
          close={() => setNodeId(undefined)}
        >
          <Field label="显示名称">
            <input
              value={node.name}
              onChange={(event) =>
                update(renameReference(workspace, node.id, event.target.value))
              }
            />
          </Field>
          <Field
            label="节点的上游代理"
            hint="链路各跳请选择直接连接，已有的 dialer-proxy 关系会在这里显示"
          >
            <select
              value={node.dialer || ""}
              onChange={(event) =>
                update({
                  ...workspace,
                  nodes: workspace.nodes.map((item) =>
                    item.id === node.id
                      ? { ...item, dialer: event.target.value || undefined }
                      : item,
                  ),
                })
              }
            >
              <option value="">直接连接</option>
              {[...workspace.nodes, ...workspace.groups]
                .filter((item) => item.id !== node.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="Mihomo 节点参数"
            hint="连接参数会在来源刷新时跟随上游更新，显示名称会保留"
          >
            <textarea
              className="code-input"
              rows={12}
              value={nodeText}
              onChange={(event) => setNodeText(event.target.value)}
            />
          </Field>
          {nodeError && <div className="notice error">{nodeError}</div>}
          <button
            className="primary"
            onClick={() => {
              try {
                const doc = parseDocument(nodeText);
                if (doc.errors.length) throw new Error("YAML 无法解析");
                const raw = doc.toJS({ maxAliasCount: 100 });
                if (!raw || !raw.type || !raw.server || !raw.port)
                  throw new Error("节点需要 type、server 和 port");
                delete raw["dialer-proxy"];
                update({
                  ...workspace,
                  nodes: workspace.nodes.map((item) =>
                    item.id === node.id ? { ...item, raw } : item,
                  ),
                });
                setNodeId(undefined);
              } catch (error) {
                setNodeError((error as Error).message);
              }
            }}
          >
            应用节点参数
          </button>
        </Modal>
      )}
    </div>
  );
}
