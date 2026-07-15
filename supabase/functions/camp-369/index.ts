// camp-369: 拼团管理(店主专用，加固 PIN 校验)。开团/结团/列出。
// 店面读当前活跃团直接走 REST(anon 可读 active 行)，不经过这里。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PIN = Deno.env.get("ADMIN_PIN_369") || "3690";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const gate = await adminAuth(supabase, ip, req.headers.get("x-admin-pin") || "");
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);

    if (body.action === "campList") {
      const { data, error } = await supabase.from("campaigns_369").select("*").order("created_at", { ascending: false }).limit(20);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, rows: data }, 200);
    }
    if (body.action === "campNew") {
      const title = String(body.title || "").trim().slice(0, 40);
      if (!title) return json({ ok: false, error: "请填团名(如：本周日本团)" }, 200);
      const blurb = String(body.blurb || "").trim().slice(0, 120) || null;
      const target = body.target != null && Number.isFinite(Number(body.target)) ? Math.max(0, Math.floor(Number(body.target))) : null;
      let deadline = null;
      if (body.deadline) { const d = new Date(body.deadline); if (!isNaN(d.getTime())) deadline = d.toISOString(); }
      await supabase.from("campaigns_369").update({ active: false }).eq("active", true); // 一次只挂一个团
      const { data, error } = await supabase.from("campaigns_369").insert({ title, blurb, target, deadline, active: true }).select().single();
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, row: data }, 200);
    }
    if (body.action === "campEnd") {
      const id = Number(body.id);
      if (!id) return json({ ok: false, error: "缺 id" }, 400);
      const { error } = await supabase.from("campaigns_369").update({ active: false }).eq("id", id);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true }, 200);
    }
    return json({ ok: false, error: "未知 action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 200);
  }
});

async function adminAuth(supabase, ip, pin) {
  const { data: row } = await supabase.from("admin_attempts_369").select("*").eq("ip", ip).maybeSingle();
  const now = Date.now();
  if (row && row.locked_until && new Date(row.locked_until).getTime() > now) return { ok: false, status: 429, error: "尝试太多，稍后再试" };
  const storedHash = (await getSecret(supabase, "admin_pin_hash")).trim();
  const valid = pin ? (storedHash ? (await sha256hex(pin)) === storedHash : pin === PIN) : false;
  if (valid) { if (row && row.fails > 0) await supabase.from("admin_attempts_369").upsert({ ip, fails: 0, locked_until: null, updated_at: new Date().toISOString() }); return { ok: true, status: 200 }; }
  const fails = (row ? row.fails : 0) + 1;
  await supabase.from("admin_attempts_369").upsert({ ip, fails, updated_at: new Date().toISOString(), locked_until: fails >= 5 ? new Date(now + 600000).toISOString() : null });
  return { ok: false, status: fails >= 5 ? 429 : 401, error: fails >= 5 ? "错误太多，已锁定 10 分钟" : "密码不对" };
}
async function sha256hex(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(""); }
async function getSecret(supabase, key) { const { data } = await supabase.from("app_secrets_369").select("value").eq("key", key).maybeSingle(); return (data && data.value) ? String(data.value) : ""; }
function json(obj, status) { return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } }); }
