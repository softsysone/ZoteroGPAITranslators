/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2025 Jacob J. Walker

	This file is part of Zotero.

	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero. If not, see <http://www.gnu.org/licenses/>.

	***** END LICENSE BLOCK *****
*/


/* @file ChatGPT translator — v0.5.1-alpha
 * Detect: /c/<id>, /share/..., /g/<project>/c/<id> → instantMessage
 * Authors: platform (ChatGPT) + human/workspace (corporate via XPath)
 * Date: store newest activity as local ISO8601 with timezone offset (e.g. 2025-09-25T20:45:49-04:00)
 * URL: prefer public /share/... if discovered via backend list match; else keep page URL
 * Attachment: snapshot of current page when available
 *
 * Changelog
 * - v0.5.1-alpha: Refactored metadata fetch helpers to align with the Gemini translator
 *   layout while keeping behavior unchanged.
 * - v0.5.0-beta: Ensured resilient share detection (metadata/DOM probes + quick backend checks), 
 *   smarter private URL handling, and consistent snapshots across public and private pages.
 * - v0.4.0: Stabilized the translator by preferring connector helpers (ZU.request →
 *   Zotero.HTTP → page fetch), keeping API calls same-origin, parsing helper text
 *   responses as JSON, and discovering share links deterministically with local-offset
 *   metadata.
 */

const ZOTERO_FETCH_DEFAULT_TIMEOUT_MS = 7000;
const SHARE_LIST_TIMEOUT_MS = 3500;
const SHARE_PROBE_TIMEOUT_MS = 2000;
const SHARE_URL_REGEX = /https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/share\/([0-9a-f-]{36})/i;
const SHARE_PATH_REGEX = /^\/?share\/([0-9a-f-]{36})/i;
const SHARE_ID_REGEX = /[0-9a-f-]{36}/i;
const NO_SHARE_CONFIRMED = Symbol('chatgpt:no-share');

function detectWeb(doc, url) {
  // Now explicitly detects /c/, /g/.../c/, /share/, and /share/e/
  return /https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:c\/|g\/[^/]+\/c\/|share(?:\/e)?\/)/i.test(url)
    ? "instantMessage" : false;
}

