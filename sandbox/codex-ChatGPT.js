/* ChatGPT translator — v0.4.0-beta
 * Detect: /c/<id>, /share/..., /g/<project>/c/<id> → instantMessage
 * Authors: platform (ChatGPT) + human/workspace (corporate via XPath)
 * Date: store newest activity as LOCAL ISO8106 with timezone offset (e.g. 2025-09-25T20:45:49-04:00)
 * URL: prefer public /share/... if discovered via backend list match; else keep page URL
 * Attachment: snapshot of current page when available
 *
 * Changelog
 * - v0.4.0-beta: First beta release with helper-based fetches and browser/scaffold
 *   compatibility for retrieving share URLs.
 * - v0.3.48-alpha: Retry session lookup with in-page fetch when helpers return
 *   anonymized data (restoring share detection in browsers and Scaffold).
 * - v0.3.47-alpha: Add default-view fallback when Zotero helper responses lack
 *   JSON (Scaffold compatibility).
 * - v0.3.46-alpha: Replace custom page bridge with Zotero request helpers and
 *   delete the injection fallback.
 * - v0.3.45-alpha: Drop share-page snapshot attachments to simplify saves.
 * - v0.3.44-alpha: Attempt a default-view fetch before installing the bridge and
 *   keep its response as a final fallback when Chromium blocks injected scripts.
 * - v0.3.43-alpha: Add verbose bridge readiness logging and fall back to a
 *   one-shot inline fetch when Chromium cannot reach the persistent bridge.
 * - v0.3.42-alpha: Wait for the page fetch bridge to signal readiness before
 *   sending requests so Chromium can keep shared URLs with valid tokens.
 * - v0.3.41-alpha: Retry auth via page bridge when ZU.request lacks the
 *   session token so Chromium keeps the shared URL.
 * - v0.3.40-alpha: Skip the ZU.request bridge when Zotero.HTTP isn't
 *   available (e.g. Scaffold), restoring the legacy session behaviour.
 * - v0.3.39-alpha: Ensure ZU.request keeps credentials by default so
 *   Scaffold regains session-bound share lookups.
 * - v0.3.38-alpha: Restore Cookie header passthrough so Scaffold keeps
 *   private-session access when bridge auth is missing.
 * - v0.3.37-alpha: Fix share-mode attachments (link + snapshot) and add
 *   post-share debug logging.
 * - v0.3.36-alpha: Route API calls through ZU.request/Zotero.HTTP to reuse
 *   connector cookie bridges and log which transport succeeds.
 * - v0.3.35-alpha: Log bridge installation state, normalize connector postMessage
 *   origin, and keep tracing payload routing for Chromium diagnosis.
 * - v0.3.34-alpha: Add page-context logging to compare Scaffold vs Chromium
 *   fetch behavior, tracing every bridge dispatch and fetch outcome.
 * - v0.3.33-alpha: Harmonize channel dispatch with page-world CustomEvents
 *   and broaden bridge listeners to catch Chromium connector traffic.
 * - v0.3.32-alpha: Fan out page-fetch requests across multiple channels and
 *   expose a direct bridge dispatcher for Chromium connector testing.
 * - v0.3.31-alpha: Add multi-channel page fetch debug instrumentation and
 *   fallbacks so Chromium connector can reach the ChatGPT APIs reliably.
 * - v0.3.30-alpha: Make the page-context fetch bridge persistent so Chromium
 *   connector can reuse it without timing out.
 * - v0.3.29-alpha: Respect the HTTP method/body that callers pass into
 *   `zoteroFetch` when running inside the live connector so POST/PUT
 *   requests succeed instead of being forced to GET.
 * - v0.3.28-alpha: Bridge page-context fetch responses through both
 *   CustomEvent dispatch and window.postMessage so Chromium-based
 *   connectors that restrict message listeners continue to receive
 *   responses reliably.
 * - v0.3.27-alpha: Rework the page-context fetch bridge so it binds the
 *   event listener functions from whichever window-like object is
 *   available, avoiding `win.addEventListener is not a function`
 *   failures that Chrome-based connectors were still hitting.
 * - v0.3.26-alpha: Harden the page-context fetch bridge so Chromium-based
 * connectors unwrap the real window before attaching message listeners,
 * avoiding `win.addEventListener` failures.
 * - v0.3.25-alpha: Added a resilient page-context fetch bridge so Chromium-based
 * connectors can retrieve session tokens and conversation metadata without
 * triggering network errors.
 * - v0.3.24-alpha: Fix Scaffold fallback fetch by resolving relative API URLs
 * against the current document before issuing the request.
 * - v0.3.23-alpha: Major simplification. Removed the complex, failing script-injection
 * mechanism. The translator now uses a single, reliable `Zotero.HTTP.request`
 * method for all API calls, with corrected logic to manually pass browser
 * cookies for authentication. This should work in the live connector.
 * - v0.3.22-alpha: Fixed a potential race condition in the script injection logic.
 * - v0.3.21-alpha: Fixed an infinite loop in the polling logic.
 * - v0.3.20-alpha: New communication strategy using a temporary DOM element.
 * - v0.3.19-alpha: Made the universalFetch fallback more robust.
*/

