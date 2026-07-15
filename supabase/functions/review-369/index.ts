// review-369: 真人评价。默认 action='submit' 是顾客提交（无需 PIN，但必须是订单主人且买过这件货）。
// 管理 action(modList/modSet/modDel) 是店主专用，用和 admin-369 同一套加固 PIN 校验。
// 评价晒图存公开桶 rev369（本就要公开展示）；表 anon 全锁死，店面只读公开视图 reviews_369_pub。
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
    const action = body.action || "submit";
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    // ===== 顾客：提交评价 =====
    if (action === "submit") {
      const ck = String(body.ck || ""), sid = Number(body.sid), pid = Number(body.pid);
      const rating = Math.max(1, Math.min(5, Math.floor(Number(body.rating) || 0)));
      if (ck.length < 8 || !pid || !rating) return json({ ok: false, error: "参数不对" }, 400);
      // 必须是订单主人 + 这单确实买过这件货
      const { data: o } = await supabase.from("orders_369").select("id,client_key,items,status,order_no").eq("id", sid).maybeSingle();
      if (!o || o.client_key !== ck) return json({ ok: false, error: "订单不存在或不属于你" }, 200);
      if (o.status === "已取消") return json({ ok: false, error: "已取消的订单不能评价" }, 200);
      const bought = Array.isArray(o.items) && o.items.some((it) => String(it && it.id) === String(pid));
      if (!bought) return json({ ok: false, error: "这单里没有这件货" }, 200);
      try { const { data: ok } = await supabase.rpc("rl_hit", { p_k: "rev:" + ck, p_lim: 12 }); if (ok === false) return json({ ok: false, error: "太频繁了，稍等再试" }, 200); } catch (_e) { /* ignore */ }

      const nickname = String(body.nickname || "").trim().slice(0, 20) || null;
      const text = String(body.body || "").trim().slice(0, 500) || null;
      let photoUrl = null;
      if (body.dataUrl) {
        const img = decodeImg(String(body.dataUrl));
        if (!img) return json({ ok: false, error: "晒图格式不对(png/jpg/webp)" }, 200);
        if (img.bytes.length > 3_000_000) return json({ ok: false, error: "图片太大(≤3MB)" }, 200);
        const path = pid + "-" + ck.slice(-6) + "-" + Date.now() + "." + img.ext;
        const { error: upErr } = await supabase.storage.from("rev369").upload(path, img.bytes, { contentType: img.contentType, upsert: true });
        if (upErr) return json({ ok: false, error: "晒图上传失败：" + upErr.message }, 200);
        const { data: pub } = supabase.storage.from("rev369").getPublicUrl(path);
        photoUrl = pub?.publicUrl || null;
      }

      const row = { product_id: pid, order_id: sid, client_key: ck, rating, body: text, photo: photoUrl, nickname, status: "shown", created_at: new Date().toISOString() };
      // 没传新图时保留旧图：先看有没有旧评价
      if (!photoUrl) {
        const { data: prev } = await supabase.from("reviews_369").select("photo").eq("product_id", pid).eq("client_key", ck).maybeSingle();
        if (prev && prev.photo) row.photo = prev.photo;
      }
      const { error } = await supabase.from("reviews_369").upsert(row, { onConflict: "product_id,client_key" });
      if (error) return json({ ok: false, error: error.message }, 500);
      try {
        const token = (await getSecret(supabase, "tg_bot_token")).trim(), chat = (await getSecret(supabase, "tg_owner_chat")).trim();
        if (token && chat) await tgSend(token, chat, "⭐ 订单 <b>" + esc(String(o.order_no || "#—")) + "</b> 给商品打了 <b>" + rating + "星</b>评价" + (text ? "：" + esc(text.slice(0, 60)) : "") + "。");
      } catch (_e) { /* ignore */ }
      return json({ ok: true }, 200);
    }

    // ===== 店主专用：PIN 加固校验 =====
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const gate = await adminAuth(supabase, ip, req.headers.get("x-admin-pin") || "");
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);

    if (action === "modList") {
      const { data, error } = await supabase.from("reviews_369")
        .select("id,product_id,rating,body,photo,nickname,status,created_at")
        .order("created_at", { ascending: false }).limit(60);
      if (error) return json({ ok: false, error: error.message }, 500);
      // 补商品名
      const ids = Array.from(new Set((data || []).map((r) => r.product_id)));
      const names = {};
      if (ids.length) {
        const { data: ps } = await supabase.from("products_369").select("id,name_cn").in("id", ids);
        (ps || []).forEach((p) => { names[p.id] = p.name_cn; });
      }
      return json({ ok: true, rows: (data || []).map((r) => ({ ...r, product_name: names[r.product_id] || ("#" + r.product_id) })) }, 200);
    }
    if (action === "modSet") {
      const id = Number(body.id), st = body.status === "hidden" ? "hidden" : "shown";
      if (!id) return json({ ok: false, error: "缺 id" }, 400);
      const { error } = await supabase.from("reviews_369").update({ status: st }).eq("id", id);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true }, 200);
    }
    if (action === "modDel") {
      const id = Number(body.id);
      if (!id) return json({ ok: false, error: "缺 id" }, 400);
      const { error } = await supabase.from("reviews_369").delete().eq("id", id);
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
async function tgSend(token, chat, text) { try { const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) }); return r.ok; } catch (_e) { return false; } }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function json(obj, status) { return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } }); }