async function doWeb(doc, url) {
  const VERSION = 'v0.5.1-alpha';
  Zotero.debug(`doWeb ${VERSION}`);

  // Sets defaults that will be changed later
  const item = new Zotero.Item("instantMessage");
  item.title = cleanTitle(doc && doc.title) || "ChatGPT Conversation";
  item.date = nowLocalOffset(); // Default date
  item.libraryCatalog = "OpenAI";

  // Gets information about the chat session and URL
  const isSharePage = url.includes('/share');
  const id = extractIdFromAnyUrl(url);

  if (id && !isSharePage) {
    // --- Scenario 1: We are on a private conversation page (has session) ---
    Zotero.debug(`[mode] Private Conversation Page, conv_id=${id}`);
    const privateConversationURL = url;
    item.url = privateConversationURL; // Default URL
    item.attachments = [buildSnapshotAttachment(doc, privateConversationURL)];
    try {
      const auth = await getAuthInfoFromSession(doc);

      const human = auth.userName || getHumanFromXPath(doc) || "User";
      item.creators = [
        { lastName: "ChatGPT", fieldMode: 1, creatorType: "author" },
        { lastName: human, fieldMode: 1, creatorType: "author" }
      ];

      const meta = (await fetchConversationMeta(doc, id, auth)) || {};
      if (meta.title) { Zotero.debug(`[meta] title: ${meta.title}`); item.title = meta.title; }
      if (meta.isoDate) { Zotero.debug(`[meta] isoDate(local): ${meta.isoDate}`); item.date = meta.isoDate; }

      const shareCandidates = [];
      if (meta.shareURL) {
        Zotero.debug(`[meta] shareURL (embedded) ${meta.shareURL}`);
        shareCandidates.push(meta.shareURL);
      }
      if (meta.shareURLFromDocument) {
        Zotero.debug(`[meta] shareURL (document) ${meta.shareURLFromDocument}`);
        shareCandidates.push(meta.shareURLFromDocument);
      }

      let skipShareList = false;
      if (auth.token) {
        const probeResult = await probeForShareURL(doc, id, auth.token);
        if (probeResult === NO_SHARE_CONFIRMED) {
          skipShareList = true;
        } else if (probeResult) {
          shareCandidates.push(probeResult);
        }
      }

      if (!skipShareList && auth.token) {
        const shareFromList = await getActiveShareURLForConversation(doc, id, auth.token);
        if (shareFromList) {
          shareCandidates.push(shareFromList);
        }
      }

      let shareURL = shareCandidates.find(Boolean) || null;
      if (shareURL) {
        Zotero.debug(`[meta] shareURL found: ${shareURL}`);
        item.url = shareURL;
        item.extra = `Private URL: ${privateConversationURL}`;
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
  } else if (isSharePage && id) {
    // --- Scenario 2: We are on a public share page (no session) ---
    Zotero.debug(`[mode] Public Share Page, share_id=${id}`);
    item.creators = [
      { lastName: "ChatGPT", fieldMode: 1, creatorType: "author" },
      { lastName: getHumanFromXPath(doc) || "User", fieldMode: 1, creatorType: "author" }
    ];
    item.url = url;
    item.attachments = [buildSnapshotAttachment(doc, url)];
    try {
      const meta = await fetchPublicShareMeta(doc, id);
      if (meta) {
        if (meta.title) { Zotero.debug(`[meta] title: ${meta.title}`); item.title = meta.title; }
        if (meta.isoDate) { Zotero.debug(`[meta] isoDate(local): ${meta.isoDate}`); item.date = meta.isoDate; }
      }
    } catch (e) {
      Zotero.debug(`[doWeb:share] error: ${e && e.message}`);
    }
  } else {
    // Fallback for URLs that passed detection but not ID extraction
    item.creators = [
        { lastName: "ChatGPT", fieldMode: 1, creatorType: "author" },
        { lastName: getHumanFromXPath(doc) || "User", fieldMode: 1, creatorType: "author" }
    ];
    item.url = url;
    item.attachments = [buildSnapshotAttachment(doc, url)];
  }

  item.complete();
}


/* ============= Pattern to Refactor To ============== */

// getItem handles data extraction for a single item page.
function getItem(doc, url) {
	// Create the new Zotero item with the appropriate type (e.g., "journalArticle").
	let item = new Zotero.Item(getType(doc, url));

	// Populate core metadata by delegating to helper accessors.
	item.title = getTitle(doc, url);

	// Add creators returned from getAuthors, which should yield an array of
	// creator objects (e.g., via ZU.cleanAuthor).
	for (let creator of getAuthors(doc, url)) {
		item.creators.push(creator);
	}

	item.date = getDate(doc, url);
	item.url = getURL(doc, url);

	let extra = getExtra(doc, url);
	if (extra) {
		item.extra = extra;
	}

	// Populate additional fields such as abstractNote, language,
	// publicationTitle, etc. Use ZU utilities (e.g., ZU.xpathText,
	// ZU.trimInternal, ZU.strToISO) for consistency.

	// Attachments commonly include snapshots and PDFs.
	for (let attachment of getAttachments(doc, url)) {
		item.attachments.push(attachment);
	}

	// Optional: Collect tags, notes, or seeAlso references.

	item.complete();
}

function initAPI(doc, url) {
// Initializes the Internal API for the web page so it can get metadata in other parts of the script


}

function getType(doc, url) {
	// Until a General Purpose AI (GPAI) type is found, chat based AIs are closest to an Instant Message
	return 'instantMessage';
}


function getTitle(doc, url) {
	// Try to get the Title from API

  // Fallback to scraping DOM if API doesn't work

  // Fallback to a generic title from webpage if scraping doesn't work


  // Returns the Title
	return title ;
}

function getAuthors(doc, url) {
  /* Get AI as first Author, in form AI_NAME (Model) */

  // Set AI_NAME constant

  // Try to get Model from API

  // Try to get Model from scraping DOM if API doesn't work

  // Fallback to not showing the model if it can't be found


  /* Get the Human Author from User Info */

	// Try to get the Human Author from API

  // Try to get the Human Author from scraping DOM

  // Fallback to not listing a human name

	return [];
}

function getDate(doc, url) {
	// Returns an ISO-formatted date string when available.

  // Try to get the date from API

  // Fallback to scraping DOM if API doesn't work

  // Fallback to today's date if scraping doesn't work


	return '';
}

function getURL(doc, url) {
	// Return the public URL for the item, if possible, otherwise the private url

  // Check if a Shared URL exists

  // Try to get the shared URL via API

  // Fallback to scraping DOM for shared URL

  // If shared URL does not exist, or cannot be found use current URL

	return url;
}

function getExtra(doc, url) {
	// Populate the extra field with additional metadata
  // Each Metadata should be on its own line in the form Label: Data   
	return '';
}

function getAttachments(doc, url) {
	// Return an array of attachment objects. For example:
	return [{
		title: 'Snapshot',
		mimeType: 'text/html',
		document: doc,
    url: url
	}];
	// Example PDF attachment:
	// return [{
	// 	title: 'Full Text PDF',
	// 	url: 'https://example.com/article.pdf',
	// 	mimeType: 'application/pdf'
	// }];
}


/* Code Below will be refactored into the fuctions above */

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
  const metaName = extractHumanFromMeta(doc);
  if (metaName) {
    Zotero.debug(`[author:meta] "${metaName}"`);
    return metaName;
  }
  const titleName = extractHumanFromTitle(doc);
  if (titleName) {
    Zotero.debug(`[author:title] "${titleName}"`);
    return titleName;
  }
  return null;
}

function extractHumanFromMeta(doc) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  const selectors = [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="author"]'
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    const content = el.getAttribute('content') || el.getAttribute('value');
    const candidate = extractNameFromTitleLike(content);
    if (candidate) return candidate;
    const cleaned = cleanHumanName(content);
    if (cleaned) return cleaned;
  }
  return null;
}

