import { randomUUID, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { encrypt, decrypt, hash, HttpError, publicUrl } from "./config.js";
import {
  emptyWorkspace,
  type Workspace,
  type Project,
} from "../shared/types.js";
import { compileYaml } from "./compiler.js";
import { check } from "./checker.js";
import { refreshSources } from "./importer.js";

export interface Published {
  workspace: Workspace;
  yaml: string;
}
export async function ownedProject(id: string, userId: string) {
  const { rows } = await db.query(
    "SELECT * FROM projects WHERE id=$1 AND user_id=$2",
    [id, userId],
  );
  if (!rows[0]) throw new HttpError(404, "项目不存在");
  return rows[0];
}

export function projectView(row: Record<string, any>): Project {
  return {
    id: row.id,
    revision: row.revision,
    draft: decrypt<Workspace>(row.content),
    publishedAt:
      row.published_at?.toISOString?.() || row.published_at || undefined,
    publishError: row.publish_error || undefined,
    subscriptionUrl: row.subscription_token
      ? `${publicUrl}/s/${decrypt<string>(row.subscription_token)}/config.yaml`
      : undefined,
  };
}

export async function createProject(userId: string, name: string) {
  const { rows } = await db.query(
    "INSERT INTO projects (id,user_id,content) VALUES ($1,$2,$3) RETURNING *",
    [randomUUID(), userId, encrypt(emptyWorkspace(name))],
  );
  return projectView(rows[0]);
}

export async function saveDraft(
  id: string,
  userId: string,
  revision: number,
  workspace: Workspace,
) {
  const { rows } = await db.query(
    "UPDATE projects SET content=$1,revision=revision+1 WHERE id=$2 AND user_id=$3 AND revision=$4 RETURNING *",
    [encrypt(workspace), id, userId, revision],
  );
  if (!rows[0])
    throw new HttpError(
      409,
      "项目已在其他页面或刷新任务中更新，请重新载入后再编辑",
    );
  return projectView(rows[0]);
}

export async function publish(
  row: Record<string, any>,
  workspace: Workspace,
  label = "手动发布",
) {
  const result = await check(workspace);
  if (result.issues.some((issue) => issue.level === "error"))
    throw new HttpError(
      400,
      result.issues
        .filter((issue) => issue.level === "error")
        .map((issue) => issue.message)
        .join("；"),
    );
  const published: Published = { workspace, yaml: compileYaml(workspace) };
  const token = row.subscription_token
    ? decrypt<string>(row.subscription_token)
    : randomBytes(32).toString("base64url");
  const content = encrypt(published);
  // One SQL statement makes the published snapshot and version history atomic.
  const { rows } = await db.query(
    `WITH updated AS (
    UPDATE projects SET published=$1,published_at=NOW(),publish_error=NULL,
      subscription_hash=$2,subscription_token=$3,revision=revision+1
    WHERE id=$4 AND revision=$5 RETURNING *
  ), version AS (
    INSERT INTO versions (id,project_id,content,label) SELECT $6,id,$1,$7 FROM updated
  ) SELECT * FROM updated`,
    [
      content,
      hash(token),
      encrypt(token),
      row.id,
      row.revision,
      randomUUID(),
      label,
    ],
  );
  if (!rows[0]) throw new HttpError(409, "发布时项目已更新，请重新载入");
  return { project: projectView(rows[0]), ...result };
}

const refreshing = new Set<string>();
export async function refreshProject(row: Record<string, any>) {
  if (refreshing.has(row.id))
    throw new HttpError(409, "项目正在刷新，请稍后重试");
  refreshing.add(row.id);
  try {
    const original = decrypt<Workspace>(row.content);
    const draft = await refreshSources(original);
    const published = row.published
      ? decrypt<Published>(row.published)
      : undefined;
    let nextPublished = row.published;
    let publishError: string | null = null;
    let changed = false;
    if (published) {
      // Reuse a source fetch result only when draft and publication share that source.
      const candidate = structuredClone(published.workspace);
      const missing = candidate.sources.filter(
        (source) =>
          source.url && !draft.sources.some((s) => s.id === source.id),
      );
      const extra = missing.length
        ? await refreshSources({ ...candidate, sources: missing })
        : undefined;
      for (const source of candidate.sources.filter((source) => source.url)) {
        const refreshedSource =
          draft.sources.find((s) => s.id === source.id) ||
          extra?.sources.find((s) => s.id === source.id);
        const fetched =
          refreshedSource && draft.sources.some((s) => s.id === source.id)
            ? draft
            : extra;
        if (!refreshedSource || !fetched) continue;
        source.refreshedAt = refreshedSource.refreshedAt;
        source.error = refreshedSource.error;
        const old = candidate.nodes.filter((n) => n.sourceId === source.id);
        const updated = fetched.nodes
          .filter((n) => n.sourceId === source.id)
          .map((node) => {
            const previous = old.find((n) => n.id === node.id);
            return {
              ...node,
              name: previous?.name || node.originalName,
              dialer: previous?.dialer ?? node.dialer,
            };
          });
        candidate.nodes = [
          ...candidate.nodes.filter((n) => n.sourceId !== source.id),
          ...updated,
        ];
      }
      const checkResult = await check(candidate);
      const errors = checkResult.issues.filter(
        (issue) => issue.level === "error",
      );
      if (errors.length)
        publishError = errors.map((issue) => issue.message).join("；");
      else {
        const yaml = compileYaml(candidate);
        changed = yaml !== published.yaml;
        nextPublished = encrypt({ workspace: candidate, yaml });
      }
    }
    const { rows } = await db.query(
      `WITH updated AS (
      UPDATE projects SET content=$1,published=$2,publish_error=$3,revision=revision+1,refresh_at=NOW(),
        published_at=CASE WHEN $4 THEN NOW() ELSE published_at END
      WHERE id=$5 AND revision=$6 RETURNING *
    ), version AS (
      INSERT INTO versions (id,project_id,content,label) SELECT $7,id,$2,'自动同步节点' FROM updated WHERE $4
    ) SELECT * FROM updated`,
      [
        encrypt(draft),
        nextPublished,
        publishError,
        changed,
        row.id,
        row.revision,
        randomUUID(),
      ],
    );
    if (!rows[0])
      throw new HttpError(
        409,
        "刷新期间有新的编辑，本次刷新结果未覆盖编辑，请重试",
      );
    return projectView(rows[0]);
  } finally {
    refreshing.delete(row.id);
  }
}

let backgroundRunning = false;
export async function refreshDueProjects() {
  if (backgroundRunning) return;
  backgroundRunning = true;
  try {
    const minutes = Math.max(5, Number(process.env.REFRESH_MINUTES) || 60);
    const { rows } = await db.query(
      "SELECT * FROM projects WHERE refresh_at < NOW() - ($1 * INTERVAL '1 minute') ORDER BY refresh_at LIMIT 20",
      [minutes],
    );
    for (const row of rows) {
      try {
        await refreshProject(row);
      } catch {
        /* A later scheduler tick safely retries conflicts and failures. */
      }
    }
    await db.query("DELETE FROM sessions WHERE expires_at < NOW()");
  } finally {
    backgroundRunning = false;
  }
}
