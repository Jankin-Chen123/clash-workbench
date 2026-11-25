import { useEffect, useState } from "react";
import { Sparkles, Send, Check, KeyRound, ExternalLink } from "lucide-react";
import { api } from "./api";
import { type Project, type Workspace, type AIProposal } from "../shared/types";
import { Field, Diff } from "./ui";
import { type User } from "./Auth";

type Run = (fn: () => Promise<void>) => void;
export function AIEditor({
  project,
  dirty,
  save,
  update,
  run,
  busy,
  openSettings,
}: {
  project: Project;
  dirty: boolean;
  save: () => Promise<Project>;
  update: (workspace: Workspace) => void;
  run: Run;
  busy: boolean;
  openSettings: () => void;
}) {
  const [messages, setMessages] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<{
    proposal: AIProposal;
    workspace: Workspace;
    revision: number;
  }>();
  const [applied, setApplied] = useState(false);
  return (
    <div className="ai-layout">
      <section className="ai-conversation">
        <div className="section-heading">
          <div>
            <h2>
              <Sparkles size={22} /> AI 分流助手
            </h2>
            <p>用你的语言描述需求，逐步调整现有规则。</p>
          </div>
          <button
            className="icon-button"
            aria-label="配置 AI 接口"
            onClick={openSettings}
          >
            <KeyRound size={18} />
          </button>
        </div>
        <div className="chat-messages">
          {!messages.length && (
            <div className="ai-welcome">
              <div className="ai-orb">
                <Sparkles size={28} />
              </div>
              <h3>你希望流量怎么走？</h3>
              <p>可以修改现有配置，也可以从头搭建分流方案。</p>
              <div className="prompt-suggestions">
                {[
                  "给 GitHub 添加单独的代理规则",
                  "国内网站直连，其他流量走代理",
                  "检查现有规则顺序，修复被遮住的规则",
                ].map((text) => (
                  <button key={text} onClick={() => setPrompt(text)}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message, index) => (
            <div key={index} className={`chat-message ${message.role}`}>
              <small>{message.role === "user" ? "你" : "分流助手"}</small>
              <p>
                {message.role === "assistant"
                  ? (() => {
                      try {
                        return JSON.parse(message.content).summary;
                      } catch {
                        return message.content;
                      }
                    })()
                  : message.content}
              </p>
            </div>
          ))}
          {busy && <p className="muted">正在处理，请稍候…</p>}
        </div>
        <form
          className="prompt-form"
          onSubmit={(event) => {
            event.preventDefault();
            const text = prompt.trim();
            if (!text) return;
            run(async () => {
              const current = await save();
              const nextMessages = [
                ...messages,
                { role: "user" as const, content: text },
              ].slice(-14);
              const response = await api(`/projects/${project.id}/ai`, "POST", {
                messages: nextMessages,
                revision: current.revision,
              });
              setMessages([
                ...nextMessages,
                {
                  role: "assistant",
                  content: JSON.stringify(response.proposal),
                },
              ]);
              setResult(response);
              setApplied(false);
              setPrompt("");
            });
          }}
        >
          <textarea
            required
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            aria-label="对 AI 描述分流需求"
            placeholder="例如：让 GitHub 走开发组，保留其他规则的顺序…"
            rows={3}
          />
          <div>
            <small>发送规则与策略名称，节点凭据留在平台内</small>
            <button className="primary" disabled={busy || !prompt.trim()}>
              <Send size={16} />
              发送
            </button>
          </div>
        </form>
      </section>
      <aside className="ai-proposal">
        <h3>变更提案</h3>
        {result ? (
          <>
            <p>{result.proposal.summary}</p>
            <div className="proposal-stats">
              <span>{result.proposal.rules.length} 条启用规则</span>
              <span>{result.proposal.groups.length} 个组变更</span>
            </div>
            <Diff
              before={project.draft.rules
                .filter((rule) => rule.enabled)
                .map((rule) => rule.text)
                .join("\n")}
              after={result.proposal.rules.join("\n")}
            />
            {!!result.proposal.groups.length && (
              <pre>{JSON.stringify(result.proposal.groups, null, 2)}</pre>
            )}
            <details>
              <summary>查看完整提案规则</summary>
              <pre>{result.proposal.rules.join("\n")}</pre>
            </details>
            <button
              className="primary full"
              disabled={
                applied || dirty || result.revision !== project.revision
              }
              onClick={() => {
                update(result.workspace);
                setApplied(true);
              }}
            >
              <Check size={16} />
              {applied ? "已写入草稿" : "确认并应用到草稿"}
            </button>
            {!applied && (dirty || result.revision !== project.revision) && (
              <small>配置已有变化，请继续对话重新生成提案。</small>
            )}
          </>
        ) : (
          <div className="proposal-placeholder">
            <Sparkles size={24} />
            <p>
              AI 的建议将在这里展示。
              <br />
              确认变更后即可应用到草稿。
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

export function Settings({ user, run }: { user: User; run: Run }) {
  const [settings, setSettings] = useState({
    url: "https://api.openai.com/v1",
    model: "",
    key: "",
    hasKey: false,
  });
  const [saved, setSaved] = useState(false);
  const [invitation, setInvitation] = useState("");
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    void api<{ url: string; model: string; hasKey: boolean }>("/settings/ai")
      .then((value) => setSettings({ ...value, key: "" }))
      .catch((error) => setLoadError(error.message))
      .finally(() => setLoadingSettings(false));
  }, []);
  return (
    <div className="settings-view">
      <div className="section-heading">
        <div>
          <h2>设置</h2>
          <p>管理你自己的模型服务和工作台访问。</p>
        </div>
      </div>
      <section className="settings-card">
        <div className="card-title">
          <Sparkles size={21} />
          <h3>AI 模型接口</h3>
        </div>
        <p className="muted">支持 OpenAI 兼容的 Chat Completions 接口。</p>
        {loadError && <div className="notice error">{loadError}</div>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await api("/settings/ai", "PUT", {
                url: settings.url,
                key: settings.key,
                model: settings.model,
              });
              setSettings({ ...settings, key: "", hasKey: true });
              setSaved(true);
            });
          }}
        >
          <fieldset className="form-fieldset" disabled={loadingSettings}>
            <Field
              label="接口基础地址"
              hint="填写到 /v1 或服务要求的路径，系统会追加 /chat/completions"
            >
              <input
                type="url"
                required
                value={settings.url}
                onChange={(event) => {
                  setSettings({ ...settings, url: event.target.value });
                  setSaved(false);
                }}
              />
            </Field>
            <Field
              label="API 密钥"
              hint={
                settings.hasKey
                  ? "已保存密钥，留空继续使用原密钥"
                  : "密钥加密保存，仅用于你的模型请求"
              }
            >
              <input
                type="password"
                autoComplete="off"
                required={!settings.hasKey}
                value={settings.key}
                onChange={(event) => {
                  setSettings({ ...settings, key: event.target.value });
                  setSaved(false);
                }}
                placeholder={settings.hasKey ? "•••••••• 已保存" : "输入密钥"}
              />
            </Field>
            <Field label="模型名称">
              <input
                required
                value={settings.model}
                onChange={(event) => {
                  setSettings({ ...settings, model: event.target.value });
                  setSaved(false);
                }}
                placeholder="输入服务支持的模型名称"
              />
            </Field>
            <button className="primary">保存模型配置</button>
            {saved && <span className="saved-label">已保存</span>}
          </fieldset>
        </form>
      </section>
      {user.admin && (
        <section className="settings-card">
          <h3>邀请新用户</h3>
          <p className="muted">每个邀请码可注册一个独立账号。</p>
          <button
            className="secondary"
            onClick={() =>
              run(async () => {
                setInvitation((await api("/invitations", "POST", {})).code);
              })
            }
          >
            生成邀请码
          </button>
          {invitation && (
            <div className="token-line">
              <code>{invitation}</code>
              <button
                className="secondary"
                onClick={() =>
                  run(async () => navigator.clipboard.writeText(invitation))
                }
              >
                复制
              </button>
            </div>
          )}
        </section>
      )}
      <p className="muted">当前账号 {user.email}</p>
      <a
        className="source-link"
        href="https://wiki.metacubex.one/"
        target="_blank"
        rel="noreferrer"
      >
        Mihomo 配置文档 <ExternalLink size={14} />
      </a>
    </div>
  );
}
