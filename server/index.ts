import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { db, initDb, transaction, closeDb } from "./db.js";
import {
  encrypt,
  decrypt,
  hash,
  HttpError,
  publicUrl,
  secureCookies,
} from "./config.js";
import {
  createProject,
  ownedProject,
  projectView,
  saveDraft,
  publish,
  refreshProject,
  refreshDueProjects,
  type Published,
} from "./projects.js";
import { importWorkspace } from "./importer.js";
import { check, coreAvailable } from "./checker.js";
import { compileYaml } from "./compiler.js";
import { simulate } from "./simulator.js";
import { workspaceSchema } from "./schema.js";
import { askAI, aiSettingsSchema, type AISettings } from "./ai.js";
import { substoreAvailable } from "./substore.js";

const scrypt = promisify(scryptCallback);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", Math.max(0, Number(process.env.TRUST_PROXY_HOPS) || 0));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "img-src": ["'self'", "data:"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "script-src": ["'self'"],
        "connect-src": ["'self'"],
        "upgrade-insecure-requests": secureCookies ? [] : null,
      },
    },
  }),
);
app.use(express.json({ limit: "8mb" }));
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use((req, _res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin && origin !== new URL(publicUrl).origin)
      return next(new HttpError(403, "请求来源与 PUBLIC_URL 不一致"));
    if (!req.is("application/json"))
      return next(new HttpError(415, "请使用 JSON 请求"));
  }
  next();
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "尝试次数过多，请稍后再试" },
});
app.use("/api/auth", authLimiter);
app.use(
  "/s",
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    message: { error: "请求过于频繁" },
  }),
);

const authInput = z.object({
  email: z
    .string()
    .email()
    .max(200)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(200),
  invitation: z.string().max(200).optional(),
});
const revisionInput = z.object({ revision: z.number().int().positive() });

async function session(req: express.Request) {
  const cookie = req
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("cw_session="))
    ?.slice("cw_session=".length);
  if (!cookie) throw new HttpError(401, "请先登录");
  const { rows } = await db.query(
    "SELECT u.id,u.email,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>NOW()",
    [hash(cookie)],
  );
  if (!rows[0]) throw new HttpError(401, "登录已过期，请重新登录");
  return rows[0] as { id: string; email: string; admin: boolean };
}

async function setSession(userId: string, res: express.Response) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '14 days')",
    [hash(token), userId],
  );
  res.cookie("cw_session", token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    maxAge: 14 * 86400_000,
    path: "/",
  });
}

