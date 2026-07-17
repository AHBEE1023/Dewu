// camp-369: 拼团管理（Supabase Auth 管理员专用）。开团/结团/列出。
// 店面读当前活跃团直接走 REST(anon 可读 active 行)，不经过这里。
import { createClient } from "npm:@supabase/supabase-js@2.110.6";
import { requireAdmin } from "../_shared/admin-auth.ts";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body: any = await req.json().catch(() => ({}));
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const gate = await requireAdmin(req, supabase);
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

function json(obj, status) { return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } }); }
