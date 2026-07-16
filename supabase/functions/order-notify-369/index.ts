// order-notify-369: 顾客发单后由前端调用，给店主推一条 Telegram 新单通知。
// 安全：verify_jwt=false，但只接受一个 sid，且——
//   1) 订单必须存在、且在最近 300 秒内创建（防用旧 id 刷屏）；
//   2) 用 `update ... where notified_owner=false returning` 原子翻转，
//      同一单最多推一次（防重发/并发重复通知）。
// bot token / 店主 chat 存在 app_secrets_369（service role 才可读），没配就静默跳过。
import { createClient } from "npm:@supabase/supabase-js@2.110.6";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const sid = Number(body.sid);
    if (!sid) return json({ ok: true }, 200); // 没 sid 也不报错，前端不该因此中断

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );

    // 读私密配置
    const { data: secs } = await supabase
      .from("app_secrets_369").select("key,value")
      .in("key", ["tg_bot_token", "tg_owner_chat"]);
    const map = {};
    for (const s of secs || []) map[s.key] = s.value;
    const token = (map.tg_bot_token || "").trim();
    const chat = (map.tg_owner_chat || "").trim();
    if (!token || !chat) return json({ ok: true, skipped: "unconfigured" }, 200);

    // 原子翻转 notified_owner：只有还没通知过、且是最近 5 分钟的新单才推
    const cutoff = new Date(Date.now() - 300 * 1000).toISOString();
    const { data: row } = await supabase
      .from("orders_369")
      .update({ notified_owner: true })
      .eq("id", sid).eq("notified_owner", false).gte("created_at", cutoff)
      .select().maybeSingle();
    if (!row) return json({ ok: true, skipped: "dup-or-stale" }, 200);

    await tgSend(token, chat, fmtOrder(row));
    return json({ ok: true }, 200);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 200); // 通知失败绝不影响顾客下单，返回 200
  }
});

function fmtOrder(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const lines = items.slice(0, 20).map((it, i) => {
    const nm = esc(String(it.name || "").slice(0, 40));
    const vr = it.variant ? "【" + esc(String(it.variant)) + "】" : "";
    const qty = Number(it.qty) || 1;
    const pr = (it.price != null && it.price !== "") ? " RM" + fmtMoney(it.price) : " 询价";
    return (i + 1) + ". " + nm + vr + " ×" + qty + pr;
  });
  if (items.length > 20) lines.push("… 等 " + items.length + " 件");
  const head = "🛎️ <b>新订单 " + esc(String(o.order_no || "#—")) + "</b>";
  const meta = "共 " + (o.count != null ? o.count : items.reduce((a, it) => a + (Number(it.qty) || 0), 0)) +
    " 件" + (o.total != null && Number(o.total) > 0 ? " · <b>RM" + fmtMoney(o.total) + "</b>" : "");
  const who = o.tg_id ? "\n👤 Telegram id: <code>" + esc(String(o.tg_id)) + "</code>" : "\n👤 匿名顾客（非 Telegram）";
  return head + "\n" + meta + "\n\n" + lines.join("\n") + who +
    "\n\n在后台「📦 顾客订单」里改状态、填单号，顾客即可看到进度。";
}

async function tgSend(token, chat, text) {
  const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return r.ok;
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function fmtMoney(v) { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "0"; }
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
