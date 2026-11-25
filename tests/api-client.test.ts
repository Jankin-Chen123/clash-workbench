import { test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../client/api.js";

test("non-JSON proxy errors explain backend unavailability without replaying a POST", async (context) => {
  const mocked = context.mock.method(
    globalThis,
    "fetch",
    async () => new Response("", { status: 500 }),
  );
  await assert.rejects(
    api("/auth/login", "POST", {}),
    (error) =>
      error instanceof ApiError &&
      error.status === 500 &&
      error.message.includes("后台暂时无法连接"),
  );
  assert.equal(mocked.mock.callCount(), 1);
});

test("a successful HTTP response with invalid JSON rejects instead of returning an error object as data", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response("<html>unexpected page</html>", { status: 200 }),
  );
  await assert.rejects(
    api("/auth/login", "POST", {}),
    (error) =>
      error instanceof ApiError &&
      error.status === 200 &&
      error.message.includes("无法识别"),
  );
});

test("valid JSON authentication errors retain the server's explanation", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "邮箱或密码不正确" }, { status: 401 }),
  );
  await assert.rejects(
    api("/auth/login", "POST", {}),
    (error) =>
      error instanceof ApiError &&
      error.status === 401 &&
      error.message === "邮箱或密码不正确",
  );
});

test("valid JSON responses are returned to existing API callers", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ id: "user-fixture", admin: false }),
  );
  assert.deepEqual(await api("/me"), { id: "user-fixture", admin: false });
});
