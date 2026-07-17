// ⚠️ 暂未启用 —— Supabase Auth 管理员鉴权(并行会话 2026-07-16 部署过的变体,已回退)。
// 它要求前端先用 supabase.auth 邮箱+密码登录,并在 public.admin_users 有成员行。
// 现状:线上前端与其余 6 个管理函数(camp/pay/review/push/account/feed)都走 x-admin-pin,
// 单独启用这一套会让后台面板 401。待未来一次性迁移全部函数+前端时再用。
// admin_users 表和 ahbee1023@gmail.com 的账号已在库里,不需要重建。
import type { SupabaseClient, User } from "npm:@supabase/supabase-js@2.110.6";

export type AdminAuthResult = {
  ok: boolean;
  user?: User;
  status?: number;
  error?: string;
};

/**
 * Validate the caller's current Supabase Auth access token and require an
 * explicit membership row in public.admin_users. The caller supplies the
 * service-role client only so the membership lookup cannot be affected by a
 * user's table privileges; the user JWT is still verified by GoTrue first.
 */
export async function requireAdmin(
  req: Request,
  supabase: SupabaseClient,
): Promise<AdminAuthResult> {
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { ok: false, status: 401, error: "请先登录管理员账号" };
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) {
    return { ok: false, status: 401, error: "登录已失效，请重新登录" };
  }

  const { data: adminRow, error: adminError } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (adminError) {
    console.error("Admin membership lookup failed", adminError.message);
    return { ok: false, status: 500, error: "无法验证管理员权限" };
  }
  if (!adminRow) {
    return { ok: false, status: 403, error: "此账号没有管理员权限" };
  }

  return { ok: true, user: authData.user };
}