function detectWeb(doc, url) {
  // Now explicitly detects /c/, /g/.../c/, /share/, and /share/e/
  return /https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:c\/|g\/[^/]+\/c\/|share(?:\/e)?\/)/i.test(url)
    ? "instantMessage" : false;
}

async function doWeb(doc, url) {
  const VERSION = 'v0.4.0-beta';
  Zotero.debug(`doWeb ${VERSION}`);

  const item = new Zotero.Item("instantMessage");
  item.title = (doc && doc.title) ? doc.title : "ChatGPT Conversation";
  item.date = nowLocalOffset(); // Default date
  item.libraryCatalog = "OpenAI";

  const isSharePage = url.includes('/share');
  const id = extractIdFromAnyUrl(url);

  if (isSharePage && id) {
    // --- Scenario 1: We are on a public share page (no session) ---
    Zotero.debug(`[mode] Public Share Page, share_id=${id}`);
    item.creators = [
      { lastName: "ChatGPT", fieldMode: 1, creatorType: "author" },
      { lastName: getHumanFromXPath(doc) || "User", fieldMode: 1, creatorType: "author" }
    ];
    item.url = url;
    item.attachments = [];
    try {
      const meta = await getPublicShareMeta(doc, id);
      if (meta) {
        if (meta.title) { Zotero.debug(`[meta] title: ${meta.title}`); item.title = meta.title; }
        if (meta.isoDate) { Zotero.debug(`[meta] isoDate(local): ${meta.isoDate}`); item.date = meta.isoDate; }
      }
    } catch (e) {
      Zotero.debug(`[doWeb:share] error: ${e && e.message}`);
    }
  } else if (id) {
    // --- Scenario 2: We are on a private conversation page (has session) ---
    Zotero.debug(`[mode] Private Conversation Page, conv_id=${id}`);
    item.url = url; // Default URL
    item.extra = `Conversation ID: ${id}`;
    item.attachments = [{ title: "ChatGPT Conversation Snapshot", document: doc }];
    try {
      const auth = await getAuthInfoFromSession(doc);
      
      const human = auth.userName || getHumanFromXPath(doc) || "User";
      item.creators = [
        { lastName: "ChatGPT", fieldMode: 1, creatorType: "author" },
        { lastName: human, fieldMode: 1, creatorType: "author" }
      ];

      const meta = await getConversationMetaFromHiddenAPI(doc, id, auth.token);
      if (meta) {
        if (meta.title) { Zotero.debug(`[meta] title: ${meta.title}`); item.title = meta.title; }
        if (meta.isoDate) { Zotero.debug(`[meta] isoDate(local): ${meta.isoDate}`); item.date = meta.isoDate; }
      }

      const shareURL = await getActiveShareURLForConversation(doc, id, auth.token);
      if (shareURL) {
        Zotero.debug(`[meta] shareURL found: ${shareURL}`);
        item.url = shareURL;
        item.extra = `Share URL: ${shareURL}\nConversation ID: ${id}`;
        Zotero.debug(`[share] final url set to ${item.url}`);
        try {
          const attachDebug = item.attachments.map(a => ({
            title: a.title,
            hasDocument: !!a.document,
            url: a.url || null,
            snapshot: Object.prototype.hasOwnProperty.call(a, 'snapshot') ? a.snapshot : null
          }));
          Zotero.debug(`[share] attachments ${JSON.stringify(attachDebug)}`);
        } catch (_) {}
      }
    } catch (e) {
      Zotero.debug(`[doWeb:private] error: ${e && e.message}`);
    }
  } else {
    // Fallback for URLs that passed detection but not ID extraction
    item.creators = [
        { lastName: "ChatGPT", fieldMode: 1, creatorType: "author" },
        { lastName: getHumanFromXPath(doc) || "User", fieldMode: 1, creatorType: "author" }
    ];
    item.url = url;
    item.attachments = [{ title: "ChatGPT Conversation Snapshot", document: doc }];
  }

  item.complete();
}

