// ============================================================
// Supabase Edge Function: parse-dewu-link
// 「贴链接 / 贴分享文字 → 自动解析入库」的解析后端。
//
// 自动判断（函数内部）：
//   1. 输入里有 http → 去抓得物页面
//        · 页面正常 → 把页面文字交给 Gemini 读，抠出商品信息
//        · 页面是验证/拦截页 → 判定被拦，回提示让用户改贴分享文字
//   2. 输入没链接（纯文字）→ 直接 Gemini 解析文字（最稳路径）
//
// 解析出的字段用 service_role 直接入库 products_369，返回入库行给前端预览。
// 需要设 secret：GEMINI_KEY（Google Gemini 解析用，去 aistudio.google.com 拿，有免费额度）
// 部署：supabase functions deploy parse-dewu-link（verify_jwt 保持开启）
// ============================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type ParsedProduct = {
  name_cn: string | null;
  brand?: string | null;
  sku?: string | null;
  price_rmb?: number | null;
  image_url?: string | null;
};

type ProductUpdate = {
  name_cn?: string;
  brand?: string | null;
  sku?: string | null;
  price_rmb?: number | null;
  price_myr?: number | null;
  image_url?: string;
  images?: string[];
};

type DewuPage =
  | { blocked: true }
  | { blocked: false; text: string; images: string[]; image: string | null };

// —— 人民币 → 马币 汇率（成本折算用，按实时行情自行调整）——
const RATE_RMB_TO_MYR = 0.62;
// —— 解析模型：Google Gemini（免费额度，跑在 Google 服务端）——
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

    const authorization = req.headers.get("authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ ok: false, error: "请先登录管理员账号" }, 401, cors);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) {
      return json({ ok: false, error: "登录已失效，请重新登录" }, 401, cors);
    }
    const { data: adminRow, error: adminError } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (adminError) {
      console.error("Admin lookup failed", adminError.message);
      return json({ ok: false, error: "无法验证管理员权限" }, 500, cors);
    }
    if (!adminRow) return json({ ok: false, error: "此账号没有管理员权限" }, 403, cors);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const input = (body.input || "").toString().trim();
    const tgValue = Number(body.tgId);
    const tgId = body.tgId != null && Number.isSafeInteger(tgValue) && tgValue > 0 ? tgValue : null;
    const reqId = body.reqId ? String(body.reqId).slice(0, 60) : null;

    if (!input) return json({ ok: false, error: "没有输入内容" }, 400, cors);
    if (input.length > MAX_INPUT_CHARS) {
      return json({ ok: false, error: `输入内容不能超过 ${MAX_INPUT_CHARS} 字` }, 400, cors);
    }

    // —— 判断输入里有没有链接 ——
    const urlMatch = input.match(/https?:\/\/[^\s，。、]+/);
    const sourceUrl = urlMatch ? urlMatch[0] : null;
    if (sourceUrl && !isAllowedSourceUrl(sourceUrl)) {
      return json({ ok: false, error: "只支持得物官方商品链接" }, 400, cors);
    }
    // 去掉链接后还剩多少字：几乎没剩 = 纯链接；剩很多 = 分享文字里夹了个链接
    const textWithoutUrl = sourceUrl ? input.replace(sourceUrl, "").trim() : input;
    const linkOnly = !!sourceUrl && textWithoutUrl.length < 8;

    // —— 幂等去重：弱网下前端会用同一个 reqId 反复重发，命中已存在的就直接返回，别重复入库 ——
    if (reqId) {
      const { data: dup } = await supabase
        .from("products_369")
        .select("*")
        .eq("client_ref", reqId)
        .limit(1)
        .maybeSingle();
      if (dup) return json({ ok: true, product: dup, pending: /^[⏳⚠]/.test(dup.name_cn || "") }, 200, cors);
    }

    // 先秒速入库一行「占位」并立刻返回，Gemini 解析 + 抓图放后台跑，抓到再回填这行。
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
    const edgeRuntime = (globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void };
    }).EdgeRuntime;
    try { edgeRuntime ? edgeRuntime.waitUntil(bg) : await bg; } catch (_e) { await bg; }

    return json({ ok: true, product: data, pending: true }, 200, cors);
  } catch (e) {
    console.error("parse-dewu-link failed", e);
    return json({ ok: false, error: "解析服务暂时不可用，请稍后重试" }, 500, cors);
  }
});

