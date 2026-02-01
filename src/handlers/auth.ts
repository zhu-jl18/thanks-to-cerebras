import { jsonResponse, problemResponse } from "../http.ts";
import { getErrorMessage } from "../utils.ts";
import {
  createAdminToken,
  deleteAdminToken,
  getAdminPassword,
  setAdminPassword,
  verifyAdminPassword,
  verifyAdminToken,
} from "../auth.ts";

export async function handleAuthRoutes(
  req: Request,
  path: string,
): Promise<Response | null> {
  if (!path.startsWith("/api/auth/")) return null;

  if (req.method === "GET" && path === "/api/auth/status") {
    const hasPassword = (await getAdminPassword()) !== null;
    const token = req.headers.get("X-Admin-Token");
    const isLoggedIn = await verifyAdminToken(token);
    return jsonResponse({ hasPassword, isLoggedIn });
  }

  if (req.method === "POST" && path === "/api/auth/setup") {
    const hasPassword = (await getAdminPassword()) !== null;
    if (hasPassword) {
      return problemResponse("密码已设置", { status: 400, instance: path });
    }
    try {
      const { password } = await req.json();
      if (!password || password.length < 4) {
        return problemResponse("密码至少 4 位", {
          status: 400,
          instance: path,
        });
      }
      await setAdminPassword(password);
      const token = await createAdminToken();
      return jsonResponse({ success: true, token });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path,
      });
    }
  }

  if (req.method === "POST" && path === "/api/auth/login") {
    try {
      const { password } = await req.json();
      const valid = await verifyAdminPassword(password);
      if (!valid) {
        return problemResponse("密码错误", { status: 401, instance: path });
      }
      const token = await createAdminToken();
      return jsonResponse({ success: true, token });
    } catch (error) {
      return problemResponse(getErrorMessage(error), {
        status: 400,
        instance: path,
      });
    }
  }

  if (req.method === "POST" && path === "/api/auth/logout") {
    const token = req.headers.get("X-Admin-Token");
    if (token) {
      await deleteAdminToken(token);
    }
    return jsonResponse({ success: true });
  }

  return problemResponse("Not Found", { status: 404, instance: path });
}