/* ===================== Helpers ===================== */

function getHumanFromXPath(doc) {
  try {
    const node = doc.evaluate(
      '//*[@id][starts-with(@id,"radix-")]/div[2]/div[1]/div',
      doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
    const txt = node && node.textContent && node.textContent.trim();
    if (txt) {
      Zotero.debug(`[author:xpath] "${txt}"`);
      return txt;
    }
  } catch (e) {
    Zotero.debug(`[author:xpath] error: ${e && e.message}`);
  }
  return null;
}

function extractIdFromAnyUrl(url) {
  const m = url.match(/(?:c|share(?:\/e)?)\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

/* ---------- API Functions ---------- */

async function getConversationMetaFromHiddenAPI(doc, convId, token) {
  if (!token) { Zotero.debug(`[probe] token not provided`); return null; }

  const r = await zoteroFetch(
    doc,
    `/backend-api/conversation/${convId}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
  );
  Zotero.debug(`[probe] conv (token) status=${r.status} ok=${r.ok}`);
  if (!r.ok || !r.data) return null;

  const conv = r.data;
  const title = (typeof conv.title === 'string' && conv.title.trim()) ? conv.title.trim() : null;
  const isoLocal = pickIsoDate(conv);
  return { title, isoDate: isoLocal };
}

async function getPublicShareMeta(doc, shareId) {
  const r = await zoteroFetch(
    doc,
    `/backend-api/public/conversation/${shareId}`,
    { headers: { 'Accept': 'application/json' } }
  );
  Zotero.debug(`[probe] public conv status=${r.status} ok=${r.ok}`);
  if (!r.ok || !r.data) return null;

  const conv = r.data;
  const title = (typeof conv.title === 'string' && conv.title.trim()) ? conv.title.trim() : null;
  const isoLocal = pickIsoDate(conv);
  return { title, isoDate: isoLocal };
}

async function getActiveShareURLForConversation(doc, convId, token) {
  if (!token) { Zotero.debug('[share] no token provided, skipping'); return null; }

  const list = await zoteroFetch(
    doc,
    `/backend-api/shared_conversations?order=created`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
  );
  Zotero.debug(`[share] list status=${list.status} ok=${list.ok}`);
  if (!list.ok || !list.data || !Array.isArray(list.data.items)) return null;

  const items = list.data.items.filter(x => x && (x.conversation_id === convId));
  if (!items.length) {
    Zotero.debug('[share] no matching conversation_id found in shared list');
    return null;
  }

  items.sort((a, b) => (parseMaybeTimeToMs(b.update_time) || 0) - (parseMaybeTimeToMs(a.update_time) || 0));
  const best = items[0];
  const shareId = best.id || best.share_id;
  if (!shareId) return null;

  const host = (doc.location && String(doc.location.host).includes('chat.openai.com'))
    ? 'https://chat.openai.com' : 'https://chatgpt.com';
  return `${host}/share/${shareId}`;
}

async function getAuthInfoFromSession(doc) {
  const sessionPath = '/api/auth/session';
  const sessionHeaders = { 'Accept': 'application/json' };
  const r = await zoteroFetch(doc, sessionPath, { headers: sessionHeaders, responseType: 'json' });
  if (!r.ok || !r.data) {
    Zotero.debug(`[probe] /api/auth/session status=${r.status || 'fail'}`);
    return { token: null, userName: null };
  }
  let data = r.data;
  let token = data && typeof data === 'object'
    ? (data.accessToken || data.access_token || (data.user && (data.user.accessToken || data.user.access_token)) || null)
    : null;
  let userName = data && data.user && data.user.name ? data.user.name.trim() : null;

  if (!token && doc && doc.defaultView && typeof doc.defaultView.fetch === 'function') {
    const origin = doc.location && doc.location.origin ? doc.location.origin : 'https://chatgpt.com';
    const absoluteURL = new URL(sessionPath, origin).href;
    const fallback = await fetchViaDefaultView(doc, absoluteURL, 'GET', sessionHeaders, null, true, '[probe] session default-view');
    if (fallback && fallback.ok && fallback.parsed && typeof fallback.parsed === 'object') {
      data = fallback.parsed;
      token = data.accessToken || data.access_token || (data.user && (data.user.accessToken || data.user.access_token)) || null;
      userName = data.user && data.user.name ? data.user.name.trim() : userName;
    }
  }

  if (!token) {
    Zotero.debug('[probe] session fallback failed to obtain token');
    return { token: null, userName: userName || null };
  }

  Zotero.debug(`[probe] session ok. token=${!!token}, user=${userName}`);
  return { token, userName };
}

function safeParseJSON(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string' && value.length) {
    try { return JSON.parse(value); }
    catch { return null; }
  }
  return null;
}

// Simple, robust fetcher with multiple fallbacks (connector-friendly first).
async function zoteroFetch(doc, path, options) {
  const baseHref = doc && doc.location ? String(doc.location.href) : null;
  let url;
  try {
    url = new URL(path, baseHref || undefined).href;
  } catch (_) {
    url = path;
  }
  const opts = Object.assign({ headers: {}, method: 'GET' }, options || {});
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({}, opts.headers || {});
  const body = opts.body !== undefined ? opts.body : null;
  const label = `[zoteroFetch] ${method} ${path}`;

  const wantsJSON = (() => {
    if (opts.responseType === 'json') return true;
    const accept = headers.Accept || headers.accept;
    if (accept && typeof accept === 'string' && accept.toLowerCase().includes('application/json')) {
      return true;
    }
    return false;
  })();

  const finalize = (status, raw, jsonCandidate) => {
    if (wantsJSON) {
      const parsed = jsonCandidate !== undefined ? jsonCandidate : safeParseJSON(raw);
      return { ok: status >= 200 && status < 300, status, data: parsed };
    }
    return { ok: status >= 200 && status < 300, status, data: raw };
  };

  // Preferred path: ZU.request (available in translator sandbox + connector)
  try {
    if (typeof ZU !== 'undefined' && typeof ZU.request === 'function') {
      const params = {
        method,
        headers,
        responseType: wantsJSON ? 'json' : 'text'
      };
      if (method !== 'GET' && method !== 'HEAD' && body != null) {
        params.body = body;
      }
      if (opts.timeout) {
        params.timeout = opts.timeout;
      }
      Zotero.debug(`${label} via ZU.request`);
      const resp = await ZU.request(url, params);
      const status = resp && typeof resp.status === 'number' ? resp.status : 0;
      const raw = resp && (resp.responseText !== undefined ? resp.responseText : resp.body !== undefined ? resp.body : null);
      const jsonCandidate = wantsJSON ? (resp && (resp.responseJSON !== undefined ? resp.responseJSON : safeParseJSON(raw))) : undefined;
      let result = finalize(status, raw, jsonCandidate);
      if (wantsJSON && (!result.data || typeof result.data !== 'object')) {
        const fallback = await fetchViaDefaultView(doc, url, method, headers, body, wantsJSON, `${label} (default-view fallback)`);
        if (fallback && fallback.ok && fallback.parsed && typeof fallback.parsed === 'object') {
          return finalize(fallback.status, fallback.raw, fallback.parsed);
        }
      }
      return result;
    }
  } catch (e) {
    Zotero.debug(`${label} ZU.request error: ${e && e.message}`);
  }

  // Secondary path: Zotero.HTTP.request (background-bridged, carries cookies)
  try {
    if (typeof Zotero !== 'undefined' && Zotero.HTTP && typeof Zotero.HTTP.request === 'function') {
      const httpOpts = {
        headers,
        responseType: 'text'
      };
      if (method !== 'GET' && method !== 'HEAD' && body != null) {
        httpOpts.body = body;
      }
      if (opts.timeout) {
        httpOpts.timeout = opts.timeout;
      }
      Zotero.debug(`${label} via Zotero.HTTP.request`);
      const xhr = await Zotero.HTTP.request(method, url, httpOpts);
      const raw = xhr && typeof xhr.response === 'string' ? xhr.response : (xhr && xhr.responseText);
      const status = xhr && typeof xhr.status === 'number' ? xhr.status : 0;
      let result = finalize(status, raw, undefined);
      if (wantsJSON && (!result.data || typeof result.data !== 'object')) {
        const fallback = await fetchViaDefaultView(doc, url, method, headers, body, wantsJSON, `${label} (default-view fallback)`);
        if (fallback && fallback.ok && fallback.parsed && typeof fallback.parsed === 'object') {
          return finalize(fallback.status, fallback.raw, fallback.parsed);
        }
      }
      return result;
    }
  } catch (e) {
    Zotero.debug(`${label} Zotero.HTTP.request error: ${e && e.message}`);
  }

  // Legacy fallback: page-context bridge for environments without HTTP helpers
  const useCredentials = opts.credentials !== 'omit';
  const w = doc && doc.defaultView;
  const XHR = (w && w.XMLHttpRequest) ? w.XMLHttpRequest : (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null);
  if (!XHR) {
    return { ok: false, status: 0, data: null };
  }

  try {
    const xhr = new XHR();
    xhr.open(method, url, true);
    if ('withCredentials' in xhr) {
      xhr.withCredentials = useCredentials;
    }
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    const response = await new Promise((resolve, reject) => {
      xhr.onload = () => resolve(xhr);
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onabort = () => reject(new Error('Request aborted'));
      xhr.send(body);
    });

    const status = response.status || 0;
    let result = finalize(status, response.responseText, undefined);
    if (wantsJSON && (!result.data || typeof result.data !== 'object')) {
      const fallback = await fetchViaDefaultView(doc, url, method, headers, body, wantsJSON, `${label} (default-view fallback)`);
      if (fallback && fallback.ok && fallback.parsed && typeof fallback.parsed === 'object') {
        return finalize(fallback.status, fallback.raw, fallback.parsed);
      }
    }
    return result;
  } catch (e) {
    Zotero.debug(`[scaffoldFetch-xhr-error] ${path}: ${e && e.message}`);
    return { ok: false, status: 0, data: null };
  }
}

async function fetchViaDefaultView(doc, url, method, headers, body, wantsJSON, label) {
  const win = doc && doc.defaultView;
  if (!win || typeof win.fetch !== 'function') {
    return null;
  }

  const fetchHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value != null) {
      fetchHeaders[key] = String(value);
    }
  }

  const fetchOptions = {
    method,
    credentials: 'include',
    headers: fetchHeaders
  };
  if (body != null) {
    fetchOptions.body = body;
  }

  try {
    Zotero.debug(`${label} via defaultView.fetch`);
    const response = await win.fetch(url, fetchOptions);
    const status = typeof response.status === 'number' ? response.status : 0;
    let raw = '';
    try {
      raw = await response.text();
    } catch (_) {}
    const parsed = wantsJSON ? safeParseJSON(raw) : null;
    return { ok: !!response.ok, status, raw, parsed };
  } catch (e) {
    Zotero.debug(`${label} default-view error: ${e && e.message}`);
    return null;
  }
}
/* ====== time extraction (now returns LOCAL timestamp with offset) ====== */

function pickIsoDate(conv) {
  const times = [];
  pushIfParsed(times, conv && conv.update_time, 'top.update_time');
  pushIfParsed(times, conv && conv.create_time, 'top.create_time');
  if (conv && conv.mapping && typeof conv.mapping === 'object') {
    for (const k in conv.mapping) {
      const msg = conv.mapping[k] && conv.mapping[k].message;
      if (!msg) continue;
      pushIfParsed(times, msg.create_time, `mapping[${k}].msg.create_time`);
    }
  }
  if (!times.length) { Zotero.debug('[meta] no timestamps found in payload'); return null; }
  times.sort((a, b) => b.ms - a.ms);
  const top = times[0];
  const isoLocal = formatLocalOffset(top.ms);
  Zotero.debug(`[meta] newest ts from ${top.src}: ms=${top.ms} isoLocal=${isoLocal}`);
  return isoLocal;
}

function pushIfParsed(arr, v, src) {
  const ms = parseMaybeTimeToMs(v);
  if (ms != null && isFinite(ms)) arr.push({ ms, src: src || '?' });
}

function parseMaybeTimeToMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // sec -> ms
  if (typeof v === 'string') {
    const s = v.trim();
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.getTime();
    const n = Number(s);
    if (!isNaN(n)) return n < 1e12 ? n * 1000 : n;
  }
  return null;
}

/* ====== local time formatting helpers ====== */

function nowLocalOffset() {
  return formatLocalOffset(Date.now());
}

function formatLocalOffset(ms) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const tzMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = tzMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzMin);
  const tzh = String(Math.floor(abs / 60)).padStart(2, '0');
  const tzm = String(abs % 60).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${sign}${tzh}:${tzm}`;
}

/** BEGIN TEST CASES **/
var testCases = [
]
/** END TEST CASES **/

