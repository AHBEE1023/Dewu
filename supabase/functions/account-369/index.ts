// account-369: 轻量账号（手机号 + 自设密码）。账号认领一个 client_key，登录即在新设备恢复同一份历史。
//  顾客：register / login / me / updateProfile / changePassword（都无需 PIN，靠密码 + 限速）
//  店主(PIN)：adminList（看账号）/ adminReset（协助重置密码，因为无短信/邮箱找回）
// 密码用 PBKDF2-SHA256 慢哈希 + 随机盐。表 anon 全锁死，只走这里。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PIN = Deno.env.get("ADMIN_PIN_369") || "3690";
const ITERS = 100000;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

    if (action === "register") {
      const phone = normPhone(body.phone), pw = String(body.password || ""), ck = String(body.ck || "");
      if (!phone) return json({ ok: false, error: "手机号填 8–15 位数字" }, 200);
      if (pw.length < 6 || pw.length > 64) return json({ ok: false, error: "密码 6–64 位" }, 200);
      if (ck.length < 8) return json({ ok: false, error: "设备身份异常，刷新重试" }, 200);
      if (await rlBlocked(supabase, "acct:" + ip, 20)) return json({ ok: false, error: "太频繁了，稍后再试" }, 200);
      const { data: exist } = await supabase.from("accounts_369").select("id").eq("phone", phone).maybeSingle();
      if (exist) return json({ ok: false, error: "这个手机号已注册，直接登录吧" }, 200);
      const { data: ckOwned } = await supabase.from("accounts_369").select("id").eq("client_key", ck).maybeSingle();
      if (ckOwned) return json({ ok: false, error: "这台设备已注册过账号" }, 200);
      const salt = randHex(16), hash = await pbkdf2(pw, salt, ITERS);
      const nickname = String(body.nickname || "").trim().slice(0, 20) || null;
      const { data, error } = await supabase.from("accounts_369").insert({
        phone, pass_hash: hash, salt, iters: ITERS, client_key: ck, nickname, last_login: new Date().toISOString(),
      }).select("client_key,phone,nickname,recipient,addr_phone,address").single();
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, account: data }, 200);
    }

    if (action === "login") {
      const phone = normPhone(body.phone), pw = String(body.password || ""), deviceCk = String(body.ck || "");
      if (!phone || !pw) return json({ ok: false, error: "手机号 / 密码不能空" }, 200);
      if (await rlBlocked(supabase, "acctlogin:" + ip, 30)) return json({ ok: false, error: "尝试太多，稍后再试" }, 200);
      const { data: acc } = await supabase.from("accounts_369").select("*").eq("phone", phone).maybeSingle();
      if (!acc) return json({ ok: false, error: "手机号或密码不对" }, 200);
      const ok = (await pbkdf2(pw, acc.salt, acc.iters || ITERS)) === acc.pass_hash;
      if (!ok) return json({ ok: false, error: "手机号或密码不对" }, 200);
      // 把本设备匿名历史并进账号（不丢单）：只并订单 + 推送订阅，避免评价唯一键冲突
      if (deviceCk && deviceCk.length >= 8 && deviceCk !== acc.client_key) {
        try { await supabase.from("orders_369").update({ client_key: acc.client_key }).eq("client_key", deviceCk); } catch (_e) { /* ignore */ }
        try { await supabase.from("push_subs_369").update({ client_key: acc.client_key }).eq("client_key", deviceCk); } catch (_e) { /* ignore */ }
      }
      await supabase.from("accounts_369").update({ last_login: new Date().toISOString() }).eq("id", acc.id);
      return json({ ok: true, account: pick(acc) }, 200);
    }

    if (action === "me") {
      const ck = String(body.ck || "");
      if (ck.length < 8) return json({ ok: false, error: "参数不对" }, 200);
      const { data: acc } = await supabase.from("accounts_369").select("*").eq("client_key", ck).maybeSingle();
      if (!acc) return json({ ok: true, account: null }, 200);
      return json({ ok: true, account: pick(acc) }, 200);
    }

    if (action === "updateProfile") {
      const ck = String(body.ck || "");
      if (ck.length < 8) return json({ ok: false, error: "请先登录" }, 200);
      if (await rlBlocked(supabase, "acctupd:" + ck, 30)) return json({ ok: false, error: "太频繁了" }, 200);
      const fields = {};
      if (body.nickname != null) fields.nickname = String(body.nickname).trim().slice(0, 20) || null;
      if (body.recipient != null) fields.recipient = String(body.recipient).trim().slice(0, 40) || null;
      if (body.addr_phone != null) fields.addr_phone = normPhone(body.addr_phone) || null;
      if (body.address != null) fields.address = String(body.address).trim().slice(0, 300) || null;
      if (!Object.keys(fields).length) return json({ ok: false, error: "没有可改内容" }, 200);
      const { data, error } = await supabase.from("accounts_369").update(fields).eq("client_key", ck).select("client_key,phone,nickname,recipient,addr_phone,address").maybeSingle();
      if (error) return json({ ok: false, error: error.message }, 500);
      if (!data) return json({ ok: false, error: "账号不存在，请重新登录" }, 200);
      return json({ ok: true, account: data }, 200);
    }

    if (action === "changePassword") {
      const ck = String(body.ck || ""), oldPw = String(body.oldPassword || ""), newPw = String(body.newPassword || "");
      if (ck.length < 8) return json({ ok: false, error: "请先登录" }, 200);
      if (newPw.length < 6 || newPw.length > 64) return json({ ok: false, error: "新密码 6–64 位" }, 200);
      if (await rlBlocked(supabase, "acctpw:" + ck, 12)) return json({ ok: false, error: "太频繁了" }, 200);
      const { data: acc } = await supabase.from("accounts_369").select("*").eq("client_key", ck).maybeSingle();
      if (!acc) return json({ ok: false, error: "账号不存在" }, 200);
      if ((await pbkdf2(oldPw, acc.salt, acc.iters || ITERS)) !== acc.pass_hash) return json({ ok: false, error: "原密码不对" }, 200);
      const salt = randHex(16), hash = await pbkdf2(newPw, salt, ITERS);
      await supabase.from("accounts_369").update({ pass_hash: hash, salt, iters: ITERS }).eq("id", acc.id);
      return json({ ok: true }, 200);
    }

    // ===== 店主专用：PIN 加固 =====
    const gate = await adminAuth(supabase, ip, req.headers.get("x-admin-pin") || "");
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status);

    if (action === "adminList") {
      const { data: accs } = await supabase.from("accounts_369")
        .select("id,phone,nickname,recipient,addr_phone,address,client_key,created_at,last_login")
        .order("created_at", { ascending: false }).limit(200);
      // 每个账号统计下单数
      const cks = (accs || []).map((a) => a.client_key);
      const counts = {};
      if (cks.length) {
        const { data: ords } = await supabase.from("orders_369").select("client_key").in("client_key", cks);
        (ords || []).forEach((o) => { counts[o.client_key] = (counts[o.client_key] || 0) + 1; });
      }
      return json({ ok: true, rows: (accs || []).map((a) => ({ ...a, orders: counts[a.client_key] || 0 })) }, 200);
    }
    if (action === "adminReset") {
      const phone = normPhone(body.phone), newPw = String(body.newPassword || "");
      if (!phone || newPw.length < 6) return json({ ok: false, error: "手机号 + 新密码(≥6位)" }, 200);
      const salt = randHex(16), hash = await pbkdf2(newPw, salt, ITERS);
      const { data, error } = await supabase.from("accounts_369").update({ pass_hash: hash, salt, iters: ITERS }).eq("phone", phone).select("id").maybeSingle();
      if (error) return json({ ok: false, error: error.message }, 500);
      if (!data) return json({ ok: false, error: "没有这个手机号的账号" }, 200);
      return json({ ok: true }, 200);
    }
    return json({ ok: false, error: "未知 action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 200);
  }
});

function pick(a) { return { client_key: a.client_key, phone: a.phone, nickname: a.nickname, recipient: a.recipient, addr_phone: a.addr_phone, address: a.address }; }
function normPhone(v) { const d = String(v || "").replace(/[^\d]/g, ""); return (d.length >= 8 && d.length <= 15) ? d : ""; }
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
async function pbkdf2(password, saltHex, iters) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(saltHex), iterations: iters, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function rlBlocked(supabase, k, lim) {
  try { const { data } = await supabase.rpc("rl_hit", { p_k: k, p_lim: lim }); return data === false; } catch (_e) { return false; }
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
function json(obj, status) { return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } }); }
