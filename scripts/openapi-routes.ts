export type Route = {
  method: string;
  path: string;
};

export const EXPECTED_ROUTES: Route[] = [
  { method: "get", path: "/" },
  { method: "get", path: "/healthz" },
  { method: "get", path: "/readyz" },
  { method: "get", path: "/v1/models" },
  { method: "post", path: "/v1/chat/completions" },
  { method: "get", path: "/api/auth/status" },
  { method: "post", path: "/api/auth/setup" },
  { method: "post", path: "/api/auth/login" },
  { method: "post", path: "/api/auth/logout" },
  { method: "post", path: "/api/auth/reset-password" },
  { method: "get", path: "/api/keys" },
  { method: "post", path: "/api/keys" },
  { method: "post", path: "/api/keys/batch" },
  { method: "get", path: "/api/keys/export" },
  { method: "delete", path: "/api/keys/{id}" },
  { method: "get", path: "/api/keys/{id}/export" },
  { method: "post", path: "/api/keys/{id}/test" },
  { method: "get", path: "/api/proxy-keys" },
  { method: "post", path: "/api/proxy-keys" },
  { method: "post", path: "/api/proxy-keys/migrate" },
  { method: "delete", path: "/api/proxy-keys/{id}" },
  { method: "get", path: "/api/proxy-keys/{id}/export" },
  { method: "get", path: "/api/models/catalog" },
  { method: "post", path: "/api/models/catalog/refresh" },
  { method: "get", path: "/api/models" },
  { method: "put", path: "/api/models" },
  { method: "post", path: "/api/models/{name}/test" },
  { method: "get", path: "/api/stats" },
  { method: "get", path: "/api/config" },
  { method: "patch", path: "/api/config" },
  { method: "get", path: "/api/metrics" },
  { method: "get", path: "/api/diagnostics" },
];
