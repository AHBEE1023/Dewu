// parse-dewu-link v23: 正则优先零成本解析 + 页面抓取重试 + 价格三级优先（发售价/元格式authPrice/分格式众数）+ 检查点日志
import { createClient } from "npm:@supabase/supabase-js@2.110.6";
import { requireAdmin } from "../_shared/admin-auth.ts";

const RATE_RMB_TO_MYR = 0.62;
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const MAX_INPUT_CHARS = 4000;
const MAX_PAGE_BYTES = 1_500_000;
const DEFAULT_SOURCE_HOSTS = ["dewu.com", "dw4.co"];

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "只允许 POST" }, 405, cors);

  try {
    const apiKey = Deno.env.get("GEMINI_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!apiKey || !supabaseUrl || !serviceRoleKey) {
      console.error("Missing required Edge Function secrets");
      return json({ ok: false, error: "服务器配置不完整" }, 500, cors);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const gate = await requireAdmin(req, supabase);
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status, cors);

    const body: any = await req.json().catch(() => ({}));
    const rowId = body.rowId ? Number(body.rowId) : null;
    const input = (body.input || "").toString().trim();
    const tgId = body.tgId ? Number(body.tgId) : null;
    const reqId = body.reqId ? String(body.reqId).slice(0, 60) : null;

    if (rowId) {
      const { data: row } = await supabase.from("products_369").select("*").eq("id", rowId).maybeSingle();
      if (!row) return json({ ok: false, error: "行不存在" }, 200, cors);
      const rawText = (row.raw_text || "").toString();
      const su = row.source_url || (rawText.match(/https?:\/\/[^\s，。、]+/) || [null])[0];
      if (su && !isAllowedSourceUrl(su)) return json({ ok: false, error: "只支持得物官方链接" }, 400, cors);
      const rest = su ? rawText.replace(su, "").trim() : rawText;
      const bg = fillRow(supabase, apiKey, rowId, rawText, su, !!su && rest.length < 8);
      const runtime = (globalThis as any).EdgeRuntime;
      try { runtime?.waitUntil(bg); } catch (_e) { await bg; }
      return json({ ok: true, rowId }, 200, cors);
    }

    if (!input) return json({ ok: false, error: "没有输入内容" }, 400, cors);
    if (input.length > MAX_INPUT_CHARS) return json({ ok: false, error: `输入内容不能超过 ${MAX_INPUT_CHARS} 字` }, 400, cors);

    const urlMatch = input.match(/https?:\/\/[^\s，。、]+/);
    const sourceUrl = urlMatch ? urlMatch[0] : null;
    if (sourceUrl && !isAllowedSourceUrl(sourceUrl)) return json({ ok: false, error: "只支持得物官方链接" }, 400, cors);
    const textWithoutUrl = sourceUrl ? input.replace(sourceUrl, "").trim() : input;
    const linkOnly = !!sourceUrl && textWithoutUrl.length < 8;

    if (reqId) {
      const { data: dup } = await supabase
        .from("products_369")
        .select("*")
        .eq("client_ref", reqId)
        .limit(1)
        .maybeSingle();
      if (dup) return json({ ok: true, product: dup, pending: /^[⏳⚠]/.test(dup.name_cn || "") }, 200, cors);
    }

    const placeholder = quickName(input, sourceUrl) || "⏳ 解析中…";
    const { data, error } = await supabase
      .from("products_369")
      .insert({
        name_cn: placeholder,
        source: "dewu",
        status: "待选",
        source_url: sourceUrl,
        raw_text: input.slice(0, MAX_INPUT_CHARS),
        created_by: tgId,
        client_ref: reqId,
      })
      .select()
      .single();
    if (error) return json({ ok: false, error: "入库失败：" + error.message }, 500, cors);

    const bg = fillRow(supabase, apiKey, data.id, input, sourceUrl, linkOnly);
    const runtime = (globalThis as any).EdgeRuntime;
    try { runtime?.waitUntil(bg); } catch (_e) { await bg; }

    return json({ ok: true, product: data, pending: true }, 200, cors);
  } catch (e) {
    console.error("parse-dewu-link failed", e);
    return json({ ok: false, error: "解析服务暂时不可用，请稍后重试" }, 500, cors);
  }
});

