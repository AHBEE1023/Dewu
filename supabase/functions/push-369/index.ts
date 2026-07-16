// push-369: Web Push（到货提醒）。VAPID 密钥自管在 app_secrets(vapid_jwk)。
//  - pubkey(无鉴权)：给前端订阅用的 applicationServerKey
//  - subscribe/unsubscribe(顾客)：存/删本设备订阅
//  - send(服务器专用)：admin-369 改状态时用 service_role key 调用，推给该顾客
//  - genKeys/test(Supabase Auth 管理员)：首次生成密钥 / 给自己发测试推送
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { createClient } from "npm:@supabase/supabase-js@2.110.6";
import { requireAdmin } from "../_shared/admin-auth.ts";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "subscribe";
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), SERVICE_KEY);

    // ---- 前端拿公钥（无鉴权）----
    if (action === "pubkey") {
      const jwk = (await getSecret(supabase, "vapid_jwk")).trim();
      if (!jwk) return json({ ok: false, error: "推送未初始化" }, 200);
      try { return json({ ok: true, key: appServerKey(JSON.parse(jwk)) }, 200); }
      catch (_e) { return json({ ok: false, error: "密钥损坏" }, 200); }
    }

    // ---- 顾客：订阅本设备 ----
    if (action === "subscribe") {
      const ck = String(body.ck || ""), sub = body.sub;
      if (ck.length < 8 || !sub || !sub.endpoint) return json({ ok: false, error: "参数不对" }, 400);
      try { const { data: ok } = await supabase.rpc("rl_hit", { p_k: "push:" + ck, p_lim: 20 }); if (ok === false) return json({ ok: false, error: "太频繁了" }, 200); } catch (_e) { /* ignore */ }
      const { error } = await supabase.from("push_subs_369").upsert({ client_key: ck, endpoint: sub.endpoint, sub, created_at: new Date().toISOString() }, { onConflict: "endpoint" });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true }, 200);
    }
    if (action === "unsubscribe") {
      const ep = String(body.endpoint || "");
      if (ep) await supabase.from("push_subs_369").delete().eq("endpoint", ep);
      return json({ ok: true }, 200);
    }

    // ---- 服务器专用：改状态时推送（admin-369 用 service_role key 调用）----
    if (action === "send") {
      const auth = req.headers.get("authorization") || "";
      if (!SERVICE_KEY || auth !== "Bearer " + SERVICE_KEY) return json({ ok: false, error: "forbidden" }, 403);
      const sent = await sendToCk(supabase, String(body.ck || ""), { title: body.title, body: body.body, url: body.url });
      return json({ ok: true, sent }, 200);
    }

    // ---- 店主专用：Supabase Auth + admin_users ----
    const gate = await requireAdmin(req, supabase);
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);

    if (action === "genKeys") {
      const existing = (await getSecret(supabase, "vapid_jwk")).trim();
      if (existing) { try { return json({ ok: true, key: appServerKey(JSON.parse(existing)), existed: true }, 200); } catch (_e) { /* regenerate below */ } }
      const keys = await webpush.generateVapidKeys({ extractable: true });
      const exported = await webpush.exportVapidKeys(keys);
      await supabase.from("app_secrets_369").upsert({ key: "vapid_jwk", value: JSON.stringify(exported), updated_at: new Date().toISOString() });
      return json({ ok: true, key: appServerKey(exported) }, 200);
    }
    if (action === "test") {
      const sent = await sendToCk(supabase, String(body.ck || ""), { title: "🔔 369 甄选", body: "推送已接通！以后订单有进度会第一时间提醒你。", url: "/" });
      return json({ ok: true, sent }, 200);
    }
    if (action === "status") {
      const { count } = await supabase.from("push_subs_369").select("*", { count: "exact", head: true });
      const hasKeys = !!(await getSecret(supabase, "vapid_jwk")).trim();
      return json({ ok: true, hasKeys, subs: count || 0 }, 200);
    }
    return json({ ok: false, error: "未知 action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 200);
  }
});

// 给某个顾客的所有设备推送；顺手清掉失效订阅（410/404）
async function sendToCk(supabase, ck, payload) {
  if (!ck || ck.length < 8) return 0;
  const jwk = (await getSecret(supabase, "vapid_jwk")).trim();
  if (!jwk) return 0;
  const contact = (await getSecret(supabase, "push_contact")).trim() || "mailto:owner@369.example";
  let appServer;
  try {
    const imported = await webpush.importVapidKeys(JSON.parse(jwk), { extractable: false });
    appServer = await webpush.ApplicationServer.new({ contactInformation: contact, vapidKeys: imported });
  } catch (_e) { return 0; }
  const { data: subs } = await supabase.from("push_subs_369").select("endpoint,sub").eq("client_key", ck);
  if (!subs || !subs.length) return 0;
  const text = JSON.stringify({ title: payload.title || "369 甄选", body: payload.body || "", url: payload.url || "/" });
  let sent = 0;
  for (const s of subs) {
    try {
      const subscriber = appServer.subscribe(s.sub);
      await subscriber.pushTextMessage(text, { ttl: 3600 });
      sent++;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/410|404|gone|not found/i.test(msg)) { try { await supabase.from("push_subs_369").delete().eq("endpoint", s.endpoint); } catch (_e) { /* ignore */ } }
    }
  }
  return sent;
}

// JWK 公钥 -> 浏览器 applicationServerKey（base64url 的 0x04||X||Y）
function appServerKey(exported) {
  const pub = exported.publicKey || exported;
  const x = b64urlToBytes(pub.x), y = b64urlToBytes(pub.y);
  const raw = new Uint8Array(65); raw[0] = 4; raw.set(x, 1); raw.set(y, 33);
  return bytesToB64url(raw);
}
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function getSecret(supabase, key) { const { data } = await supabase.from("app_secrets_369").select("value").eq("key", key).maybeSingle(); return (data && data.value) ? String(data.value) : ""; }
function json(obj, status) { return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } }); }
