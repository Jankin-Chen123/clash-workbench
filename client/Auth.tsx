import { useState } from "react";
import {
  Layers3,
  ArrowUpRight,
  LoaderCircle,
  Workflow,
  Route,
  Sparkles,
} from "lucide-react";
import { api } from "./api";
import { Field } from "./ui";

export interface User {
  id: string;
  email: string;
  admin: boolean;
}
export function Auth({
  needsSetup,
  onLogin,
}: {
  needsSetup: boolean;
  onLogin: (user: User) => void;
}) {
  const [register, setRegister] = useState(needsSetup);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(
        await api<User>(`/auth/${register ? "register" : "login"}`, "POST", {
          email,
          password,
          invitation,
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-art">
        <div className="brand">
          <Layers3 size={28} />
          <span>Clash Workbench</span>
        </div>
        <div className="auth-intro">
          <span className="eyebrow">YOUR NETWORK, COMPOSED.</span>
          <h1>
            把网络路线
            <br />
            搭成你想要的样子。
          </h1>
          <p>
            从一个订阅开始，编排节点、串联代理，
            <br />
            让每一条流量都有自己的去向。
          </p>
          <div className="network-art">
            <div className="art-card">
              <Workflow size={23} />
              <strong>我的节点</strong>
              <span className="art-dot" />
            </div>
            <div className="art-connector" />
            <div className="art-card offset">
              <Route size={23} />
              <strong>自由编排</strong>
              <span className="art-dot gold" />
            </div>
            <div className="art-connector" />
            <div className="art-card">
              <Sparkles size={23} />
              <strong>智能分流</strong>
              <span className="art-dot" />
            </div>
          </div>
        </div>
        <small>为 Mihomo 配置设计的可视化工作台</small>
      </section>
      <section className="auth-form">
        <div className="auth-form-inner">
          <span className="eyebrow">欢迎来到工作台</span>
          <h2>
            {needsSetup
              ? "创建管理员账号"
              : register
                ? "创建你的账号"
                : "登录你的工作台"}
          </h2>
          <p className="muted">
            {needsSetup
              ? "这是首次启动。这个账号将管理邀请和你的配置项目。"
              : "继续编排属于你的网络。"}
          </p>
          <form onSubmit={submit}>
            <Field label="邮箱">
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="密码" hint="至少 10 个字符">
              <input
                type="password"
                required
                minLength={10}
                maxLength={200}
                autoComplete={register ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {register && !needsSetup && (
              <Field label="邀请码">
                <input
                  required
                  value={invitation}
                  onChange={(event) => setInvitation(event.target.value)}
                />
              </Field>
            )}
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <button className="primary full" disabled={busy}>
              {busy ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <ArrowUpRight size={18} />
              )}
              {register ? "创建账号并进入" : "登录"}
            </button>
          </form>
          {!needsSetup && (
            <button
              className="text-button"
              onClick={() => setRegister(!register)}
            >
              {register ? "已有账号，去登录" : "使用邀请码创建账号"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