async function fillRow(supabase, apiKey, rowId, material0, sourceUrl, linkOnly) {
  try {
    let material = material0, fromPage = false, gallery = null, st = null, pageParams = null, pageVariants = null;
    if (sourceUrl) {
      const page = await fetchDewuPage(sourceUrl);
      console.log("[dbg] row", rowId, "blocked=", page.blocked, "st=", JSON.stringify(page.st || null).slice(0, 120));
      if (!page.blocked) {
        st = page.st;
        pageParams = page.params && page.params.length ? page.params : null;
        pageVariants = page.variants && page.variants.length ? page.variants : null;
        gallery = page.images && page.images.length ? page.images : (page.image ? [page.image] : null);
        // 页面抓得到就把网页文字一起给 AI 备用——分享文字里没有价格，价格只在网页里
        if (linkOnly) { material = page.text; fromPage = true; }
        else if (page.text) { material = material0 + "\n\n【商品网页内容】\n" + page.text; fromPage = true; }
        if (page.priceHint) material = "【价格线索】" + page.priceHint + "\n\n" + material;
      } else if (linkOnly) {
        await supabase.from("products_369")
          .update({ name_cn: "⚠️ 链接被拦，请改贴『分享文字』重解析" })
          .eq("id", rowId);
        return;
      }
    }

    // v21：先走零成本纯代码解析——名字+价格都抠到了就不调 AI（免费、不限流、毫秒级）
    let parsed: any;
    console.log("[dbg] row", rowId, "path=", (st && st.name && st.priceRmb != null) ? "regex" : "gemini");
    if (st && st.name && st.priceRmb != null) {
      parsed = { name_cn: st.name, brand: st.brand, sku: st.sku, price_rmb: st.priceRmb, image_url: null };
    } else {
      parsed = await parseWithGemini(apiKey, material, fromPage);
    }
    const upd: Record<string, any> = {};
    if (parsed && parsed.name_cn) {
      const priceRmb = toNum(parsed.price_rmb);
      const validPriceRmb = priceRmb != null && priceRmb >= 0 && priceRmb <= 10_000_000 ? priceRmb : null;
      upd.name_cn = cleanText(parsed.name_cn, 240) || "⚠️ 没解析出商品，点『编辑』手填或删除";
      upd.brand = cleanText(parsed.brand, 120);
      // 分享文字里「XXX发现一件好物」的 XXX 是分享人用户名，绝不能当成货号
      let skuVal = cleanText(parsed.sku, 120);
      const um = (material0 || "").match(/([A-Za-z0-9_]{3,})发现一件好物/);
      if (um && skuVal && skuVal.replace(/\s/g, "") === um[1]) skuVal = null;
      upd.sku = skuVal;
      upd.price_rmb = validPriceRmb;
      upd.price_myr = validPriceRmb != null ? Math.round(validPriceRmb * RATE_RMB_TO_MYR * 100) / 100 : null;
    } else {
      upd.name_cn = "⚠️ 没解析出商品，点『编辑』手填或删除";
    }
    const imageUrl = safeHttpsUrl((gallery && gallery[0]) || (parsed && parsed.image_url));
    if (imageUrl) { upd.image_url = imageUrl; upd.images = gallery && gallery.length ? gallery : [imageUrl]; }
    // 参数/规格只在行里还没有时写入——重解析不冲掉店主的勾选和定价
    if (pageParams || pageVariants) {
      const { data: cur } = await supabase.from("products_369").select("params,variants").eq("id", rowId).maybeSingle();
      if (pageParams && !(cur && cur.params && cur.params.length)) upd.params = pageParams;
      if (pageVariants && !(cur && cur.variants && cur.variants.length)) upd.variants = pageVariants;
    }
    await supabase.from("products_369").update(upd).eq("id", rowId);
  } catch (e) {
    const s = String(e);
    const msg = (s.includes("429") || s.includes("quota") || s.includes("RESOURCE_EXHAUSTED"))
      ? "⚠️ 解析限流了，稍后点『编辑』重试或手填"
      : "⚠️ 解析失败，点『编辑』手填或删除";
    try { await supabase.from("products_369").update({ name_cn: msg }).eq("id", rowId); } catch (_e2) { /* ignore */ }
  }
}

