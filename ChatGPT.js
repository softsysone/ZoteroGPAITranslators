{
	"translatorID": "9f90035c-d941-45d3-8f64-599bb7323ad8",
	"label": "ChatGPT",
	"creator": "Jacob J. Walker",
	"target": "^https?://(?:chatgpt\\.com|chat\\.openai\\.com)/(?:c/|share/|g/[^/]+/c/)",
	"minVersion": "5.0",
	"maxVersion": "",
	"priority": 100,
	"inRepository": true,
	"translatorType": 4,
        "browserSupport": "gcsibv",
        "lastUpdated": "2025-10-02 04:25:00"
}

/* ChatGPT translator — v0.3.29-alpha
 * Detect: /c/<id>, /share/..., /g/<project>/c/<id> → instantMessage
 * Authors: platform (ChatGPT) + human/workspace (corporate via XPath)
 * Date: store newest activity as LOCAL ISO8106 with timezone offset (e.g. 2025-09-25T20:45:49-04:00)
 * URL: prefer public /share/... if discovered via backend list match; else keep page URL
 * Attachment: snapshot of current page; add share page when available
 *
 * Changelog
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
  const VERSION = 'v0.3.29-alpha';
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
    item.attachments = [{ title: "ChatGPT Share Page Snapshot", document: doc }];
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
        item.attachments = [
          { title: "ChatGPT Share Page", url: shareURL, mimeType: "text/html" },
          { title: "ChatGPT Conversation Snapshot", url: url, mimeType: "text/html" }
        ];
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
  const r = await zoteroFetch(doc, '/api/auth/session');
  if (!r.ok || !r.data) {
    Zotero.debug(`[probe] /api/auth/session status=${r.status || 'fail'}`);
    return { token: null, userName: null };
  }
  const d = r.data;
  const token = d.accessToken || d.access_token || (d.user && (d.user.accessToken || d.user.access_token)) || null;
  const userName = d.user && d.user.name ? d.user.name.trim() : null;
  Zotero.debug(`[probe] session ok. token=${!!token}, user=${userName}`);
  return { token, userName };
}

// Simple, robust fetcher using Zotero.HTTP.request with cookies.
async function zoteroFetch(doc, path, options) {
  // Fallback for Scaffold IDE, which doesn't have Zotero.HTTP
  if (typeof Zotero.HTTP === 'undefined') {
    const url = new URL(path, doc && doc.location ? doc.location.href : undefined).href;
    const opts = Object.assign({ credentials: 'include' }, options || {});
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    const body = opts.body || null;
    const useCredentials = opts.credentials !== 'omit';

    try {
      return await fetchJSONInPage(doc, url, {
        method,
        headers,
        body,
        credentials: useCredentials ? 'include' : 'omit'
      });
    } catch (e) {
      Zotero.debug(`[scaffoldFetch-error] ${path}: ${e && e.message}`);
    }

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

      let data = null;
      try { data = JSON.parse(response.responseText); } catch {}
      const status = response.status || 0;
      const ok = status >= 200 && status < 300;
      return { ok, status, data };
    } catch (e) {
      Zotero.debug(`[scaffoldFetch-xhr-error] ${path}: ${e && e.message}`);
      return { ok: false, status: 0, data: null };
    }
  }
  
  // Live site logic: use Zotero.HTTP.request
  try {
    const url = new URL(path, doc.location.href).href;
    const opts = Object.assign({}, options);
    const method = (opts && opts.method ? String(opts.method) : 'GET').toUpperCase();
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'method')) {
      delete opts.method;
    }
    opts.headers = Object.assign({}, opts && opts.headers);
    // Manually pass the browser's cookies for authentication
    if (doc.cookie) {
      opts.headers['Cookie'] = doc.cookie;
    }

    if (method === 'GET' && opts && Object.prototype.hasOwnProperty.call(opts, 'body')) {
      delete opts.body;
    }

    const xhr = await Zotero.HTTP.request(method, url, opts);
    let data = null;
    try { data = JSON.parse(xhr.response); } catch {}
    return { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: data };
  } catch (e) {
    Zotero.debug(`[zoteroFetch-error] ${path}: ${e && e.message}`);
    return { ok: false, status: 0, data: null };
  }
}
/* ====== Page fetch bridge for sandboxed environments ====== */

