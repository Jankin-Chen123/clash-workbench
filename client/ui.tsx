import { useEffect, useRef, type ReactNode } from "react";
import { X, LoaderCircle } from "lucide-react";
import { diffLines } from "diff";

export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={wide ? "modal wide" : "modal"}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={close}>
          <X size={20} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle size={26} className="spin" />
      <span>正在载入工作台</span>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Diff({ before, after }: { before: string; after: string }) {
  const changes = diffLines(before, after);
  const removed = changes
    .filter((change) => change.removed)
    .map((change) => change.value)
    .join("");
  const added = changes
    .filter((change) => change.added)
    .map((change) => change.value)
    .join("");
  return (
    <div className="diff">
      <div>
        <h4>上一版中移除或改变的行</h4>
        <pre>{removed || "无"}</pre>
      </div>
      <div>
        <h4>这一版中新增或改变的行</h4>
        <pre>{added || "无"}</pre>
      </div>
      <small>移动顺序的行会同时显示为移除和新增。</small>
    </div>
  );
}