// 得物对数据中心 IP 间歇性限流：失败自动重试一次再认输
async function fetchDewuPage(url) {
  for (let a = 0; a < 3; a++) {
    const r = await fetchDewuPageOnce(url);
    if (!r.blocked) return r;
    if (a < 2) await new Promise((r2) => setTimeout(r2, 1800 * (a + 1)));
  }
  return { blocked: true };
}
async function fetchDewuPageOnce(url) {
  try {
    if (!isAllowedSourceUrl(url)) return { blocked: true };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) return { blocked: true };
    if (!isAllowedSourceUrl(resp.url)) return { blocked: true };
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) return { blocked: true };
    const declaredLength = Number(resp.headers.get("content-length") || 0);
    if (declaredLength > MAX_PAGE_BYTES) return { blocked: true };
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength > MAX_PAGE_BYTES) return { blocked: true };
    const html = new TextDecoder().decode(bytes);

    const blockedSigns = ["验证", "滑块", "captcha", "punish", "安全验证", "拦截", "机器人", "abnormal"];
    const looksBlocked =
      html.length < 1500 || blockedSigns.some((s) => html.includes(s));
    const looksProduct = /价格|¥|price|spuId|skuId|商品|productName/i.test(html);
    if (looksBlocked && !looksProduct) return { blocked: true };

    return {
      blocked: false,
      text: htmlToText(html).slice(0, 50000),
      images: extractImages(html),
      image: extractMain(html),
      priceHint: extractPriceHints(html),
      st: extractStructured(html),
      params: extractParams(html),
      variants: extractVariants(html),
    };
  } catch (_e) {
    return { blocked: true };
  }
}

// 商品参数表：key-value 对（发售价格另有用途，跳过）；默认 on:false，后台勾选才对顾客显示
function extractParams(html) {
  const seen = new Set(), out = [];
  for (const m of html.matchAll(/"key":"((?:[^"\\]|\\.){1,14})","value":"((?:[^"\\]|\\.){1,60})"/g)) {
    let k = m[1], v = m[2];
    try { k = JSON.parse('"' + k + '"'); } catch (_e) {}
    try { v = JSON.parse('"' + v + '"'); } catch (_e) {}
    k = k.trim(); v = v.replace(/\s+/g, " ").trim();
    if (!k || !v || k === "发售价格" || seen.has(k)) continue;
    seen.add(k);
    out.push({ k, v, on: false });
    if (out.length >= 14) break;
  }
  return out;
}
// 规格 SKU 列表：propertyValues + authPrice（skuAuthPriceList 里单位是分）
function extractVariants(html) {
  const seen = new Set(), out = [];
  for (const m of html.matchAll(/\{"skuId":\d+,"authPrice":(\d+)[^{}]*?"propertyValues":"((?:[^"\\]|\\.){1,60})"/g)) {
    let name = m[2];
    try { name = JSON.parse('"' + name + '"'); } catch (_e) {}
    name = name.replace(/\s+/g, " ").trim();
    const rmb = Math.round(+m[1]) / 100;
    if (!name || !Number.isFinite(rmb) || rmb <= 0 || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, rmb, sell: null, on: false });
    if (out.length >= 20) break;
  }
  return out;
}

// ===== 纯代码结构化解析（零 AI）=====
// 抠页面 JSON 里的转义字符串值
function jstr(html, key) {
  const m = html.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
  if (!m) return null;
  let v = m[1];
  try { v = JSON.parse('"' + v + '"'); } catch (_e) { /* 原样用 */ }
  v = v.replace(/\s+/g, " ").trim();
  return v || null;
}
// 从标题开头猜品牌：「泡泡玛特 POP MART …」「COACH蔻驰 …」「JELLYCAT …」
function guessBrand(title) {
  if (!title) return null;
  const m = title.match(/^([一-龥·]{1,10}\s+[A-Z][A-Z .&'’-]{1,24}(?=\s)|[A-Za-z]+[一-龥·]{1,10}(?=\s)|[A-Z][A-Z0-9 .&'’-]{2,24}(?=\s))/);
  return m ? m[1].trim() : null;
}
function extractStructured(html) {
  const name = jstr(html, "structureTitle") || jstr(html, "originalTitle");
  const sku = jstr(html, "articleNumber");
  // 价格三级优先：发售价格(元) → 紧邻 originalTitle 的 authPrice(元) → skuAuthPriceList 的 authPrice 众数(分)/100
  let priceRmb = null;
  const m1 = html.match(/"key"\s*:\s*"发售价格"\s*,\s*"value"\s*:\s*"¥?([\d.,]+)"/);
  if (m1) priceRmb = Number(m1[1].replace(/,/g, ""));
  if (!Number.isFinite(priceRmb) || priceRmb == null) {
    const m2 = html.match(/"authPrice"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"originalTitle"/);
    // authPrice 在得物 JSON 里是「分」（和下面众数分支、extractVariants 一致）；大整数按分换算成元，避免 100 倍价
    if (m2) { const v = Number(m2[1]); priceRmb = (Number.isInteger(v) && v >= 1000) ? v / 100 : v; }
  }
  if (!Number.isFinite(priceRmb) || priceRmb == null) {
    const ap = [...html.matchAll(/"authPrice"\s*:\s*(\d{3,})/g)].map((m) => +m[1]);
    if (ap.length) {
      const freq = new Map();
      for (const v of ap) freq.set(v, (freq.get(v) || 0) + 1);
      priceRmb = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0] / 100;
    }
  }
  return {
    name,
    sku,
    priceRmb: Number.isFinite(priceRmb) ? priceRmb : null,
    brand: guessBrand(name),
  };
}

