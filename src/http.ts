import { CORS_HEADERS, NO_CACHE_HEADERS } from "./constants.ts";

export function jsonResponse(
  data: unknown,
  options: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers({
    ...CORS_HEADERS,
    ...NO_CACHE_HEADERS,
    "Content-Type": "application/json",
  });

  if (options.headers) {
    new Headers(options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    headers,
  });
}

export function jsonError(
  message: string,
  status = 400,
  headers?: HeadersInit,
): Response {
  return jsonResponse({ error: message }, { status, headers });
}

export function problemTitle(status: number): string {
  if (status >= 500) return "服务器错误";

  switch (status) {
    case 400:
      return "请求错误";
    case 401:
      return "未授权";
    case 403:
      return "禁止访问";
    case 404:
      return "未找到";
    case 409:
      return "冲突";
    case 429:
      return "请求过多";
    default:
      return "请求失败";
  }
}

export function problemResponse(
  detail: string,
  options: {
    status?: number;
    title?: string;
    type?: string;
    instance?: string;
    headers?: HeadersInit;
  } = {},
): Response {
  const status = options.status ?? 400;
  const headers = new Headers({ "Content-Type": "application/problem+json" });

  if (options.headers) {
    new Headers(options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return jsonResponse(
    {
      type: options.type ?? "about:blank",
      title: options.title ?? problemTitle(status),
      status,
      detail,
      ...(options.instance ? { instance: options.instance } : {}),
    },
    { status, headers },
  );
}
