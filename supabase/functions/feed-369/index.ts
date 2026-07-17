// feed-369: 到货动态(店主发布端,加固 PIN 校验)。发贴/列表/下架 + 可选同步商品库存。
// 店面读动态直接走 REST(anon 可读 active 行),不经过这里。
// 照片沿用 product-369 桶的既有上传通道(前端直传,前缀 fd),这里只收公开 URL 并校验来源。
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

    if (body.action === "postList") {
      const { data, error } = await supabase.from("posts_369").select("*").order("created_at", { ascending: false }).limit(30);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, rows: data }, 200);
    }

    if (body.action === "postNew") {
      const text = String(body.text || "").trim().slice(0, 300);
      if (!text) return json({ ok: false, error: "写一句到货说明(如：Jellycat 巴塞罗熊到了 3 只)" }, 200);
      // 照片必须是本项目 storage 的公开 URL,防注入
      const pubPrefix = Deno.env.get("SUPABASE_URL") + "/storage/v1/object/public/";
      const photos = (Array.isArray(body.photos) ? body.photos : [])
        .map((u) => String(u || "").trim())
        .filter((u) => u.startsWith(pubPrefix) && u.length < 300)
        .slice(0, 4);

      let product_id = null, pname = null, pprice = null;
      if (body.product_id != null && Number.isFinite(Number(body.product_id))) {
        const pid = Math.floor(Number(body.product_id));
        const { data: p } = await supabase.from("products_369").select("id,name_cn,sell_myr").eq("id", pid).maybeSingle();
        if (!p) return json({ ok: false, error: "找不到这个商品" }, 200);
        product_id = p.id; pname = p.name_cn; pprice = p.sell_myr;
        // 可选:把本次到货同步为现货库存(null/缺省=不动)
        if (body.stock != null && Number.isFinite(Number(body.stock))) {
          const stock = Math.max(0, Math.floor(Number(body.stock)));
          const { error: se } = await supabase.from("products_369").update({ stock }).eq("id", pid);
          if (se) return json({ ok: false, error: "库存同步失败:" + se.message }, 500);
        }
      }
      const qty = body.qty != null && Number.isFinite(Number(body.qty)) ? Math.max(0, Math.floor(Number(body.qty))) : null;

      const { data, error } = await supabase.from("posts_369")
        .insert({ text, photos, product_id, pname, pprice, qty })
        .select().single();
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, row: data }, 200);
    }

    if (body.action === "postDel") {
      const id = String(body.id || "");
      if (!id) return json({ ok: false, error: "缺 id" }, 400);
      const { error } = await supabase.from("posts_369").update({ active: false }).eq("id", id);
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