// 从页面 JSON 里直接抠价格线索：发售价格（元）+ authPrice 众数（分）
function extractPriceHints(html) {
  const hints = [];
  const m1 = html.match(/"key"\s*:\s*"发售价格"\s*,\s*"value"\s*:\s*"¥?([\d.,]+)"/);
  if (m1) hints.push("发售价格 ¥" + m1[1]);
  const ap = [...html.matchAll(/"authPrice"\s*:\s*(\d{3,})/g)].map((m) => +m[1]);
  if (ap.length) {
    const freq = new Map();
    for (const v of ap) freq.set(v, (freq.get(v) || 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    hints.push("主SKU价格 authPrice=" + top + "分 = ¥" + (top / 100));
  }
  return hints.join("；");
}

const RE_PROIMG = /https?:(?:\\?\/){2}[^"'\\ ]*?pro-img(?:\\?\/)(?:origin|cut)-img(?:\\?\/)[^"'\\ ]+?\.(?:jpg|jpeg|png|webp)/gi;
function collectRe(html, re) {
  const seen = new Set(), out = [];
  let m; re.lastIndex = 0;
  while ((m = re.exec(html))) { const u = unescapeUrl(m[0]); if (!seen.has(u)) { seen.add(u); out.push(u); } }
  return out;
}
function galleryStart(html) {
  let from = 0, idx;
  while ((idx = html.indexOf('"images":[{"url":"', from)) >= 0) {
    const head = html.slice(idx + 17, idx + 400);
    if (/trade(?:\\?\/)gondor/.test(head)) return idx;
    from = idx + 10;
  }
  return html.indexOf('"images":[{"url":"');
}
function extractImages(html) {
  const all = collectRe(html, RE_PROIMG);
  if (all.length) {
    const byId = new Map();
    for (const u of all) {
      const base = (u.split("/").pop() || "").replace(/\.[a-z]+$/i, "");
      const prev = byId.get(base);
      if (!prev) byId.set(base, u);
      else if (/origin-img/i.test(u) && !/origin-img/i.test(prev)) byId.set(base, u);
    }
    return [...byId.values()].slice(0, 12);
  }
  const start = galleryStart(html);
  if (start < 0) return [];
  const end = html.indexOf("}]", start);
  const seg = end > start ? html.slice(start, end + 2) : html.slice(start, start + 4000);
  const raw = [...seg.matchAll(/"url"\s*:\s*"(https?:(?:\\\/|\/)[^"\\]+)"/g)].map((m) => unescapeUrl(m[1]));
  const seen = new Map();
  for (const u0 of raw) {
    const uq = u0.split("?")[0];
    if (!/\.(jpg|jpeg|png|webp)$/i.test(uq)) continue;
    if (/node-common/i.test(uq)) continue;
    const dm = uq.match(/-w(\d+)h(\d+)\.(?:jpg|jpeg|png|webp)$/i);
    let key = uq, md = 9999;
    if (dm) {
      const w = +dm[1], h = +dm[2], mn = Math.min(w, h), ar = mn / Math.max(w, h);
      if (mn < 200 || ar < 0.55) continue;
      key = uq.replace(/-w\d+h\d+(\.[a-z]+)$/i, "$1");
      md = mn;
    }
    const prev = seen.get(key);
    if (!prev || md > prev.md) seen.set(key, { url: uq, md });
  }
  return [...seen.values()].map((x) => x.url).slice(0, 10);
}
function extractMain(html) {
  const g = extractImages(html);
  if (g[0]) return g[0];
  let m = html.match(/"images"\s*:\s*\[\s*\{\s*"url"\s*:\s*"(https?:(?:\\\/|\/)[^"\\]+)"/);
  if (m) return unescapeUrl(m[1]);
  m = html.match(
    /https?:(?:\\?\/){2}[^"'\s)]*?(?:dewucdn|poizon)[^"'\s)]*?(?:trade(?:\\?\/)gondor|pro-img(?:\\?\/)(?:origin|cut)-img)[^"'\s)]*?\.(?:jpg|jpeg|png|webp)/i
  );
  if (m) return unescapeUrl(m[0]);
  m = html.match(/"logoUrl"\s*:\s*"(https?:(?:\\\/|\/)[^"\\]+\.(?:jpg|jpeg|png|webp))/i);
  if (m) return unescapeUrl(m[1]);
  return null;
}
function unescapeUrl(u) {
  return u.replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&").trim();
}

function htmlToText(html) {
  return html
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, " $1 ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function parseWithGemini(apiKey, material, fromPage) {
  const instr =
    "你是得物（poizon）商品信息解析器。从给定内容里抠出单个商品的：中文名(name_cn)、品牌(brand)、" +
    "货号SKU(sku)、得物人民币价格(price_rmb，元，纯数字)、商品主图链接(image_url)。" +
    "货号是得物商品编号（一般 2 个大写字母+数字，如 KU4750）；分享文字里『XXX发现一件好物』的 XXX 是分享人用户名，绝对不要当作货号。若拿不准货号就填 null。" +
    "抠不到的字段填 null。价格只要数字（元），不要货币符号。只解析最主要的那个商品。" +
    "价格取值优先级：页面显示的当前售价 > 发售价格 >【价格线索】给的值。" +
    "注意：JSON 里的 authPrice 字段单位是「分」，要除以 100 换算成元；如果几个价格矛盾，选最像商品当前售价的那个。";
  const prefix = fromPage
    ? "以下是得物商品网页抓取到的文字内容：\n\n"
    : "以下是用户从得物 App 复制的分享文字：\n\n";

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL +
    ":generateContent";

  const payload = {
    contents: [{ parts: [{ text: instr + "\n\n" + prefix + material }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          name_cn: { type: "STRING", nullable: true },
          brand: { type: "STRING", nullable: true },
          sku: { type: "STRING", nullable: true },
          price_rmb: { type: "NUMBER", nullable: true },
          image_url: { type: "STRING", nullable: true },
        },
        required: ["name_cn"],
      },
    },
  };

  let lastErr = "";
  for (let a = 0; a < 3; a++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        lastErr = "Gemini " + resp.status + " " + JSON.stringify(data).slice(0, 200);
        if (resp.status === 429) throw new Error("GEMINI_429 " + lastErr);
        if (resp.status === 503) { await new Promise((r) => setTimeout(r, 1500 * (a + 1))); continue; }
        throw new Error(lastErr);
      }
      const cand = (data.candidates || [])[0];
      const text = ((cand?.content?.parts) || []).map((p) => p?.text ?? "").join("");
      try {
        return JSON.parse(text);
      } catch (_e) {
        return null;
      }
    } catch (e) {
      lastErr = String(e);
      if (lastErr.includes("GEMINI_429")) break;
    }
  }
  throw new Error(lastErr || "Gemini 调用失败");
}

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
function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function cleanText(v, maxLength) {
  const s = (v ?? "").toString().trim();
  return s ? s.slice(0, maxLength) : null;
}
function safeHttpsUrl(v) {
  const s = (v ?? "").toString().trim();
  if (!s || s.length > 2048) return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" ? url.toString() : null;
  } catch (_e) {
    return null;
  }
}
function isAllowedSourceUrl(v) {
  try {
    const url = new URL(String(v));
    if (url.protocol !== "https:") return false;
    const configured = (Deno.env.get("ALLOWED_SOURCE_HOSTS") || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    const allowed = configured.length ? configured : DEFAULT_SOURCE_HOSTS;
    const hostname = url.hostname.toLowerCase();
    return allowed.some((host) => hostname === host || hostname.endsWith("." + host));
  } catch (_e) {
    return false;
  }
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
