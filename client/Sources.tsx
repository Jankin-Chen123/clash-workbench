import { useState } from "react";
import { stringify, parseDocument } from "yaml";
import {
  Upload,
  Link2,
  RefreshCw,
  FileCode2,
  Trash2,
  Plus,
} from "lucide-react";
import { type EditorProps } from "./Editor";
import { Field, Modal, Empty } from "./ui";

export function ImportModal({
  close,
  submit,
}: {
  close: () => void;
  submit: (input: {
    name: string;
    text?: string;
    url?: string;
    files: Record<string, string>;
  }) => Promise<void>;
}) {
  const [mode, setMode] = useState("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Record<string, string>>({});
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function fileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("文件不能超过 5 MB");
      return;
    }
    setText(await file.text());
    setFilename(file.name);
    if (!name) setName(file.name.replace(/\.ya?ml$/i, ""));
  }
  return (
    <Modal title="导入订阅与配置" close={close}>
      <div className="segmented">
        <button
          className={mode === "url" ? "active" : ""}
          onClick={() => setMode("url")}
        >
          <Link2 size={16} />
          订阅链接
        </button>
        <button
          className={mode === "file" ? "active" : ""}
          onClick={() => setMode("file")}
        >
          <FileCode2 size={16} />
          YAML / 节点文本
        </button>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await submit({
              name,
              ...(mode === "url" ? { url } : { text }),
              files,
            });
            close();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="来源名称">
          <input
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 我的机场"
            autoFocus
          />
        </Field>
        {mode === "url" ? (
          <Field label="订阅链接" hint="来源定时更新，发布后的手工编排会被保留">
            <input
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
            />
          </Field>
        ) : (
          <>
            <label className="upload-zone">
              <Upload size={22} />
              <span>{filename || "选择 YAML 文件"}</span>
              <input
                type="file"
                accept=".yaml,.yml,.txt"
                onChange={fileUpload}
              />
            </label>
            <Field label="或粘贴配置 / 节点链接">
              <textarea
                className="code-input"
                rows={9}
                required
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  "proxies:\n  - name: 我的节点\n    type: socks5\n    server: example.com\n    port: 1080"
                }
              />
            </Field>
          </>
        )}
        <details>
          <summary>补传本地节点提供者文件</summary>
          <p className="muted">
            如果主配置引用了本地 proxy-providers 文件，在这里同时上传。
          </p>
          <input
            type="file"
            multiple
            accept=".yaml,.yml,.txt"
            aria-label="节点提供者附属文件"
            onChange={async (event) => {
              const result: Record<string, string> = {};
              for (const file of event.target.files || []) {
                if (file.size <= 5 * 1024 * 1024)
                  result[file.name] = await file.text();
              }
              setFiles(result);
            }}
          />
          {!!Object.keys(files).length && (
            <small>{Object.keys(files).join("、")}</small>
          )}
        </details>
        <p className="muted">
          首份完整配置会保留原分组、分流和高级设置。后续导入追加节点。
        </p>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <button className="primary full" disabled={busy}>
          {busy ? "正在读取来源…" : "解析并导入"}
        </button>
      </form>
    </Modal>
  );
}

export function Sources({
  workspace,
  update,
  refresh,
  importNodes,
}: EditorProps & { refresh: () => void; importNodes: () => void }) {
  const [edit, setEdit] = useState<string>();
  const [url, setUrl] = useState("");
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>订阅来源</h2>
          <p>所有来源汇入同一个节点库，编排与上游更新各自保存。</p>
        </div>
        <div className="button-row">
          <button className="secondary" onClick={refresh}>
            <RefreshCw size={16} />
            刷新来源
          </button>
          <button className="primary" onClick={importNodes}>
            <Plus size={16} />
            导入来源
          </button>
        </div>
      </div>
      <div className="sources-list">
        {workspace.sources.map((source) => (
          <div className="source-card" key={source.id}>
            <div className="source-icon">
              {source.url ? <Link2 /> : <FileCode2 />}
            </div>
            <div className="source-info">
              <h3>{source.name}</h3>
              <p>
                {source.url ? "在线订阅 · 自动同步" : "本地导入 · 手动维护"} ·{" "}
                {
                  workspace.nodes.filter((node) => node.sourceId === source.id)
                    .length
                }{" "}
                个节点
              </p>
              <small>
                最近更新 {new Date(source.refreshedAt).toLocaleString("zh-CN")}
              </small>
              {source.error && <p className="danger">{source.error}</p>}
              {source.warnings?.length > 0 && (
                <details>
                  <summary>{source.warnings.length} 条导入提示</summary>
                  {source.warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                </details>
              )}
            </div>
            <div className="button-row">
              {source.url && (
                <button
                  className="secondary"
                  onClick={() => {
                    setEdit(source.id);
                    setUrl(source.url!);
                  }}
                >
                  修改链接
                </button>
              )}
              <button
                className="icon-button danger"
                aria-label={`删除来源 ${source.name}`}
                onClick={() => {
                  if (
                    window.confirm(
                      `删除「${source.name}」及其节点？引用这些节点的组和链路需要修复。`,
                    )
                  )
                    update({
                      ...workspace,
                      sources: workspace.sources.filter(
                        (item) => item.id !== source.id,
                      ),
                      nodes: workspace.nodes.filter(
                        (node) => node.sourceId !== source.id,
                      ),
                    });
                }}
              >
                <Trash2 size={17} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {!workspace.sources.length && (
        <Empty icon={<Upload />} title="添加你的第一个来源">
          <p>订阅链接和本地配置可以混合使用。</p>
          <button className="primary" onClick={importNodes}>
            导入来源
          </button>
        </Empty>
      )}
      {edit && (
        <Modal title="修改来源链接" close={() => setEdit(undefined)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              update({
                ...workspace,
                sources: workspace.sources.map((source) =>
                  source.id === edit ? { ...source, url } : source,
                ),
              });
              setEdit(undefined);
            }}
          >
            <Field label="订阅 URL">
              <input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <p className="muted">
              保存后点击刷新来源，新地址中的节点会与原节点按连接参数匹配。
            </p>
            <button className="primary">保存链接</button>
          </form>
        </Modal>
      )}
    </>
  );
}

export function Advanced({ workspace, update }: EditorProps) {
  const [text, setText] = useState(() => stringify(workspace.base));
  const [error, setError] = useState("");
  return (
    <div className="advanced">
      <div className="section-heading">
        <div>
          <h2>高级配置</h2>
          <p>编辑 DNS、TUN、端口和其他 Mihomo 设置。</p>
        </div>
      </div>
      <textarea
        className="code-input advanced-input"
        aria-label="高级 YAML 配置"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {error && <div className="notice error">{error}</div>}
      <div className="button-row">
        <button
          className="primary"
          onClick={() => {
            try {
              const doc = parseDocument(text);
              if (doc.errors.length)
                throw new Error("YAML 无法解析，请检查缩进");
              const value = doc.toJS({ maxAliasCount: 100 });
              if (!value || Array.isArray(value) || typeof value !== "object")
                throw new Error("高级设置必须是 YAML 对象");
              if (
                ["proxies", "proxy-groups", "proxy-providers", "rules"].some(
                  (key) => key in value,
                )
              )
                throw new Error("请在对应页面编辑节点、代理组和分流规则");
              update({ ...workspace, base: value });
              setError("");
            } catch (error) {
              setError((error as Error).message);
            }
          }}
        >
          应用到草稿
        </button>
        <span className="muted">应用后统一保存和发布</span>
      </div>
    </div>
  );
}