async function fetchJSONInPage(doc, url, options) {
  const win = doc && doc.defaultView;
  if (!win) {
    throw new Error('No window available for page fetch');
  }

  const eventBinding = getWindowEventTarget(win);
  const docEventTarget = (doc && typeof doc.addEventListener === 'function') ? doc : null;
  if (!eventBinding && !docEventTarget) {
    throw new Error('Page environment does not support event listeners');
  }

  const channel = `zotero-chatgpt-fetch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = {
    url,
    options: sanitizeFetchOptionsForInjection(options),
    channel
  };

  const responseEventName = `zotero-chatgpt-fetch-response-${channel}`;

  const originForPostMessage = (win.location && win.location.origin && win.location.origin !== 'null')
    ? win.location.origin
    : '*';

  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      try {
        if (eventBinding) {
          eventBinding.removeEventListener('message', messageListener);
        }
      } catch (e) {
        debugFetchBridge(`[fetchBridge] remove listener failed: ${e && e.message}`);
      }
      if (docEventTarget) {
        try {
          docEventTarget.removeEventListener(responseEventName, customEventListener);
        } catch (e) {
          debugFetchBridge(`[fetchBridge] remove custom listener failed: ${e && e.message}`);
        }
      }
    };

    const handleDetail = (detail) => {
      cleanup();
      if (!detail) {
        reject(new Error('Page fetch bridge returned no data'));
        return;
      }
      if (detail.error) {
        reject(new Error(detail.error));
        return;
      }
      let parsed = null;
      if (typeof detail.text === 'string' && detail.text.length) {
        try { parsed = JSON.parse(detail.text); } catch {}
      }
      resolve({ ok: !!detail.ok, status: detail.status || 0, data: parsed });
    };

    const messageListener = (event) => {
      if (!event.data || event.data.channel !== channel) {
        return;
      }
      handleDetail(event.data);
    };

    const customEventListener = (event) => {
      if (!event || !event.detail || event.detail.channel !== channel) {
        return;
      }
      handleDetail(event.detail);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for page fetch response'));
    }, 10000);

    try {
      if (eventBinding) {
        eventBinding.addEventListener('message', messageListener);
      }
      if (docEventTarget) {
        docEventTarget.addEventListener(responseEventName, customEventListener);
      }
    } catch (e) {
      cleanup();
      throw e;
    }

    const script = doc.createElement('script');
    script.type = 'text/javascript';
    script.textContent = `
      (async () => {
        const payload = ${JSON.stringify(payload)};
        const targetOrigin = ${JSON.stringify(originForPostMessage)};
        try {
          const res = await fetch(payload.url, payload.options);
          const text = await res.text();
          const detail = { channel: payload.channel, ok: res.ok, status: res.status, text };
          if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
            window.postMessage(detail, targetOrigin === 'null' ? '*' : targetOrigin);
          }
          if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
            document.dispatchEvent(new CustomEvent(${JSON.stringify(responseEventName)}, { detail }));
          }
        } catch (err) {
          const message = err && err.message ? String(err.message) : String(err);
          const detail = { channel: payload.channel, error: message };
          if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
            window.postMessage(detail, targetOrigin === 'null' ? '*' : targetOrigin);
          }
          if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
            document.dispatchEvent(new CustomEvent(${JSON.stringify(responseEventName)}, { detail }));
          }
        }
      })();
    `;
    (doc.documentElement || doc).appendChild(script);
    script.remove();
  });
}

function debugFetchBridge(message) {
  if (typeof Zotero !== 'undefined' && typeof Zotero.debug === 'function') {
    Zotero.debug(message);
  }
}

function getWindowEventTarget(win) {
  const seen = new Set();
  const candidates = [];

  const enqueue = (candidate) => {
    if (!candidate) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  enqueue(win);
  enqueue(safeWindowLookup(win, 'wrappedJSObject'));
  enqueue(safeWindowLookup(win, 'window'));
  enqueue(safeWindowLookup(win, 'self'));
  enqueue(safeWindowLookup(win, 'top'));
  if (typeof window !== 'undefined') enqueue(window);
  if (typeof globalThis !== 'undefined') enqueue(globalThis);

  for (const candidate of candidates) {
    try {
      const add = candidate.addEventListener;
      const remove = candidate.removeEventListener;
      if (typeof add === 'function' && typeof remove === 'function') {
        return {
          target: candidate,
          addEventListener: add.bind(candidate),
          removeEventListener: remove.bind(candidate)
        };
      }
    } catch (e) {
      debugFetchBridge(`[fetchBridge] candidate rejected: ${e && e.message}`);
    }
  }

  return null;
}

function safeWindowLookup(win, prop) {
  try {
    return win && win[prop];
  } catch (e) {
    debugFetchBridge(`[fetchBridge] lookup ${prop} failed: ${e && e.message}`);
    return null;
  }
}

function sanitizeFetchOptionsForInjection(options) {
  const out = {
    method: options && options.method ? String(options.method).toUpperCase() : 'GET',
    credentials: options && options.credentials ? options.credentials : 'include'
  };
  if (options && options.headers && typeof options.headers === 'object') {
    out.headers = {};
    for (const [key, value] of Object.entries(options.headers)) {
      if (value != null) {
        out.headers[String(key)] = String(value);
      }
    }
  }
  if (options && options.body != null) {
    out.body = options.body;
  }
  return out;
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