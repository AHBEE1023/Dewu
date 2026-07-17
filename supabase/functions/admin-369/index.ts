// admin-369 v14: 369 后台专用网关 —— PIN 校验(失败限速+自设强密码) 后代办 列表/改/删/入库/订单/通知/数据看板。
// v14: 商品新增 stock 库存字段(可编辑,null=不限量);成交(sale)自动扣减库存、撤销(unsale)加回;
//      移植 Auth 变体的安全加固:trend 抓取仅限得物域名(防 SSRF)+ 响应体积上限 1.5MB。
// 注:曾有并行会话部署过 Supabase Auth(admin_users 表)鉴权变体,代码存于 _shared/admin-auth.ts,
//    待未来把全部 7 个管理函数 + 前端一起迁过去,单独迁这一个会打断线上 PIN 后台。
// 底表 products_369 / orders_369 已对 anon 完全锁死，后台一切读写都必须经过这里。
// 密码优先读 Supabase Secrets 的 ADMIN_PIN_369，没设则用兜底值。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PIN = Deno.env.get("ADMIN_PIN_369") || "3690";
// 只允许改这些字段，防止越权写 created_by / client_ref 之类
const PATCH_FIELDS = ["name_cn", "brand", "sku", "images", "image_url", "price_rmb", "price_myr", "sell_myr", "status", "orig_myr", "hot", "soldout", "category", "params", "variants", "review_shots", "video_url", "stock"];
// 订单状态白名单，防止后台误写乱七八糟的状态
const ORDER_STATUS = ["已发送", "已确认", "已付款", "已采购", "运输中", "已到手", "已取消"];
// 顾客状态推送用的小图标，让通知更直观
const STATUS_EMOJI = { "已发送": "📨", "已确认": "✅", "已付款": "💰", "已采购": "🛍️", "运输中": "🚚", "已到手": "📦", "已取消": "❌" };

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-pin, prefer",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  );
  // PIN 校验：失败限速 + 店主自设强密码（哈希存 app_secrets）取代硬编码兜底
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const gate = await adminAuth(supabase, ip, req.headers.get("x-admin-pin") || "");
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status, cors);

  try {
    const body = await req.json().catch(() => ({}));

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
        if (!isAllowedDewuUrl(url)) return json({ ok: false, error: "请贴得物官方动态链接" }, 400, cors);
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
        if ("stock" in fields) { // 库存:空=不限量(null),否则钳成非负整数
          const s = fields.stock;
          fields.stock = (s == null || s === "") ? null : (Number.isFinite(Number(s)) ? Math.max(0, Math.floor(Number(s))) : null);
        }
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
        if (p.stock != null) upd.stock = Math.max(0, p.stock - qty); // 有限量的货,成交顺手扣库存
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
          const { data: p } = await supabase.from("products_369").select("sold_count,stock").eq("id", s0.product_id).maybeSingle();
          // 撤销成交时一并取消售罄标记（sale 可能顺手标了售罄，不撤会一直挂「已售罄」）;有限量的货把库存加回去
          if (p) {
            const back = { sold_count: Math.max(0, (p.sold_count || 0) - s0.qty), soldout: false };
            if (p.stock != null) back.stock = p.stock + s0.qty;
            await supabase.from("products_369").update(back).eq("id", s0.product_id);
          }
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
        // 先读旧值：状态/备注真的变了才推送，避免顾客被重复打扰
        const { data: prev } = await supabase.from("orders_369")
          .select("status,note,tg_id,order_no").eq("id", id).maybeSingle();
        const { data, error } = await supabase
          .from("orders_369")
          .update({ status, note: note || null, updated_at: new Date().toISOString() })
          .eq("id", id).select().maybeSingle();
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        // 推送给顾客（仅当有 tg_id、配了 bot、且状态或备注确有变化）
        let pushed = false;
        const changed = !prev || prev.status !== status || (prev.note || "") !== (note || "");
        try {
          if (changed && data && data.tg_id) {
            const token = (await getSecret(supabase, "tg_bot_token")).trim();
            if (token) pushed = await tgSend(token, String(data.tg_id), fmtStatus(data));
          }
        } catch (_e) { /* 推送失败不影响后台改状态 */ }
        // Web Push（到货提醒）：不管从哪打开的都推；用 service_role key 调 push-369（服务器专用）
        try {
          if (changed && data && data.client_key) {
            const emoji = STATUS_EMOJI[status] || "📦";
            const bodyTxt = "订单 " + (data.order_no || ("#" + id)) + " 更新为：" + status + (note ? "（" + note + "）" : "");
            fetch((Deno.env.get("SUPABASE_URL") || "") + "/functions/v1/push-369", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "") },
              body: JSON.stringify({ action: "send", ck: data.client_key, title: emoji + " 369 甄选", body: bodyTxt, url: "/" }),
            }).catch(() => {});
          }
        } catch (_e) { /* 推送失败不影响后台改状态 */ }
        return json({ ok: true, row: data, pushed }, 200, cors);
      }

      // ===== Telegram 通知配置（店主专用）=====
      case "tgGet": { // 返回当前配置状态给后台展示
        const token = (await getSecret(supabase, "tg_bot_token")).trim();
        const ownerChat = (await getSecret(supabase, "tg_owner_chat")).trim();
        const ownerName = (await getSecret(supabase, "tg_owner_name")).trim();
        let botUser = "";
        if (token) { try { const me = await tgApi(token, "getMe"); if (me.ok) botUser = me.result.username || ""; } catch (_e) { /* ignore */ } }
        return json({ ok: true, hasToken: !!token, botUser, ownerChat, ownerName }, 200, cors);
      }

      case "tgSaveToken": { // 保存 bot token（先用 getMe 验一下真伪）
        const token = String(body.token || "").trim();
        if (!token) { await setSecret(supabase, "tg_bot_token", ""); return json({ ok: true, cleared: true }, 200, cors); }
        if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) return json({ ok: false, error: "token 格式不对，应形如 123456:AAE...（从 @BotFather 复制）" }, 400, cors);
        let me;
        try { me = await tgApi(token, "getMe"); } catch (_e) { return json({ ok: false, error: "连不上 Telegram，稍后再试" }, 200, cors); }
        if (!me.ok) return json({ ok: false, error: "token 无效，Telegram 拒绝了它" }, 200, cors);
        await setSecret(supabase, "tg_bot_token", token);
        return json({ ok: true, botUser: me.result.username || "" }, 200, cors);
      }

      case "tgBind": { // 店主给 bot 发条消息后点这里：抓最近一条消息的 chat 作为接收人
        const token = (await getSecret(supabase, "tg_bot_token")).trim();
        if (!token) return json({ ok: false, error: "请先保存 bot token" }, 400, cors);
        let upd;
        try { upd = await tgApi(token, "getUpdates", { offset: -1, allowed_updates: ["message"] }); } catch (_e) { return json({ ok: false, error: "连不上 Telegram，稍后再试" }, 200, cors); }
        if (!upd.ok) return json({ ok: false, error: "Telegram 返回异常" }, 200, cors);
        const list = (upd.result || []).filter((u) => u.message && u.message.chat);
        if (!list.length) return json({ ok: false, error: "没收到消息。请先在 Telegram 打开你的 bot 点「开始 / Start」或随便发一句，再回来点绑定。" }, 200, cors);
        const chat = list[list.length - 1].message.chat;
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id);
        await setSecret(supabase, "tg_owner_chat", String(chat.id));
        await setSecret(supabase, "tg_owner_name", name);
        return json({ ok: true, ownerChat: String(chat.id), ownerName: name }, 200, cors);
      }

      case "tgTest": { // 给已绑定的店主发一条测试消息
        const token = (await getSecret(supabase, "tg_bot_token")).trim();
        const chat = (await getSecret(supabase, "tg_owner_chat")).trim();
        if (!token) return json({ ok: false, error: "请先保存 bot token" }, 400, cors);
        if (!chat) return json({ ok: false, error: "请先绑定接收人" }, 400, cors);
        const ok = await tgSend(token, chat, "🔔 <b>369 甄选</b> 通知已接通！\n以后有新订单会推到这里，顾客也会收到你更新的发货进度。");
        return json({ ok, error: ok ? undefined : "发送失败：请确认你没有拉黑/停用这个 bot" }, 200, cors);
      }

      case "orderDel": { // 删订单
        const id = Number(body.id);
        if (!id) return json({ ok: false, error: "缺 id" }, 400, cors);
        const { error } = await supabase.from("orders_369").delete().eq("id", id);
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true }, 200, cors);
      }

      // ===== 可观测性 =====
      case "analytics": { // 数据看板聚合
        const days = Number(body.days) || 7;
        const { data, error } = await supabase.rpc("analytics_369", { days });
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true, data }, 200, cors);
      }

      case "errors": { // 最近客户端错误
        const { data, error } = await supabase.from("events_369")
          .select("id,q,meta,ua,created_at").eq("type", "error")
          .order("created_at", { ascending: false }).limit(40);
        if (error) return json({ ok: false, error: error.message }, 500, cors);
        return json({ ok: true, rows: data }, 200, cors);
      }

      case "setPin": { // 店主设置强密码（哈希存库，取代兜底 3690）
        const np = String(body.pin || "").trim();
        if (np.length < 6) return json({ ok: false, error: "新密码至少 6 位（建议数字+字母混合）" }, 400, cors);
        if (np.length > 64) return json({ ok: false, error: "密码太长" }, 400, cors);
        await setSecret(supabase, "admin_pin_hash", await sha256hex(np));
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
      // 防 SSRF:重定向后的最终地址也必须还在得物域内;响应体积设上限防内存打爆
      if (resp.ok && isAllowedDewuUrl(resp.url)) {
        const declared = Number(resp.headers.get("content-length") || 0);
        if (declared > 1_500_000) return null;
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (bytes.byteLength > 1_500_000) return null;
        const h = new TextDecoder().decode(bytes);
        if (h && h.length > 800) return h;
      }
    } catch (_e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}
function isAllowedDewuUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return ["dewu.com", "dw4.co"].some((allowed) => host === allowed || host.endsWith("." + allowed));
  } catch (_e) { return false; }
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
// ===== 后台 PIN 校验：失败限速 + 自设强密码 =====
async function adminAuth(supabase, ip, pin) {
  const { data: row } = await supabase.from("admin_attempts_369").select("*").eq("ip", ip).maybeSingle();
  const now = Date.now();
  if (row && row.locked_until && new Date(row.locked_until).getTime() > now) {
    const mins = Math.ceil((new Date(row.locked_until).getTime() - now) / 60000);
    return { ok: false, status: 429, error: "尝试太多，请 " + mins + " 分钟后再试" };
  }
  const storedHash = (await getSecret(supabase, "admin_pin_hash")).trim();
  const valid = pin ? (storedHash ? (await sha256hex(pin)) === storedHash : pin === PIN) : false;
  if (valid) {
    if (row && row.fails > 0) {
      await supabase.from("admin_attempts_369").upsert({ ip, fails: 0, locked_until: null, updated_at: new Date().toISOString() });
    }
    return { ok: true, status: 200 };
  }
  const fails = (row ? row.fails : 0) + 1;
  const upd = { ip, fails, updated_at: new Date().toISOString(), locked_until: fails >= 5 ? new Date(now + 10 * 60000).toISOString() : null };
  await supabase.from("admin_attempts_369").upsert(upd);
  return { ok: false, status: fails >= 5 ? 429 : 401, error: fails >= 5 ? "错误太多，已锁定 10 分钟" : "密码不对" };
}
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
// ===== 私密配置读写（app_secrets_369，只有 service role 能碰）=====
async function getSecret(supabase, key) {
  const { data } = await supabase.from("app_secrets_369").select("value").eq("key", key).maybeSingle();
  return (data && data.value) ? String(data.value) : "";
}
async function setSecret(supabase, key, value) {
  await supabase.from("app_secrets_369").upsert({ key, value: value ?? "", updated_at: new Date().toISOString() });
}
// ===== Telegram Bot API =====
async function tgApi(token, method, params) {
  const r = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  return await r.json();
}
async function tgSend(token, chat, text) {
  try {
    const j = await tgApi(token, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });
    return !!j.ok;
  } catch (_e) { return false; }
}
function tgEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// 状态变更推给顾客的文案
function fmtStatus(o) {
  const em = STATUS_EMOJI[o.status] || "🔔";
  let t = "📦 你的订单 <b>" + tgEsc(String(o.order_no || "#—")) + "</b> 有更新\n\n状态：<b>" + em + " " + tgEsc(String(o.status || "")) + "</b>";
  if (o.note) t += "\n物流 / 备注：" + tgEsc(String(o.note));
  t += "\n\n打开「369 甄选」→「我的订单」可看完整进度。";
  return t;
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
