import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  CheckCircle2,
  AlertTriangle,
  Copy,
  Download,
  RotateCcw,
  ShieldCheck,
  QrCode,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { type Project, type Issue } from "../shared/types";
import { api } from "./api";
import { Diff } from "./ui";

export function Publish({
  project,
  save,
  sync,
  run,
  busy,
}: {
  project: Project;
  save: () => Promise<Project>;
  sync: (project: Project) => void;
  run: (fn: () => Promise<void>) => void;
  busy: boolean;
}) {
  const [result, setResult] = useState<{
    issues: Issue[];
    yaml: string;
    publishedYaml: string;
    coreChecked: boolean;
  }>();
  const [checkedRevision, setCheckedRevision] = useState<number>();
  const [versions, setVersions] = useState<any[]>([]);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [versionError, setVersionError] = useState("");
  useEffect(() => {
    void api<any[]>(`/projects/${project.id}/versions`)
      .then(setVersions)
      .catch((error) => setVersionError(error.message));
  }, []);
  useEffect(() => {
    if (project.subscriptionUrl)
      void QRCode.toDataURL(project.subscriptionUrl, {
        width: 220,
        margin: 2,
        color: { dark: "#173d35", light: "#ffffff" },
      }).then(setQr);
    else setQr("");
  }, [project.subscriptionUrl]);
  const hasErrors = result?.issues.some((issue) => issue.level === "error");
  return (
    <div className="publish-view">
      <div className="section-heading">
        <div>
          <h2>发布订阅</h2>
          <p>将通过检查的配置发布到稳定链接，让客户端持续接收更新。</p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const current = await save();
              setResult(await api(`/projects/${project.id}/check`, "POST", {}));
              setCheckedRevision(current.revision);
            })
          }
        >
          <ShieldCheck size={17} />
          检查当前草稿
        </button>
      </div>
      {project.publishError && (
        <div className="notice error">
          <AlertTriangle size={19} />
          <div>
            <strong>自动更新未通过检查，订阅继续使用上一版</strong>
            <p>{project.publishError}</p>
          </div>
        </div>
      )}
      <div className="publish-grid">
        <section className="settings-card check-card">
          <div className="card-title">
            <ShieldCheck size={23} />
            <h3>发布检查</h3>
          </div>
          {result ? (
            <>
              <div
                className={`check-status ${hasErrors ? "danger" : "success"}`}
              >
                {hasErrors ? <XCircle /> : <CheckCircle2 />}
                <strong>
                  {hasErrors
                    ? "请修复配置后再发布"
                    : "已通过结构与 Mihomo 语法校验"}
                </strong>
              </div>
              <ul className="issues">
                {result.issues.map((issue, index) => (
                  <li
                    key={index}
                    className={issue.level === "error" ? "danger" : ""}
                  >
                    <AlertTriangle size={15} />
                    <span>{issue.message}</span>
                  </li>
                ))}
              </ul>
              {checkedRevision !== project.revision && (
                <p className="notice">草稿已有变化，请重新检查。</p>
              )}
              <button
                className="primary"
                disabled={
                  busy || hasErrors || checkedRevision !== project.revision
                }
                onClick={() =>
                  run(async () => {
                    const response = await api(
                      `/projects/${project.id}/publish`,
                      "POST",
                      { revision: project.revision },
                    );
                    sync(response.project);
                    setCheckedRevision(undefined);
                    setVersions(await api(`/projects/${project.id}/versions`));
                  })
                }
              >
                <UploadCloud size={17} />
                发布此版本
              </button>
            </>
          ) : (
            <div className="check-placeholder">
              <ShieldCheck size={36} />
              <p>
                先检查节点引用、链路与分流规则，
                <br />
                再发布到你的订阅链接。
              </p>
            </div>
          )}
        </section>
        <section className="settings-card subscription-card">
          <div className="card-title">
            <QrCode size={23} />
            <h3>你的订阅</h3>
          </div>
          {project.publishedAt ? (
            <>
              <small>
                最近发布 {new Date(project.publishedAt).toLocaleString("zh-CN")}
              </small>
              {project.subscriptionUrl ? (
                <>
                  <div className="token-line">
                    <input
                      aria-label="订阅链接"
                      readOnly
                      value={project.subscriptionUrl}
                    />
                    <button
                      className="icon-button"
                      aria-label="复制订阅链接"
                      onClick={() =>
                        run(async () => {
                          await navigator.clipboard.writeText(
                            project.subscriptionUrl!,
                          );
                          setCopied(true);
                        })
                      }
                    >
                      <Copy size={18} />
                    </button>
                  </div>
                  {copied && <small className="success">订阅链接已复制</small>}
                  {qr && (
                    <img className="qr-image" src={qr} alt="订阅链接二维码" />
                  )}
                  <div className="button-row">
                    <button
                      className="text-button"
                      onClick={() => {
                        if (
                          window.confirm(
                            "重新生成后，旧链接和二维码将失效。确定继续？",
                          )
                        )
                          run(async () =>
                            sync(
                              await api(
                                `/projects/${project.id}/token`,
                                "POST",
                                { action: "rotate" },
                              ),
                            ),
                          );
                      }}
                    >
                      重新生成链接
                    </button>
                    <button
                      className="danger text-button"
                      onClick={() => {
                        if (
                          window.confirm(
                            "撤销后，客户端将无法使用当前链接更新订阅。确定撤销？",
                          )
                        )
                          run(async () =>
                            sync(
                              await api(
                                `/projects/${project.id}/token`,
                                "POST",
                                { action: "revoke" },
                              ),
                            ),
                          );
                      }}
                    >
                      撤销链接
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>订阅链接已撤销。</p>
                  <button
                    className="secondary"
                    onClick={() =>
                      run(async () =>
                        sync(
                          await api(`/projects/${project.id}/token`, "POST", {
                            action: "rotate",
                          }),
                        ),
                      )
                    }
                  >
                    生成新链接
                  </button>
                </>
              )}
              <a
                className="secondary download-button"
                href={`/api/projects/${project.id}/download`}
                download
              >
                <Download size={16} />
                下载已发布 YAML
              </a>
            </>
          ) : (
            <p className="muted">首次发布后，这里会生成订阅链接和二维码。</p>
          )}
        </section>
      </div>
      {result && (
        <section className="settings-card config-preview">
          <div className="card-title">
            <h3>配置与版本差异</h3>
          </div>
          <Diff before={result.publishedYaml} after={result.yaml} />
          <details>
            <summary>查看完整生成配置 · 含节点凭据</summary>
            <pre>{result.yaml}</pre>
          </details>
        </section>
      )}
      <section className="settings-card version-history">
        {versionError && <div className="notice error">{versionError}</div>}
        <div className="card-title">
          <RotateCcw size={20} />
          <h3>发布历史</h3>
        </div>
        {versions.length ? (
          versions.map((version) => (
            <div className="version-row" key={version.id}>
              <span>
                <strong>{version.label}</strong>
                <small>
                  {new Date(version.created_at).toLocaleString("zh-CN")}
                </small>
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "将订阅恢复为该历史版本？当前草稿会继续保留。",
                    )
                  )
                    run(async () => {
                      const current = await save();
                      const response = await api(
                        `/projects/${project.id}/rollback`,
                        "POST",
                        { versionId: version.id, revision: current.revision },
                      );
                      sync(response.project);
                      setVersions(
                        await api(`/projects/${project.id}/versions`),
                      );
                      setResult(undefined);
                    });
                }}
              >
                回滚到此版本
              </button>
            </div>
          ))
        ) : (
          <p className="muted">发布后会在这里保存可恢复的版本。</p>
        )}
      </section>
    </div>
  );
}
