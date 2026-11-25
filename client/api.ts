export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
  attempt = 0,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    if (method === "GET" && attempt < 2) {
      await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
      return api(path, method, body, attempt + 1);
    }
    throw new ApiError(0, "无法连接工作台服务");
  }
  if (response.status >= 500 && method === "GET" && attempt < 2) {
    await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
    return api(path, method, body, attempt + 1);
  }
  const data = await response
    .json()
    .catch(() => ({ error: "服务响应异常，请稍后重试" }));
  if (!response.ok)
    throw new ApiError(response.status, data.error || "请求失败");
  return data;
}