app.get("/api/health", async (_req, res) => {
  await db.query("SELECT 1");
  res.json({ ok: true });
});
app.get("/api/auth/status", async (_req, res) => {
  const { rows } = await db.query("SELECT id FROM users LIMIT 1");
  res.json({ needsSetup: !rows.length });
});
app.post("/api/auth/register", async (req, res) => {
  const input = authInput.parse(req.body);
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `${salt}:${((await scrypt(input.password, salt, 64)) as Buffer).toString("hex")}`;
  const user = await transaction(async (connection) => {
    await connection.query("LOCK TABLE users IN EXCLUSIVE MODE");
    const { rows } = await connection.query("SELECT id FROM users LIMIT 1");
    const admin = rows.length === 0;
    if (!admin) {
      const invitation = await connection.query(
        "UPDATE invitations SET used=TRUE WHERE code=$1 AND used=FALSE RETURNING code",
        [hash(input.invitation || "")],
      );
      if (!invitation.rows.length)
        throw new HttpError(400, "邀请码无效或已使用");
    }
    const id = randomUUID();
    const result = await connection.query(
      "INSERT INTO users(id,email,password,admin) VALUES($1,$2,$3,$4) RETURNING id,email,admin",
      [id, input.email, passwordHash, admin],
    );
    return result.rows[0];
  });
  await setSession(user.id, res);
  res.json(user);
});
app.post("/api/auth/login", async (req, res) => {
  const input = authInput.parse(req.body);
  const { rows } = await db.query("SELECT * FROM users WHERE email=$1", [
    input.email,
  ]);
  const [salt, expected] = (
    rows[0]?.password || `${"0".repeat(32)}:${"0".repeat(128)}`
  ).split(":");
  const actual = (await scrypt(input.password, salt, 64)) as Buffer;
  if (!rows[0] || !timingSafeEqual(actual, Buffer.from(expected, "hex")))
    throw new HttpError(401, "邮箱或密码不正确");
  await setSession(rows[0].id, res);
  res.json({ id: rows[0].id, email: rows[0].email, admin: rows[0].admin });
});
app.get("/api/me", async (req, res) => res.json(await session(req)));
app.post("/api/auth/logout", async (req, res) => {
  const cookie = req
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("cw_session="))
    ?.slice("cw_session=".length);
  if (cookie)
    await db.query("DELETE FROM sessions WHERE token=$1", [hash(cookie)]);
  res.clearCookie("cw_session", {
    path: "/",
    secure: secureCookies,
    httpOnly: true,
    sameSite: "lax",
  });
  res.json({ ok: true });
});
app.post("/api/invitations", async (req, res) => {
  const user = await session(req);
  if (!user.admin) throw new HttpError(403, "仅管理员可创建邀请码");
  const code = randomBytes(12).toString("base64url");
  await db.query("INSERT INTO invitations(code) VALUES($1)", [hash(code)]);
  res.json({ code });
});
app.get("/api/capabilities", async (req, res) => {
  await session(req);
  res.json({ mihomo: await coreAvailable(), substore: substoreAvailable() });
});
app.get("/api/projects", async (req, res) => {
  const user = await session(req);
  const { rows } = await db.query(
    "SELECT * FROM projects WHERE user_id=$1 ORDER BY id",
    [user.id],
  );
  res.json(rows.map(projectView));
});
app.post("/api/projects", async (req, res) => {
  const user = await session(req);
  const { name } = z
    .object({ name: z.string().trim().min(1).max(120) })
    .parse(req.body);
  res.json(await createProject(user.id, name));
});
app.get("/api/projects/:id", async (req, res) =>
  res.json(
    projectView(
      await ownedProject(String(req.params.id), (await session(req)).id),
    ),
  ),
);
app.put("/api/projects/:id", async (req, res) => {
  const user = await session(req);
  const { revision } = revisionInput.parse(req.body);
  const workspace = workspaceSchema.parse(req.body.workspace);
  res.json(
    await saveDraft(String(req.params.id), user.id, revision, workspace),
  );
});
app.post("/api/projects/:id/import", async (req, res) => {
  const user = await session(req);
  const row = await ownedProject(String(req.params.id), user.id);
  const input = z
    .object({
      name: z.string().min(1).max(120),
      url: z.string().url().max(8192).optional(),
      text: z.string().max(5_000_000).optional(),
      files: z.record(z.string(), z.string()).optional(),
      revision: z.number().int(),
    })
    .parse(req.body);
  const result = await importWorkspace(input, projectView(row).draft);
  const workspace = workspaceSchema.parse(result.workspace);
  res.json({
    project: await saveDraft(row.id, user.id, input.revision, workspace),
    warnings: result.warnings,
  });
});
app.post("/api/projects/:id/refresh", async (req, res) =>
  res.json(
    await refreshProject(
      await ownedProject(String(req.params.id), (await session(req)).id),
    ),
  ),
);
app.post("/api/projects/:id/check", async (req, res) => {
  const row = await ownedProject(
    String(req.params.id),
    (await session(req)).id,
  );
  const workspace = projectView(row).draft;
  res.json({
    ...(await check(workspace)),
    yaml: compileYaml(workspace),
    publishedYaml: row.published ? decrypt<Published>(row.published).yaml : "",
  });
});
app.post("/api/projects/:id/publish", async (req, res) => {
  const row = await ownedProject(
    String(req.params.id),
    (await session(req)).id,
  );
  const { revision } = revisionInput.parse(req.body);
  if (revision !== row.revision)
    throw new HttpError(409, "项目已更新，请重新载入");
  res.json(await publish(row, projectView(row).draft));
});
app.get("/api/projects/:id/download", async (req, res) => {
  const row = await ownedProject(
    String(req.params.id),
    (await session(req)).id,
  );
  if (!row.published) throw new HttpError(400, "请先校验并发布配置");
  res
    .type("application/yaml")
    .attachment("mihomo.yaml")
    .send(decrypt<Published>(row.published).yaml);
});
app.get("/s/:token/config.yaml", async (req, res) => {
  const { rows } = await db.query(
    "SELECT published FROM projects WHERE subscription_hash=$1",
    [hash(String(req.params.token))],
  );
  if (!rows[0]?.published) throw new HttpError(404, "订阅不存在或已撤销");
  res
    .set({
      "Cache-Control": "no-store",
      "profile-update-interval": "1",
      "Content-Type": "application/yaml; charset=utf-8",
    })
    .send(decrypt<Published>(rows[0].published).yaml);
});
app.post("/api/projects/:id/token", async (req, res) => {
  const user = await session(req);
  const row = await ownedProject(String(req.params.id), user.id);
  const { action } = z
    .object({ action: z.enum(["rotate", "revoke"]) })
    .parse(req.body);
  const token =
    action === "rotate" ? randomBytes(32).toString("base64url") : null;
  const { rows } = await db.query(
    "UPDATE projects SET subscription_hash=$1,subscription_token=$2,revision=revision+1 WHERE id=$3 RETURNING *",
    [token ? hash(token) : null, token ? encrypt(token) : null, row.id],
  );
  res.json(projectView(rows[0]));
});
app.get("/api/projects/:id/versions", async (req, res) => {
  const row = await ownedProject(
    String(req.params.id),
    (await session(req)).id,
  );
  const { rows } = await db.query(
    "SELECT id,label,created_at FROM versions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50",
    [row.id],
  );
  res.json(rows);
});
app.post("/api/projects/:id/rollback", async (req, res) => {
  const row = await ownedProject(
    String(req.params.id),
    (await session(req)).id,
  );
  const { versionId, revision } = z
    .object({ versionId: z.string().uuid(), revision: z.number().int() })
    .parse(req.body);
  if (row.revision !== revision)
    throw new HttpError(409, "项目已更新，请重新载入");
  const { rows } = await db.query(
    "SELECT content FROM versions WHERE project_id=$1 AND id=$2",
    [row.id, versionId],
  );
  if (!rows[0]) throw new HttpError(404, "版本不存在");
  res.json(
    await publish(
      row,
      decrypt<Published>(rows[0].content).workspace,
      "回滚历史版本",
    ),
  );
});
app.post("/api/projects/:id/simulate", async (req, res) => {
  const row = await ownedProject(
    String(req.params.id),
    (await session(req)).id,
  );
  const { input } = z
    .object({ input: z.string().trim().min(1).max(300) })
    .parse(req.body);
  res.json(await simulate(projectView(row).draft, input));
});
app.get("/api/settings/ai", async (req, res) => {
  const user = await session(req);
  const { rows } = await db.query("SELECT ai FROM users WHERE id=$1", [
    user.id,
  ]);
  const settings = rows[0].ai ? decrypt<AISettings>(rows[0].ai) : undefined;
  res.json(
    settings
      ? { url: settings.url, model: settings.model, hasKey: !!settings.key }
      : { url: "https://api.openai.com/v1", model: "", hasKey: false },
  );
});
app.put("/api/settings/ai", async (req, res) => {
  const user = await session(req);
  const settings = aiSettingsSchema.parse(req.body);
  if (!settings.key) {
    const { rows } = await db.query("SELECT ai FROM users WHERE id=$1", [
      user.id,
    ]);
    if (rows[0].ai) settings.key = decrypt<AISettings>(rows[0].ai).key;
  }
  await db.query("UPDATE users SET ai=$1 WHERE id=$2", [
    encrypt(settings),
    user.id,
  ]);
  res.json({ ok: true });
});
app.post(
  "/api/projects/:id/ai",
  rateLimit({
    windowMs: 60_000,
    limit: 12,
    message: { error: "AI 请求过于频繁" },
  }),
  async (req, res) => {
    const user = await session(req);
    const row = await ownedProject(String(req.params.id), user.id);
    const input = z
      .object({
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().min(1).max(16000),
            }),
          )
          .min(1)
          .max(16),
        revision: z.number().int(),
      })
      .parse(req.body);
    if (input.revision !== row.revision)
      throw new HttpError(409, "项目已更新，请重新载入后生成提案");
    const { rows } = await db.query("SELECT ai FROM users WHERE id=$1", [
      user.id,
    ]);
    if (!rows[0].ai) throw new HttpError(400, "请先在设置中保存 AI 接口和模型");
    res.json({
      ...(await askAI(
        projectView(row).draft,
        decrypt<AISettings>(rows[0].ai),
        input.messages,
      )),
      revision: row.revision,
    });
  },
);

if (existsSync(resolve("dist"))) {
  app.use(express.static(resolve("dist"), { index: false }));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/s/"))
      return next();
    res.sendFile(resolve("dist/index.html"));
  });
}
app.use((_req, _res, next) => next(new HttpError(404, "页面或接口不存在")));
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: `输入格式不正确。${error.issues[0]?.message || ""}` });
    if (error.code === "23505")
      return res.status(409).json({ error: "该邮箱或记录已经存在" });
    res.status(error.status || 500).json({
      error:
        error instanceof HttpError
          ? error.message
          : "服务暂时无法完成请求，请检查配置或稍后重试",
    });
  },
);

await initDb();
const server = app.listen(
  Number(process.env.PORT) || 3000,
  process.env.HOST || "127.0.0.1",
  () =>
    console.log(
      `Clash Workbench API http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}`,
    ),
);
const timer = setInterval(() => {
  void refreshDueProjects().catch(() => {});
}, 60_000);
timer.unref();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    clearInterval(timer);
    server.close(() => {
      void closeDb().then(() => process.exit(0));
    });
  });
