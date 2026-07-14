// admin-369 v2: 369 后台专用网关 —— 校验 x-admin-pin 后代办 列表/改/删/入库/订单管理。
// 底表 products_369 / orders_369 已对 anon 完全锁死，后台一切读写都必须经过这里。
// 密码优先读 Supabase Secrets 的 ADMIN_PIN_369，没设则用兜底值。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PIN = Deno.env.get("ADMIN_PIN_369") || "3690";
// 只允许改这些字段，防止越权写 created_by / client_ref 之类
const PATCH_FIELDS = ["name_cn", "brand", "sku", "images", "image_url", "price_rmb", "price_myr", "sell_myr", "status", "orig_myr", "hot", "soldout", "category", "params", "variants", "review_shots", "video_url"];
// 订单状态白名单，防止后台误写乱七八糟的状态
const ORDER_STATUS = ["已发送", "已确认", "已付款", "已采购", "运输中", "已到手", "已取消"];

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-pin, prefer",
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

      case "trend": { // 抓得物「动态/贴文」分享页 -> 标题/正文/作者/买家秀图（匹配商品在前端做）
        const url = (body.url || "").toString().trim();
        if (!/^https?:\/\//.test(url)) return json({ ok: false, error: "请贴得物动态链接" }, 400, cors);
        const html = await fetchTrendHtml(url);
        if (!html) return json({ ok: false, error: "抓取失败，得物可能临时限流，稍后重试" }, 200, cors);
        const t = extractTrend(html);
        if (!t.images.length) return json({ ok: false, error: "没抓到贴文图片（可能是视频贴或已删除）" }, 200, cors);
        return json({ ok: true, trend: t }, 200, cors);
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

      case "sale": { // 标记已售：记一笔成交（快照成本），累加 sold_count，可选顺手标售罄/下架
        const id = Number(body.id);
        if (!id) return json({ ok: false, error: "缺 id" }, 400, cors);
        const { data: p } = await supabase.from("products_369").select("*").eq("id", id).maybeSingle();
        if (!p) return json({ ok: false, error: "货不存在" }, 404, cors);
        const qty = Math.max(1, Number(body.qty) || 1);
        const price = body.price != null && Number.isFinite(Number(body.price)) ? Number(body.price) : (p.sell_myr != null ? Number(p.sell_myr) : null);
        const { error: e1 } = await supabase.from("sales_369").insert({
          product_id: id, name_cn: p.name_cn, qty, sold_myr: price, cost_myr: p.price_myr,
        });
        if (e1) return json({ ok: false, error: e1.message }, 500, cors);
        const upd = { sold_count: (p.sold_count || 0) + qty };
        if (body.soldout) upd.soldout = true;
        const { data: row, error: e2 } = await supabase.from("products_369").update(upd).eq("id", id).select().maybeSingle();
        if (e2) return json({ ok: false, error: e2.message }, 500, cors);
        return json({ ok: true, row }, 200, cors);
      }

      case "sales": { // 成交流水（近50笔）+ 本月/累计汇总
        const { data: rows, error: e1 } = await supabase.from("sales_369")
          .select("*").order("sold_at", { ascending: false }).limit(50);
        if (e1) return json({ ok: false, error: e1.message }, 500, cors);
        const { data: all, error: e2 } = await supabase.from("sales_369").select("qty,sold_myr,cost_myr,sold_at");
        if (e2) return json({ ok: false, error: e2.message }, 500, cors);
        const now = new Date(), y = now.getUTCFullYear(), m = now.getUTCMonth();
        const agg = () => ({ n: 0, rev: 0, profit: 0 });
        const month = agg(), total = agg();
        for (const r of all || []) {
          const buckets = [total];
          const d = new Date(r.sold_at);
          if (d.getUTCFullYear() === y && d.getUTCMonth() === m) buckets.push(month);
          for (const b of buckets) {
            b.n += r.qty;
            if (r.sold_myr != null) {
              b.rev += Number(r.sold_myr) * r.qty;
              b.profit += (Number(r.sold_myr) - (r.cost_myr != null ? Number(r.cost_myr) : 0)) * r.qty;
            }
          }
        }
        return json({ ok: true, rows, month, total }, 200, cors);
      }

      case "unsale": { // 撤销一笔误记的成交：删流水 + 回退已售数
        const sid = Number(body.saleId);
        if (!sid) return json({ ok: false, error: "缺 saleId" }, 400, cors);
        const { data: s0 } = await supabase.from("sales_369").select("*").eq("id", sid).maybeSingle();
        if (!s0) return json({ ok: false, error: "这笔记录不存在" }, 404, cors);
        const { error: e1 } = await supabase.from("sales_369").delete().eq("id", sid);
        if (e1) return json({ ok: false, error: e1.message }, 500, cors);
        if (s0.product_id) {
          const { data: p } = await supabase.from("products_369").select("sold_count").eq("id", s0.product_id).maybeSingle();
          // 撤销成交时一并取消售罄标记（sale 可能顺手标了售罄，不撤会一直挂「已售罄」）
          if (p) await supabase.from("products_369").update({ sold_count: Math.max(0, (p.sold_count || 0) - s0.qty), soldout: false }).eq("id", s0.product_id);
        }
        return json({ ok: true }, 200, cors);
      }

      case "config": { // 店面公告等配置
        const key = String(body.key || "").slice(0, 40);
        if (!key) return json({ ok: false, error: "缺 key" }, 400, cors);
        const { error } = await supabase.from("config_369")
          .upsert({ key, value: (body.value ?? "").toString().slice(0, 500), updated_at: new Date().toISOString() });
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true }, 200, cors);
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

      case "orders": { // 订单列表（最新 100 单）
        const { data, error } = await supabase
          .from("orders_369")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true, rows: data }, 200, cors);
      }

      case "orderStatus": { // 改订单状态/备注（状态必须在白名单里）
        const id = Number(body.id);
        if (!id) return json({ ok: false, error: "缺 id" }, 400, cors);
        const status = String(body.status || "");
        if (!ORDER_STATUS.includes(status)) return json({ ok: false, error: "状态不合法" }, 400, cors);
        const note = body.note != null ? String(body.note).slice(0, 200) : null;
        const { data, error } = await supabase
          .from("orders_369")
          .update({ status, note: note || null, updated_at: new Date().toISOString() })
          .eq("id", id).select().maybeSingle();
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true, row: data }, 200, cors);
      }

      case "orderDel": { // 删订单
        const id = Number(body.id);
        if (!id) return json({ ok: false, error: "缺 id" }, 400, cors);
        const { error } = await supabase.from("orders_369").delete().eq("id", id);
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true }, 200, cors);
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
// 抓贴文分享页 HTML（同商品解析：iPhone UA + 失败重试一次）
async function fetchTrendHtml(url) {
  for (let a = 0; a < 2; a++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const resp = await fetch(url, {
        signal: ctrl.signal, redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      }).finally(() => clearTimeout(timer));
      if (resp.ok) { const h = await resp.text(); if (h && h.length > 800) return h; }
    } catch (_e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}
function tjstr(html, key) {
  const m = html.match(new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.){0,600})"'));
  if (!m) return "";
  try { return JSON.parse('"' + m[1] + '"'); } catch (_e) { return m[1].replace(/\\n/g, "\n"); }
}
// 从贴文页 SSR JSON 抠 标题/正文/作者/买家秀图
function extractTrend(html) {
  const raw = [...html.matchAll(/https?:(?:\\?\/){2}image-cdn\.poizon\.com[^"'\\ ]+?\.(?:jpg|jpeg|png|webp)/gi)]
    .map((m) => m[0].replace(/\\u002f/gi, "/").replace(/\\\//g, "/"));
  const seen = new Set(), imgs = [];
  for (const u0 of raw) { const u = u0.split("?")[0]; if (!seen.has(u)) { seen.add(u); imgs.push(u); } }
  return {
    title: tjstr(html, "title").trim(),
    content: tjstr(html, "content").trim(),
    author: tjstr(html, "userName").trim(),
    images: imgs.slice(0, 12),
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
