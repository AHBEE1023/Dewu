// admin-369 v1: 369 后台专用网关 —— 校验 x-admin-pin 后代办 列表/改/删/入库。
// 底表 products_369 已对 anon 完全锁死，后台一切读写都必须经过这里。
// 密码优先读 Supabase Secrets 的 ADMIN_PIN_369，没设则用兜底值。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PIN = Deno.env.get("ADMIN_PIN_369") || "3690";
// 只允许改这些字段，防止越权写 created_by / client_ref 之类
const PATCH_FIELDS = ["name_cn", "brand", "sku", "images", "image_url", "price_rmb", "price_myr", "sell_myr", "status"];

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-pin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const pin = req.headers.get("x-admin-pin") || "";
  if (pin !== PIN) return json({ ok: false, error: "密码不对" }, 401, cors);

  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );

    switch (body.action) {
      case "ping":
        return json({ ok: true }, 200, cors);

      case "list": {
        const { data, error } = await supabase
          .from("products_369")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(300);
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true, rows: data }, 200, cors);
      }

      case "patch": {
        const id = Number(body.id);
        if (!id) return json({ ok: false, error: "缺 id" }, 400, cors);
        const fields = {};
        for (const k of PATCH_FIELDS) if (k in (body.fields || {})) fields[k] = body.fields[k];
        if (!Object.keys(fields).length) return json({ ok: false, error: "没有可改字段" }, 400, cors);
        const { data, error } = await supabase
          .from("products_369").update(fields).eq("id", id).select().maybeSingle();
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true, row: data }, 200, cors);
      }

      case "del": {
        const id = Number(body.id);
        if (!id) return json({ ok: false, error: "缺 id" }, 400, cors);
        const { error } = await supabase.from("products_369").delete().eq("id", id);
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true }, 200, cors);
      }

      case "insert": {
        // 解析入库：插占位行，AFTER INSERT 触发器会自动调 parse-dewu-link 回填
        const input = (body.input || "").toString().trim();
        const reqId = body.reqId ? String(body.reqId).slice(0, 60) : null;
        const tgId = body.tgId ? Number(body.tgId) : null;
        if (!input) return json({ ok: false, error: "没有输入内容" }, 400, cors);
        if (reqId) { // 同一次请求重发过来，直接还旧行（弱网重试不重复入库）
          const { data: dup } = await supabase
            .from("products_369").select("*").eq("client_ref", reqId).limit(1).maybeSingle();
          if (dup) return json({ ok: true, row: dup }, 200, cors);
        }
        const urlMatch = input.match(/https?:\/\/[^\s，。、]+/);
        const sourceUrl = urlMatch ? urlMatch[0] : null;
        const { data, error } = await supabase
          .from("products_369")
          .insert({
            name_cn: quickName(input, sourceUrl) || "⏳ 解析中…",
            source: "dewu",
            status: "待选",
            source_url: sourceUrl,
            raw_text: input.slice(0, 4000),
            created_by: tgId,
            client_ref: reqId,
          })
          .select()
          .single();
        if (error) {
          if (reqId && /duplicate|unique/i.test(error.message)) { // 并发重发撞唯一索引
            const { data: dup } = await supabase
              .from("products_369").select("*").eq("client_ref", reqId).limit(1).maybeSingle();
            if (dup) return json({ ok: true, row: dup }, 200, cors);
          }
          return json({ ok: false, error: "入库失败：" + error.message }, 500, cors);
        }
        return json({ ok: true, row: data }, 200, cors);
      }

      default:
        return json({ ok: false, error: "未知 action" }, 400, cors);
    }
  } catch (e) {
    return json({ ok: false, error: "后台服务错误：" + String(e) }, 500, cors);
  }
});

function quickName(input, url) {
  let t = input;
  if (url) t = t.split(url).join(" ");
  t = t
    .replace(/【[^】]*】/g, " ")
    .replace(/[A-Za-z0-9_]+发现一件好物[，,]?/g, " ")
    .replace(/点击链接直接打开/g, " ")
    .replace(/复制此?(条)?(链接|信息|口令)[\s\S]*$/g, " ")
    .replace(/[a-z0-9]{6,}(?=\s)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t ? "⏳ " + t.slice(0, 40) : null;
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