function extractHumanFromTitle(doc) {
  if (!doc) return null;
  return extractNameFromTitleLike(doc.title);
}

function extractNameFromTitleLike(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separators = [' — ', ' – ', ' - ', ': '];
  for (const sep of separators) {
    if (trimmed.includes(sep)) {
      const parts = trimmed.split(sep).map(cleanHumanName);
      for (const part of parts) {
        if (part) return part;
      }
    }
  }
  return cleanHumanName(trimmed);
}

function cleanHumanName(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/chatgpt/i.test(trimmed)) return null;
  if (/openai/i.test(trimmed)) return null;
  return trimmed;
}

function extractIdFromAnyUrl(url) {
  const m = url.match(/(?:c|share(?:\/e)?)\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

function cleanTitle(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s+\|\s*(ChatGPT|OpenAI)$/i, '').trim();
}

function getDefaultShareHost(doc) {
  const host = doc && doc.location && String(doc.location.host);
  if (host && host.includes('chat.openai.com')) {
    return 'https://chat.openai.com';
  }
  return 'https://chatgpt.com';
}

function normalizeShareCandidate(candidate, doc, contextKey) {
  if (!candidate || typeof candidate !== 'string') return null;
  let cleaned = candidate;
  if (cleaned.includes('\\u002F')) {
    cleaned = cleaned.replace(/\\u002F/gi, '/');
  }
  const directMatch = cleaned.match(SHARE_URL_REGEX);
  if (directMatch) {
    const matchedHost = cleaned.match(/https?:\/\/(chatgpt\.com|chat\.openai\.com)/i);
    const host = matchedHost ? `https://${matchedHost[1].toLowerCase()}` : getDefaultShareHost(doc);
    return `${host}/share/${directMatch[1].toLowerCase()}`;
  }
  const pathMatch = cleaned.match(SHARE_PATH_REGEX);
  if (pathMatch) {
    return `${getDefaultShareHost(doc)}/share/${pathMatch[1].toLowerCase()}`;
  }
  if (contextKey && /share/i.test(contextKey)) {
    const idMatch = cleaned.match(SHARE_ID_REGEX);
    if (idMatch) {
      return `${getDefaultShareHost(doc)}/share/${idMatch[0].toLowerCase()}`;
    }
  }
  return null;
}

function findShareURLInValue(value, doc, contextKey, seen) {
  if (typeof value === 'string') {
    return normalizeShareCandidate(value, doc, contextKey);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findShareURLInValue(entry, doc, contextKey, seen);
      if (result) return result;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return null;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      const result = findShareURLInValue(entry, doc, key, seen);
      if (result) return result;
    }
  }
  return null;
}

function findShareURLInConversationData(conv, doc) {
  if (!conv || typeof conv !== 'object') return null;
  return findShareURLInValue(conv, doc, '', new Set());
}

function extractShareURLFromAny(value, doc) {
  return findShareURLInValue(value, doc, '', new Set());
}

