import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stringify } from "yaml";

test(
  "account isolation, import, publish, refresh protection, token revocation and rollback through HTTP",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "clash-api-test-"));
    let nodes = [
      { name: "上游 A", type: "socks5", server: "192.0.2.10", port: 1080 },
      { name: "上游 B", type: "socks5", server: "192.0.2.20", port: 1080 },
    ];
    let aiRequest: any;
    const upstream = createServer((req, res) => {
      if (req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          aiRequest = JSON.parse(body);
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: "新增 GitHub 直连",
                      rules: [
                        "DOMAIN-SUFFIX,github.com,DIRECT",
                        "MATCH,代理选择",
                      ],
                      groups: [],
                    }),
                  },
                },
              ],
            }),
          );
        });
      } else {
        res.setHeader("content-type", "application/yaml");
        res.end(stringify({ proxies: nodes }));
      }
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const upstreamPort = (upstream.address() as any).port;
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
    const port = (reservation.address() as any).port;
    await new Promise<void>((done) => reservation.close(() => done()));
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts"],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "127.0.0.1",
          DATA_DIR: directory,
          DATABASE_URL: "",
          ENCRYPTION_KEY: randomBytes(32).toString("hex"),
          PUBLIC_URL: origin,
          TRUSTED_FETCH_HOSTS: "127.0.0.1",
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    let cookie = "";
    async function call(
      path: string,
      method = "GET",
      body?: any,
      token = cookie,
    ) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          cookie: token,
          origin,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return {
        status: response.status,
        data,
        cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
      };
    }
    try {
      const ready = await new Promise<boolean>((done) => {
        const deadline = setTimeout(() => {
          clearInterval(poll);
          done(false);
        }, 30_000);
        const poll = setInterval(() => {
          void fetch(`${origin}/api/health`)
            .then((response) => {
              if (response.ok) {
                clearTimeout(deadline);
                clearInterval(poll);
                done(true);
              }
            })
            .catch(() => {});
        }, 250);
      });
      assert.equal(ready, true, output);
      const admin = await call("/api/auth/register", "POST", {
        email: "admin@example.test",
        password: "test-password-123",
      });
      assert.equal(admin.status, 200, JSON.stringify(admin.data));
      cookie = admin.cookie;
      assert.equal(admin.data.admin, true);
      let project = (await call("/api/projects", "POST", { name: "验收项目" }))
        .data;
      assert.ok(project.id);
      const imported = await call(
        `/api/projects/${project.id}/import`,
        "POST",
        {
          name: "测试来源",
          url: `http://127.0.0.1:${upstreamPort}/subscription`,
          revision: project.revision,
        },
      );
      assert.equal(imported.status, 200, JSON.stringify(imported.data));
      project = imported.data.project;
      assert.equal(project.draft.nodes.length, 2);
      // Pin one member, modelling a user's explicit choice alongside the dynamic source pool.
      project.draft.groups[0].members.push(project.draft.nodes[1].id);
      project = (
        await call(`/api/projects/${project.id}`, "PUT", {
          workspace: project.draft,
          revision: project.revision,
        })
      ).data;
      const checked = await call(
        `/api/projects/${project.id}/check`,
        "POST",
        {},
      );
      assert.equal(
        checked.data.coreChecked,
        true,
        JSON.stringify(checked.data),
      );
      const published = await call(
        `/api/projects/${project.id}/publish`,
        "POST",
        { revision: project.revision },
      );
      assert.equal(published.status, 200, JSON.stringify(published.data));
      project = published.data.project;
      const originalSubscription = await fetch(project.subscriptionUrl).then(
        (response) => response.text(),
      );
      assert.match(originalSubscription, /上游 A/);
      const firstVersion = (await call(`/api/projects/${project.id}/versions`))
        .data[0].id;
      // A draft-only rule must stay out of the auto-refreshed published snapshot.
      project.draft.rules.unshift({
        id: "draft-only",
        text: "DOMAIN,draft-only.test,REJECT",
        enabled: true,
      });
      project = (
        await call(`/api/projects/${project.id}`, "PUT", {
          workspace: project.draft,
          revision: project.revision,
        })
      ).data;
      nodes = nodes.map((node) => ({ ...node, name: `${node.name} 改名` }));
      const refreshed = await call(
        `/api/projects/${project.id}/refresh`,
        "POST",
        {},
      );
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
      project = refreshed.data;
      assert.equal(project.draft.nodes[0].name, "上游 A");
      const afterRename = await fetch(project.subscriptionUrl).then(
        (response) => response.text(),
      );
      assert.ok(!afterRename.includes("draft-only.test"));
      assert.equal(afterRename, originalSubscription);
      // Removing a fixed member prevents publication of a broken subscription.
      nodes = [nodes[0]];
      project = (await call(`/api/projects/${project.id}/refresh`, "POST", {}))
        .data;
      assert.match(project.publishError, /缺失/);
      assert.equal(
        await fetch(project.subscriptionUrl).then((response) =>
          response.text(),
        ),
        originalSubscription,
      );
      // Retry a stale save without overwriting another editor's revision.
      assert.equal(
        (
          await call(`/api/projects/${project.id}`, "PUT", {
            workspace: project.draft,
            revision: 1,
          })
        ).status,
        409,
      );
      const rollback = await call(
        `/api/projects/${project.id}/rollback`,
        "POST",
        { versionId: firstVersion, revision: project.revision },
      );
      assert.equal(rollback.status, 200, JSON.stringify(rollback.data));
      project = rollback.data.project;
      assert.equal(
        await fetch(project.subscriptionUrl).then((response) =>
          response.text(),
        ),
        originalSubscription,
      );
      const oldUrl = project.subscriptionUrl;
      project = (
        await call(`/api/projects/${project.id}/token`, "POST", {
          action: "rotate",
        })
      ).data;
      assert.equal((await fetch(oldUrl)).status, 404);
      assert.equal((await fetch(project.subscriptionUrl)).status, 200);
      await call(`/api/projects/${project.id}/token`, "POST", {
        action: "revoke",
      });
      assert.equal((await fetch(project.subscriptionUrl)).status, 404);
      // A model fixture validates API integration and context minimisation without a paid model call.
      assert.equal(
        (
          await call("/api/settings/ai", "PUT", {
            url: `http://127.0.0.1:${upstreamPort}/v1`,
            key: "model-test-secret",
            model: "fixture",
          })
        ).status,
        200,
      );
      const aiSettings = await call("/api/settings/ai");
      assert.equal(aiSettings.data.key, undefined);
      assert.equal(aiSettings.data.hasKey, true);
      // Recover draft after removal and request a proposal.
      nodes.push({
        name: "上游 B",
        type: "socks5",
        server: "192.0.2.20",
        port: 1080,
      });
      project = (await call(`/api/projects/${project.id}/refresh`, "POST", {}))
        .data;
      const ai = await call(`/api/projects/${project.id}/ai`, "POST", {
        revision: project.revision,
        messages: [{ role: "user", content: "GitHub 直连" }],
      });
      assert.equal(ai.status, 200, JSON.stringify(ai.data));
      assert.equal(
        ai.data.proposal.rules[0],
        "DOMAIN-SUFFIX,github.com,DIRECT",
      );
      const modelInput = JSON.stringify(aiRequest);
      assert.ok(!modelInput.includes("192.0.2.10"));
      assert.ok(!modelInput.includes("/subscription"));
      assert.ok(!modelInput.includes("model-test-secret"));
      const invitation = (await call("/api/invitations", "POST", {})).data.code;
      const other = await call("/api/auth/register", "POST", {
        email: "other@example.test",
        password: "test-password-456",
        invitation,
      });
      assert.equal(other.status, 200, JSON.stringify(other.data));
      assert.equal(
        (
          await call(
            `/api/projects/${project.id}`,
            "GET",
            undefined,
            other.cookie,
          )
        ).status,
        404,
      );
      assert.deepEqual(
        (await call("/api/projects", "GET", undefined, other.cookie)).data,
        [],
      );
      assert.equal(
        (await call("/api/invitations", "POST", {}, other.cookie)).status,
        403,
      );
      assert.equal(
        (
          await call("/api/auth/register", "POST", {
            email: "third@example.test",
            password: "test-password-789",
            invitation,
          })
        ).status,
        400,
      );
      const forged = await fetch(`${origin}/api/projects`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "forged" }),
      });
      assert.equal(forged.status, 403);
    } finally {
      child.kill();
      await new Promise<void>((done) => {
        if (child.exitCode !== null) done();
        else {
          child.once("exit", () => done());
          setTimeout(done, 5000).unref();
        }
      });
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  },
);