// —— 抓页面(图) → Gemini 解析 → 回填这一行（占位行已存在，按 rowId 更新）——
async function fillRow(
  supabase: SupabaseClient,
  apiKey: string,
  rowId: number,
  material0: string,
  sourceUrl: string | null,
  linkOnly: boolean,
) {
  try {
    let material = material0, fromPage = false, gallery: string[] | null = null;
    // 有链接就抓页面：拿商品图；纯链接还得靠页面文字来解析
    if (sourceUrl) {
      const page = await fetchDewuPage(sourceUrl);
      if (!page.blocked) {
        gallery = page.images && page.images.length ? page.images : (page.image ? [page.image] : null);
        if (linkOnly) { material = page.text; fromPage = true; }
      } else if (linkOnly) {
        await supabase.from("products_369")
          .update({ name_cn: "⚠️ 链接被拦，请改贴『分享文字』重解析" })
          .eq("id", rowId);
        return;
      }
    }

    const parsed = await parseWithGemini(apiKey, material, fromPage);
    const upd: ProductUpdate = {};
    if (parsed && parsed.name_cn) {
      const priceRmb = toNum(parsed.price_rmb);
      const validPriceRmb = priceRmb != null && priceRmb >= 0 && priceRmb <= 10_000_000 ? priceRmb : null;
      upd.name_cn = cleanText(parsed.name_cn, 240) || "⚠️ 没解析出商品，点『编辑』手填或删除";
      upd.brand = cleanText(parsed.brand, 120);
      upd.sku = cleanText(parsed.sku, 120);
      upd.price_rmb = validPriceRmb;
      upd.price_myr = validPriceRmb != null ? Math.round(validPriceRmb * RATE_RMB_TO_MYR * 100) / 100 : null;
    } else {
      upd.name_cn = "⚠️ 没解析出商品，点『编辑』手填或删除";
    }
    const safeGallery = (gallery || [])
      .map(safeHttpsUrl)
      .filter((url): url is string => Boolean(url))
      .slice(0, 12);
    const parsedImage = safeHttpsUrl(parsed && parsed.image_url);
    const imageUrl = safeGallery[0] || parsedImage;
    if (imageUrl) {
      upd.image_url = imageUrl;
      upd.images = safeGallery.length ? safeGallery : [imageUrl];
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

function allowedSourceHosts(): string[] {
  const configured = (Deno.env.get("ALLOWED_SOURCE_HOSTS") || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_SOURCE_HOSTS;
}

function isAllowedSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return allowedSourceHosts().some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
    );
  } catch (_e) {
    return false;
  }
}

async function readTextLimited(resp: Response, maxBytes: number): Promise<string> {
  const length = Number(resp.headers.get("content-length") || 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error("PAGE_TOO_LARGE");
  if (!resp.body) return "";

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("PAGE_TOO_LARGE");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// —— 抓得物页面：返回文字，或判定被拦 ——
async function fetchDewuPage(url: string): Promise<DewuPage> {
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
    if (contentType && !contentType.includes("text/html")) return { blocked: true };
    const html = await readTextLimited(resp, MAX_PAGE_BYTES);

    // 拦截/验证页特征：太短，或出现验证/滑块/风控关键词
    const blockedSigns = ["验证", "滑块", "captcha", "punish", "安全验证", "拦截", "机器人", "abnormal"];
    const looksBlocked =
      html.length < 1500 || blockedSigns.some((s) => html.includes(s));
    // 商品页应至少含价格/商品相关信号
    const looksProduct = /价格|¥|price|spuId|skuId|商品|productName/i.test(html);
    if (looksBlocked && !looksProduct) return { blocked: true };

    return {
      blocked: false,
      text: htmlToText(html).slice(0, 50000),
      images: extractImages(html),
      image: extractMain(html),
    };
  } catch (_e) {
    // 抓取超时/失败也当被拦，引导走分享文字
    return { blocked: true };
  }
}

// —— 抓商品图库（多图）——
// 得物页面有两套图：① 商品主图 = pro-img/origin-img|cut-img（顶部轮播，要的就是这个）；
//                   ② 详情图 = trade/gondor（isConcat 拼接长图，描述用，不要）。
// 所以优先抓 pro-img；没有再退回 trade/gondor（部分商品如毛绒公仔用它当主图）。
// node-common/…是「得物」水印占位图，一律跳过。
const RE_PROIMG = /https?:(?:\\?\/){2}[^"'\\ ]*?pro-img(?:\\?\/)(?:origin|cut)-img(?:\\?\/)[^"'\\ ]+?\.(?:jpg|jpeg|png|webp)/gi;
function collectRe(html: string, re: RegExp): string[] {
  const seen = new Set(), out = [];
  let m; re.lastIndex = 0;
  while ((m = re.exec(html))) { const u = unescapeUrl(m[0]); if (!seen.has(u)) { seen.add(u); out.push(u); } }
  return out;
}
function galleryStart(html: string): number {
  let from = 0, idx;
  while ((idx = html.indexOf('"images":[{"url":"', from)) >= 0) {
    const head = html.slice(idx + 17, idx + 400);
    if (/trade(?:\\?\/)gondor/.test(head)) return idx;
    from = idx + 10;
  }
  return html.indexOf('"images":[{"url":"');
}
function extractImages(html: string): string[] {
  // ① 优先：商品主图库 pro-img（同一张的 cut/origin 按文件名去重，保留 origin 高清）
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
  // ② 兜底：trade/gondor 图库（过滤水印占位 + 拼接长图）
  const start = galleryStart(html);
  if (start < 0) return [];
  const end = html.indexOf("}]", start);
  const seg = end > start ? html.slice(start, end + 2) : html.slice(start, start + 4000);
  const raw = [...seg.matchAll(/"url"\s*:\s*"(https?:(?:\\\/|\/)[^"\\]+)"/g)].map((m) => unescapeUrl(m[1]));
  const seen = new Map(); // 同一张图不同尺寸只留最大的，保留出现顺序
  for (const u0 of raw) {
    const uq = u0.split("?")[0];
    if (!/\.(jpg|jpeg|png|webp)$/i.test(uq)) continue;
    if (/node-common/i.test(uq)) continue; // node-common 是「得物」水印占位图，跳过
    const dm = uq.match(/-w(\d+)h(\d+)\.(?:jpg|jpeg|png|webp)$/i);
    let key = uq, md = 9999;
    if (dm) {
      const w = +dm[1], h = +dm[2], mn = Math.min(w, h), ar = mn / Math.max(w, h);
      if (mn < 200 || ar < 0.55) continue; // 跳过小图/尺码横幅/长图
      key = uq.replace(/-w\d+h\d+(\.[a-z]+)$/i, "$1");
      md = mn;
    }
    const prev = seen.get(key);
    if (!prev || md > prev.md) seen.set(key, { url: uq, md });
  }
  return [...seen.values()].map((x) => x.url).slice(0, 10);
}
// —— 单张主图（图库抓不到时的兜底）——
function extractMain(html: string): string | null {
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
function unescapeUrl(u: string): string {
  return u.replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&").trim();
}

// —— 粗略把 HTML 变成可读文字（保留内嵌 JSON，便于 Gemini 抠字段）——
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, " $1 ") // 保留 script 内的 JSON 文本
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// —— 调 Gemini，结构化输出商品字段（关 thinking 提速，temperature 0 稳定）——
async function parseWithGemini(apiKey: string, material: string, fromPage: boolean): Promise<ParsedProduct | null> {
  const instr =
    "你是得物（poizon）商品信息解析器。从给定内容里抠出单个商品的：中文名(name_cn)、品牌(brand)、" +
    "货号SKU(sku)、得物人民币价格(price_rmb，元，纯数字)、商品主图链接(image_url)。" +
    "抠不到的字段填 null。价格只要数字（元），不要货币符号。只解析最主要的那个商品。";
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
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        lastErr = "Gemini " + resp.status + " " + JSON.stringify(data).slice(0, 200);
        // 429=免费额度/限流：重试也没用（额度不会几秒内恢复），直接抛出让上层给友好提示
        if (resp.status === 429) throw new Error("GEMINI_429 " + lastErr);
        if (resp.status === 503) { await new Promise((r) => setTimeout(r, 1500 * (a + 1))); continue; }
        throw new Error(lastErr);
      }
      const cand = (data.candidates || [])[0];
      const text = ((cand?.content?.parts) || []).map((p: { text?: string }) => p?.text ?? "").join("");
      try {
        return JSON.parse(text);
      } catch (_e) {
        return null;
      }
    } catch (e) {
      lastErr = String(e);
      if (lastErr.includes("GEMINI_429")) break; // 限流就别重试了，快点失败给友好提示
    }
  }
  throw new Error(lastErr || "Gemini 调用失败");
}

// —— 从分享文字里快速猜个临时名（占位用，后台解析好会覆盖）——
function quickName(input: string, url: string | null): string | null {
  let t = input;
  if (url) t = t.split(url).join(" ");
  t = t
    .replace(/【[^】]*】/g, " ")
    .replace(/[A-Za-z0-9_]+发现一件好物[，,]?/g, " ")
    .replace(/点击链接直接打开/g, " ")
    .replace(/复制此?(条)?(链接|信息|口令)[\s\S]*$/g, " ")
    .replace(/[a-z0-9]{6,}(?=\s)/gi, " ") // 去掉分享口令那串乱码
    .replace(/\s+/g, " ")
    .trim();
  return t ? "⏳ " + t.slice(0, 40) : null;
}
function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function cleanText(v: unknown, maxLength: number): string | null {
  const s = (v ?? "").toString().trim();
  return s ? s.slice(0, maxLength) : null;
}
function safeHttpsUrl(v: unknown): string | null {
  const s = (v ?? "").toString().trim();
  if (!s || s.length > 2048) return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" ? url.toString() : null;
  } catch (_e) {
    return null;
  }
}
function json(obj: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