function findShareURLInDocument(doc) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  const candidates = [
    ['meta[property="og:url"]', 'content'],
    ['meta[name="twitter:url"]', 'content'],
    ['link[rel="canonical"]', 'href'],
    ['meta[name="twitter:app:url:iphone"]', 'content'],
    ['meta[name="twitter:app:url:googleplay"]', 'content']
  ];
  for (const [selector, attr] of candidates) {
    const el = doc.querySelector(selector);
    if (!el) continue;
    const value = el.getAttribute(attr);
    const shareURL = normalizeShareCandidate(value, doc, selector);
    if (shareURL) return shareURL;
  }
  const anchor = doc.querySelector('a[href*="/share/"]');
  if (anchor) {
    const shareURL = normalizeShareCandidate(anchor.getAttribute('href'), doc, 'anchor');
    if (shareURL) return shareURL;
  }
  return null;
}

function buildSnapshotAttachment(doc, url) {
  return {
    title: 'ChatGPT Conversation Snapshot',
    url,
    document: doc,
    snapshot: true
  };
}

function extractDateFromDocument(doc) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  const time = doc.querySelector('time[datetime]');
  if (time) {
    const ms = parseMaybeTimeToMs(time.getAttribute('datetime'));
    if (ms != null) {
      return formatLocalOffset(ms);
    }
  }
  return null;
}

/* ---------- API Functions ---------- */

