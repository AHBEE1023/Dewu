// pay-369: 付款闭环。默认 action='proof' 是顾客上传付款截图（必须是订单主人）。
// 其余 action(qrUpload/proofUrl/payConfirm)要求 Supabase Auth 管理员身份。
// 收款码 + 付款截图都存私有桶 pay369，anon 无 policy 完全锁死。
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
    const action = body.action || "proof";
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    // ===== 顾客：上传付款截图 =====
    if (action === "proof") {
      const sid = Number(body.sid), ck = String(body.ck || ""), dataUrl = String(body.dataUrl || "");
      if (!sid || ck.length < 8) return json({ ok: false, error: "参数不对" }, 400);
      const { data: o } = await supabase.from("orders_369").select("id,client_key,order_no").eq("id", sid).maybeSingle();
      if (!o || o.client_key !== ck) return json({ ok: false, error: "订单不存在或不属于你" }, 200);
      try { const { data: ok } = await supabase.rpc("rl_hit", { p_k: "pay:" + ck, p_lim: 10 }); if (ok === false) return json({ ok: false, error: "太频繁了，稍等再试" }, 200); } catch (_e) { /* ignore */ }
      const img = decodeImg(dataUrl);
      if (!img) return json({ ok: false, error: "请上传图片(png/jpg/webp)" }, 200);
      if (img.bytes.length > 3_000_000) return json({ ok: false, error: "图片太大(≤3MB)" }, 200);
      const path = "proof/" + sid + "-" + Date.now() + "." + img.ext;
      const { error: upErr } = await supabase.storage.from("pay369").upload(path, img.bytes, { contentType: img.contentType, upsert: true });
      if (upErr) return json({ ok: false, error: "上传失败：" + upErr.message }, 200);
      await supabase.from("orders_369").update({ pay_status: "待确认", pay_proof: path, pay_at: new Date().toISOString() }).eq("id", sid);
      try {
        const token = (await getSecret(supabase, "tg_bot_token")).trim(), chat = (await getSecret(supabase, "tg_owner_chat")).trim();
        if (token && chat) await tgSend(token, chat, "💳 订单 <b>" + esc(String(o.order_no || "#—")) + "</b> 上传了<b>付款凭证</b>，去后台「📦 顾客订单」核对确认收款。");
      } catch (_e) { /* ignore */ }
      return json({ ok: true }, 200);
    }

    // ===== 店主专用：Supabase Auth + admin_users =====
    const gate = await requireAdmin(req, supabase);
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status, cors);

    if (action === "qrUpload") {
      const img = decodeImg(String(body.dataUrl || ""));
      if (!img) return json({ ok: false, error: "请上传收款码图片(png/jpg/webp)" }, 200);
      if (img.bytes.length > 2_000_000) return json({ ok: false, error: "图片太大(≤2MB)" }, 200);
      const qpath = "qr/current." + img.ext;
      const { error: upErr } = await supabase.storage.from("pay369").upload(qpath, img.bytes, { contentType: img.contentType, upsert: true });
      if (upErr) return json({ ok: false, error: "上传失败：" + upErr.message }, 200);
      const { data: signed } = await supabase.storage.from("pay369").createSignedUrl(qpath, 31536000);
      await supabase.from("config_369").upsert({ key: "pay_qr_url", value: signed?.signedUrl || "", updated_at: new Date().toISOString() });
      if (body.note != null) await supabase.from("config_369").upsert({ key: "pay_note", value: String(body.note).slice(0, 300), updated_at: new Date().toISOString() });
      return json({ ok: true, url: signed?.signedUrl }, 200);
    }
    if (action === "proofUrl") {
      const { data: o } = await supabase.from("orders_369").select("pay_proof").eq("id", Number(body.sid)).maybeSingle();
      if (!o || !o.pay_proof) return json({ ok: false, error: "这单还没有付款凭证" }, 200);
      const { data: signed } = await supabase.storage.from("pay369").createSignedUrl(o.pay_proof, 3600);
      return json({ ok: true, url: signed?.signedUrl }, 200);
    }
    if (action === "payConfirm") {
      const { error } = await supabase.from("orders_369").update({ pay_status: "已确认" }).eq("id", Number(body.sid));
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true }, 200);
    }
    return json({ ok: false, error: "未知 action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 200);
  }
});

function decodeImg(dataUrl) {
  const m = dataUrl.match(/^data:(image\/(png|jpe?g|webp));base64,([\s\S]+)$/);
  if (!m) return null;
  const contentType = m[1], ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  let bytes; try { bytes = Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)); } catch (_e) { return null; }
  return { contentType, ext, bytes };
}
async function getSecret(supabase, key) { const { data } = await supabase.from("app_secrets_369").select("value").eq("key", key).maybeSingle(); return (data && data.value) ? String(data.value) : ""; }
async function tgSend(token, chat, text) { try { const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) }); return r.ok; } catch (_e) { return false; } }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function json(obj, status, c = cors) { return new Response(JSON.stringify(obj), { status, headers: { ...c, "Content-Type": "application/json" } }); }