async function fetchConversationMeta(doc, convId, auth) {
  const shareFromDocument = findShareURLInDocument(doc);
  const baseline = {
    title: cleanTitle(doc?.title),
    isoDate: extractDateFromDocument(doc),
    shareURL: shareFromDocument,
    shareURLFromDocument: shareFromDocument
  };

  const token = auth && auth.token;
  if (!token) {
    Zotero.debug('[probe] token not provided');
    return baseline;
  }

  const r = await zoteroFetch(
    doc,
    `/backend-api/conversation/${convId}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
  );
  Zotero.debug(`[probe] conv (token) status=${r.status} ok=${r.ok}`);
  if (r.status === 401 || r.status === 403) {
    Zotero.debug('[probe] conv auth expired; skipping protected metadata');
    return baseline;
  }
  if (!r.ok || !r.data) return baseline;

  const conv = r.data;
  const title = (typeof conv.title === 'string' && conv.title.trim()) ? conv.title.trim() : null;
  const isoLocal = pickIsoDate(conv);
  const shareURL = findShareURLInConversationData(conv, doc);
  return {
    title: title || baseline.title,
    isoDate: isoLocal || baseline.isoDate,
    shareURL: shareURL || baseline.shareURL,
    shareURLFromDocument: shareFromDocument
  };
}

async function fetchPublicShareMeta(doc, shareId) {
  const r = await zoteroFetch(
    doc,
    `/backend-api/public/conversation/${shareId}`,
    { headers: { 'Accept': 'application/json' } }
  );
  Zotero.debug(`[probe] public conv status=${r.status} ok=${r.ok}`);
  if (!r.ok || !r.data) return {
    title: cleanTitle(doc?.title),
    isoDate: extractDateFromDocument(doc)
  };

  const conv = r.data;
  const title = (typeof conv.title === 'string' && conv.title.trim()) ? conv.title.trim() : null;
  const isoLocal = pickIsoDate(conv);
  return { title, isoDate: isoLocal };
}

async function probeForShareURL(doc, convId, token) {
  if (!token) return null;

  const probe = await zoteroFetch(
    doc,
    `/backend-api/conversation/${convId}/share`,
    {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      timeout: SHARE_PROBE_TIMEOUT_MS
    }
  );
  Zotero.debug(`[share] probe status=${probe.status} ok=${probe.ok}`);
  if (!probe.ok) {
    if (probe.status === 404) {
      Zotero.debug('[share] probe indicates no share is currently published');
      return NO_SHARE_CONFIRMED;
    }
    return null;
  }
  if (!probe.data) return null;
  const shareURL = extractShareURLFromAny(probe.data, doc);
  if (shareURL) return shareURL;
  if (typeof probe.data === 'object' && probe.data.share_id) {
    return `${getDefaultShareHost(doc)}/share/${String(probe.data.share_id).toLowerCase()}`;
  }
  return null;
}

async function getActiveShareURLForConversation(doc, convId, token) {
  if (!token) { Zotero.debug('[share] no token provided, skipping'); return null; }

  const list = await zoteroFetch(
    doc,
    `/backend-api/shared_conversations?order=created`,
    {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      timeout: SHARE_LIST_TIMEOUT_MS
    }
  );
  Zotero.debug(`[share] list status=${list.status} ok=${list.ok}`);
  if (!list.ok && list.status === 0) {
    Zotero.debug(`[share] shared list lookup timed out after ${SHARE_LIST_TIMEOUT_MS}ms`);
    return null;
  }
  if (list.status === 401 || list.status === 403) {
    Zotero.debug('[share] token expired; skipping share lookup');
    return null;
  }
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

function getHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (typeof key === 'string' && key.toLowerCase() === target) {
      return headers[key];
    }
  }
  return null;
}

function isJSONContentType(value) {
  if (!value || typeof value !== 'string') return false;
  return /\bapplication\/([a-z0-9.+-]*json)\b/i.test(value);
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
  if (opts.timeout == null) {
    opts.timeout = ZOTERO_FETCH_DEFAULT_TIMEOUT_MS;
    Zotero.debug(`${label} using default timeout ${ZOTERO_FETCH_DEFAULT_TIMEOUT_MS}ms`);
  }

  const wantsJSON = (() => {
    if (opts.responseType === 'json') return true;
    const accept = headers.Accept || headers.accept;
    if (accept && typeof accept === 'string' && accept.toLowerCase().includes('application/json')) {
      return true;
    }
    return false;
  })();

  const buildResult = (status, raw, jsonCandidate, expectJSON) => {
    const ok = status >= 200 && status < 300;
    if (expectJSON) {
      const parsed = jsonCandidate !== undefined ? jsonCandidate : safeParseJSON(raw);
      return { ok, status, data: parsed };
    }
    return { ok, status, data: raw };
  };

  const expectJSONFromContentType = (contentType) => wantsJSON || isJSONContentType(contentType);

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
      let contentType = null;
      if (resp) {
        if (typeof resp.getResponseHeader === 'function') {
          contentType = resp.getResponseHeader('Content-Type') || contentType;
        }
        contentType = contentType || getHeaderValue(resp.headers, 'content-type');
      }
      const expectJSON = expectJSONFromContentType(contentType);
      const jsonCandidate = expectJSON && resp && (resp.responseJSON !== undefined ? resp.responseJSON : safeParseJSON(raw));
      let result = buildResult(status, raw, jsonCandidate, expectJSON);
      if (expectJSON && (!result.data || typeof result.data !== 'object')) {
        const fallback = await fetchViaDefaultView(doc, url, method, headers, body, wantsJSON, `${label} (default-view fallback)`);
        if (fallback && fallback.ok) {
          const fallbackExpectJSON = expectJSONFromContentType(fallback.contentType);
          const fallbackResult = buildResult(fallback.status, fallback.raw, fallback.parsed, fallbackExpectJSON);
          if (!fallbackExpectJSON || (fallbackResult.data && typeof fallbackResult.data === 'object')) {
            return fallbackResult;
          }
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
      const contentType = xhr && typeof xhr.getResponseHeader === 'function'
        ? xhr.getResponseHeader('Content-Type') : null;
      const expectJSON = expectJSONFromContentType(contentType);
      let result = buildResult(status, raw, undefined, expectJSON);
      if (expectJSON && (!result.data || typeof result.data !== 'object')) {
        const fallback = await fetchViaDefaultView(doc, url, method, headers, body, wantsJSON, `${label} (default-view fallback)`);
        if (fallback && fallback.ok) {
          const fallbackExpectJSON = expectJSONFromContentType(fallback.contentType);
          const fallbackResult = buildResult(fallback.status, fallback.raw, fallback.parsed, fallbackExpectJSON);
          if (!fallbackExpectJSON || (fallbackResult.data && typeof fallbackResult.data === 'object')) {
            return fallbackResult;
          }
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
    const contentType = typeof response.getResponseHeader === 'function'
      ? response.getResponseHeader('Content-Type') : null;
    const expectJSON = expectJSONFromContentType(contentType);
    let result = buildResult(status, response.responseText, undefined, expectJSON);
    if (expectJSON && (!result.data || typeof result.data !== 'object')) {
      const fallback = await fetchViaDefaultView(doc, url, method, headers, body, wantsJSON, `${label} (default-view fallback)`);
      if (fallback && fallback.ok) {
        const fallbackExpectJSON = expectJSONFromContentType(fallback.contentType);
        const fallbackResult = buildResult(fallback.status, fallback.raw, fallback.parsed, fallbackExpectJSON);
        if (!fallbackExpectJSON || (fallbackResult.data && typeof fallbackResult.data === 'object')) {
          return fallbackResult;
        }
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
    const contentType = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-type') : null;
    const expectJSON = wantsJSON || isJSONContentType(contentType);
    const parsed = expectJSON ? safeParseJSON(raw) : null;
    return { ok: !!response.ok, status, raw, parsed, contentType };
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
