{
	"translatorID": "9f90035c-d941-45d3-8f64-599bb7323ad8",
	"label": "ChatGPT",
	"creator": "Jacob J. Walker",
	"target": "^https?://(?:chatgpt\\.com|chat\\.openai\\.com)/(?:c/|share/|g/[^/]+/(?:c/|project(?=($|[/?#]))))",
	"minVersion": "5.0",
	"maxVersion": "",
	"priority": 100,
	"inRepository": true,
	"translatorType": 4,
	"browserSupport": "gcsibv",
	"lastUpdated": "2025-10-09 19:02:11"
}

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

 /* ChatGPT translator
 *
 * Changelog
 * - v0.8.0-beta: Added multi-save of project conversations, and fixed an API problem.
 * - v0.7.0-beta: Refactored to a standardized code pattern for AI Chat tranators
 * - v0.6.0-beta: This beta number was skipped to stay consistant with Gemini version numbering
 * - v0.5.0-beta: Ensured resilient share detection (metadata/DOM probes + quick backend checks), 
 *   smarter private URL handling, and consistent snapshots across public and private pages.
 * - v0.4.0: Stabilized the translator by preferring connector helpers (ZU.request →
 *   Zotero.HTTP → page fetch), keeping API calls same-origin, parsing helper text
 *   responses as JSON, and discovering share links deterministically with local-offset
 *   metadata.
 */

  //////////////////////
 // Global Constants //
//////////////////////

const VERSION = 'v0.8.0-beta';

const TRANSLATOR_DEFAULTS = {
  title: 'ChatGPT Conversation',
  aiName: 'ChatGPT',
  aiModel: null,
  humanAuthor: 'User',
  date: ''
};


const ZOTERO_FETCH_DEFAULT_TIMEOUT_MS = 7000;
const SHARE_LIST_TIMEOUT_MS = 3500;
const SHARE_PROBE_TIMEOUT_MS = 2000;
const SHARE_URL_REGEX = /https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/share\/([0-9a-f-]{36})/i;
const SHARE_PATH_REGEX = /^\/?share\/([0-9a-f-]{36})/i;
const SHARE_ID_REGEX = /[0-9a-f-]{36}/i;
const CONVERSATION_PAGE_REGEX = /https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:c\/|share\/|g\/[^/]+\/c\/)/i;
const PROJECT_PAGE_REGEX = /https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\/g\/[^/]+\/project(?=($|[/?#]))/i;
const PROJECT_CONVERSATION_PATH_REGEX = /^\/?g\/([^/]+)\/c\/([0-9a-f-]{36})(?=($|[/?#]))/i;

const ENABLE_EMULATED_SNAPSHOT_IN_MULTISAVE = false;

const CHATGPT_API_AUTH_CACHE = new WeakMap();
const CHATGPT_API_METADATA_CACHE = new WeakMap();
const CHATGPT_SHARE_LIST_CACHE = new WeakMap();
const LOG_LEVEL_ERROR = 1;
const LOG_LEVEL_DEBUG = 4;
const ENABLE_VERBOSE_API_LOGGING = true;

/**
 * @description Safely retrieves a cookie value from a serialized cookie string.
 * @param {string|null} cookieString - Serialized cookie header string.
 * @param {string} name - Cookie name to retrieve.
 * @returns {string|null} Decoded cookie value or null when unavailable.
 */
function getCookieValue(cookieString, name) {
  if (!cookieString || typeof cookieString !== 'string' || !name) {
    return null;
  }
  const escaped = name.replace(/([.*+?^${}()|[\]\\])/g, '\\$1');
  const pattern = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`);
  const match = cookieString.match(pattern);
  if (!match || match.length < 2) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  }
  catch (_) {
    return match[1];
  }
}

/**
 * @description Ensures outbound ChatGPT API requests include workspace headers when available.
 * @param {Document} doc - The current page document.
 * @param {string} targetURL - Absolute request URL.
 * @param {Object} headers - Mutable headers object for the request.
 * @param {string|null} cookieSnapshot - Serialized cookies captured from the document.
 * @returns {void}
 */
function applyChatGPTRequestHeaders(doc, targetURL, headers, cookieSnapshot) {
  if (!headers || typeof headers !== 'object') {
    return;
  }
  if (!targetURL || typeof targetURL !== 'string') {
    return;
  }
  if (!/https?:\/\/(?:chatgpt\.com|chat\.openai\.com)\b/i.test(targetURL)) {
    return;
  }

  const ensureHeader = (name, value) => {
    if (!name || value == null) {
      return;
    }
    const lowerName = String(name).toLowerCase();
    for (const existingName of Object.keys(headers)) {
      if (existingName && typeof existingName === 'string' && existingName.toLowerCase() === lowerName) {
        return;
      }
    }
    headers[name] = value;
  };

  const accountId = getCookieValue(cookieSnapshot, '_account');
  const deviceId = getCookieValue(cookieSnapshot, 'oai-did');

  let language = null;
  const win = doc && doc.defaultView ? doc.defaultView : null;
  if (win && win.navigator && typeof win.navigator.language === 'string' && win.navigator.language) {
    language = win.navigator.language;
  }
  else if (doc && doc.documentElement && typeof doc.documentElement.lang === 'string' && doc.documentElement.lang) {
    language = doc.documentElement.lang;
  }
  else if (typeof Zotero !== 'undefined' && Zotero.locale) {
    language = Zotero.locale;
  }

  ensureHeader('chatgpt-account-id', accountId);
  ensureHeader('oai-device-id', deviceId);
  if (language) {
    ensureHeader('oai-language', language);
  }
}


  ///////////////////////////////
 // Standard Zotero Functions //
///////////////////////////////

/**
 * @description Identifies the Zotero item type represented by the current page.
 * @param {Document} doc - The page DOM.
 * @param {string} url - The URL of the current page.
 * @returns {false | 'multiple' | string} Zotero item type, 'multiple', or false when unsupported.
 */
function detectWeb(doc, url) {
  const start = Date.now();
  let result = false;
  let pageURL = null;
  let isProjectPage = false;
  try {
    pageURL = typeof url === 'string'
      ? url
      : (doc && doc.location && typeof doc.location.href === 'string' ? doc.location.href : null);

    if (typeof pageURL === 'string' && PROJECT_PAGE_REGEX.test(pageURL)) {
      isProjectPage = true;
      result = 'multiple';
    }

    if (!result && typeof pageURL === 'string'
      && CONVERSATION_PAGE_REGEX.test(pageURL)) {
      result = 'instantMessage';
    }
    return result;
  }
  finally {
    const elapsed = Date.now() - start;
    const mode = typeof pageURL === 'string'
      ? (isProjectPage ? 'project'
        : (/\bshare\b/i.test(pageURL) ? 'share' : 'conversation'))
      : '∅';
    Zotero.debug(`[flow:new][detectWeb] done type=${result || '∅'} matched=${result ? 'true' : 'false'} mode=${mode} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  }
}


/**
 * @description Orchestrates saving based on the result of detectWeb, handling single and multiple items.
 * @param {Document} doc - The page DOM.
 * @param {string} url - The URL of the current page.
 * @returns {void}
 */
async function doWeb(doc, url) {
  const start = Date.now();
  const detected = detectWeb(doc, url);
  const idsForLog = getIDs(doc, url || (doc && doc.location && doc.location.href));
  const cidForLog = idsForLog && idsForLog.conversationID ? idsForLog.conversationID : '∅';
  Zotero.debug(`doWeb start version=${VERSION || '∅'} mode=${detected || 'single'} cid=${cidForLog}`, LOG_LEVEL_DEBUG);
  let processed = 0;
  try {
    if (detected === 'multiple') {
      const searchResults = getSearchResults(doc, false);
      const choicesMap = searchResults && searchResults.items ? searchResults.items : null;
      if (!choicesMap || !Object.keys(choicesMap).length) {
        Zotero.debug('[flow:new][doWeb] no project choices available after scan', LOG_LEVEL_DEBUG);
        return;
      }
      const choices = await new Promise(resolve => {
        Zotero.selectItems(choicesMap, resolve);
      });
      if (!choices) {
        return;
      }

      const details = searchResults && searchResults.details ? searchResults.details : {};
      const projectDashboardURL = searchResults && searchResults.projectURL ? searchResults.projectURL : null;

      for (const selectionKey of Object.keys(choices)) {
        const metadata = details && details[selectionKey] ? details[selectionKey] : null;
        if (!metadata || !metadata.conversationID) {
          Zotero.debug(`[flow:new][doWeb] skip project item key="${String(selectionKey || '∅').replace(/"/g, '\\"')}" reason=${metadata ? 'missing-id' : 'missing-metadata'}`, LOG_LEVEL_DEBUG);
          continue;
        }

        const idOverrides = { conversationID: metadata.conversationID };
        if (metadata.projectSlug) {
          idOverrides.projectSlug = metadata.projectSlug;
        }

        const context = { ids: idOverrides };
        if (projectDashboardURL) {
          let normalizedProject = projectDashboardURL;
          try {
            const parsedProject = new URL(projectDashboardURL);
            parsedProject.hash = '';
            normalizedProject = parsedProject.href;
          }
          catch (_) {}
          context.urls = { project: normalizedProject };
        }

        try {
          const targetURL = metadata.absoluteURL || selectionKey;
          if (!targetURL) {
            Zotero.debug(`[flow:new][doWeb] skip project item key="${String(selectionKey || '∅').replace(/"/g, '\\"')}" reason=missing-url`, LOG_LEVEL_DEBUG);
            continue;
          }
          await getItem(doc, targetURL, context);
          processed++;
        }
        catch (err) {
          Zotero.debug(`[chatgpt:error][doWeb] project item failed cid=${metadata.conversationID || '∅'} msg="${err && err.message ? err.message : err}"`, LOG_LEVEL_ERROR);
        }
      }
    }
    else {
      const resolvedURL = url
        || (doc && doc.location && typeof doc.location.href === 'string'
          ? doc.location.href
          : null);
      await getItem(doc, resolvedURL);
      processed = 1;
    }
  }
  finally {
    const elapsed = Date.now() - start;
    const mode = detected === 'multiple' ? 'multiple' : 'single';
    Zotero.debug(`[flow:new][doWeb] done mode=${mode} cid=${cidForLog} processed=${processed} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  }
}


  ////////////////////////
 // Main Get Functions //
////////////////////////

/**
 * @description Collects candidate items on project dashboards so the user can pick which to save.
 * @param {Document} doc - The page DOM.
 * @param {boolean} checkOnly - When true, stop after confirming at least one result exists.
 * @returns {boolean | { items: Object<string, string>, details: Object<string, Object>, projectURL: string|null }}
 */
function getSearchResults(doc, checkOnly) {
  if (!doc || typeof doc.querySelectorAll !== 'function') {
    return false;
  }

  const rows = doc.querySelectorAll('a[href]');
  if (!rows || !rows.length) {
    return false;
  }

  const projectURL = (() => {
    if (!doc || !doc.location || typeof doc.location.href !== 'string') {
      return null;
    }
    if (!PROJECT_PAGE_REGEX.test(doc.location.href)) {
      return null;
    }
    try {
      const parsed = new URL(doc.location.href);
      parsed.hash = '';
      return parsed.href;
    }
    catch (_) {
      return doc.location.href.replace(/#.*$/, '');
    }
  })();

  const conversations = getProjectConversations(doc);
  if (!conversations.length) {
    return false;
  }

  if (checkOnly) {
    return true;
  }

  const items = {};
  const details = {};
  for (const conversation of conversations) {
    if (!conversation.absoluteURL || !conversation.conversationID) {
      continue;
    }
    if (details[conversation.absoluteURL]) {
      continue;
    }
    const label = conversation.label
      || (conversation.conversationID ? `Conversation ${conversation.conversationID.slice(0, 8)}` : 'Conversation');
    items[conversation.absoluteURL] = label;
    details[conversation.absoluteURL] = conversation;
  }

  if (!Object.keys(items).length) {
    return false;
  }

  return { items, details, projectURL };
}


function getProjectConversations(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') {
    return [];
  }

  const rows = doc.querySelectorAll('a[href]');
  if (!rows || !rows.length) {
    return [];
  }

  const baseHref = doc.location && doc.location.href ? doc.location.href : undefined;
  const trim = (value) => {
    if (typeof ZU !== 'undefined' && typeof ZU.trimInternal === 'function') {
      return ZU.trimInternal(value);
    }
    return typeof value === 'string' ? value.trim() : '';
  };
  const deriveConversationDetails = (value) => {
    if (!value) {
      return null;
    }
    let absoluteURL = null;
    try {
      const resolved = new URL(value, baseHref || undefined);
      resolved.hash = '';
      absoluteURL = resolved.href;
    }
    catch (_) {
      absoluteURL = typeof value === 'string' ? value : null;
    }
    if (!absoluteURL) {
      return null;
    }
    let pathname = null;
    try {
      pathname = new URL(absoluteURL).pathname;
    }
    catch (_) {
      pathname = absoluteURL;
    }
    const match = pathname && pathname.match(PROJECT_CONVERSATION_PATH_REGEX);
    if (!match || !match[2]) {
      return null;
    }
    const conversationID = normalizeConversationID(match[2]);
    if (!conversationID) {
      return null;
    }
    let slug = match[1] || null;
    if (!slug && pathname) {
      const slugMatch = pathname.match(/\/g\/([^/]+)/i);
      slug = slugMatch && slugMatch[1] ? slugMatch[1] : null;
    }
    if (slug) {
      try {
        slug = decodeURIComponent(slug.trim());
      }
      catch (_) {
        slug = slug.trim();
      }
      if (slug.includes('/')) {
        slug = slug.split('/')[0];
      }
    }
    return {
      absoluteURL,
      conversationID,
      projectSlug: slug || null
    };
  };

  const conversations = [];
  const seen = new Set();

  for (const row of rows) {
    const rawHref = row.getAttribute('href') || row.href;
    if (!rawHref) {
      continue;
    }

    const parsed = deriveConversationDetails(rawHref)
      || (row.href && row.href !== rawHref ? deriveConversationDetails(row.href) : null);
    if (!parsed || !parsed.conversationID || !parsed.absoluteURL) {
      continue;
    }

    const ids = { conversationID: parsed.conversationID };
    if (parsed.projectSlug) {
      ids.projectSlug = parsed.projectSlug;
    }

    let resolvedURL = parsed.absoluteURL;
    try {
      const urlContext = getURLs(doc, parsed.absoluteURL, ids);
      if (urlContext) {
        resolvedURL = urlContext.item
          || urlContext.private
          || urlContext.public
          || urlContext.snapshot
          || resolvedURL;
      }
    }
    catch (err) {
      Zotero.debug(`[project][getProjectConversations] getURLs error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
    }

    if (!resolvedURL || seen.has(resolvedURL)) {
      continue;
    }
    seen.add(resolvedURL);

    const text = row.textContent || '';
    const label = trim(text) || (parsed.conversationID ? `Conversation ${parsed.conversationID.slice(0, 8)}` : 'Conversation');

    conversations.push({
      absoluteURL: resolvedURL,
      conversationID: parsed.conversationID,
      projectSlug: ids.projectSlug || parsed.projectSlug || null,
      label
    });
  }

  return conversations;
}


/**
 * @description Extracts data for a single item page and completes the Zotero item.
 * @param {Document} doc - The page DOM.
 * @param {string} url - The URL of the current page.
 * @returns {Promise<void>}
*/
async function getItem(doc, url, context = {}) {
  const start = Date.now();
  const itemType = getType(doc, url);
  // Create the new Zotero item with the appropriate type (e.g., "journalArticle").
  let item = new Zotero.Item(itemType);

  // Get URL & API information
  const pageURL = url;
  const overrideIDs = context && context.ids ? context.ids : null;
  const overrideURLs = context && context.urls ? context.urls : null;
  const baseIDs = getIDs(doc, pageURL) || {};
  const ids = Object.assign({}, baseIDs);
  if (overrideIDs && typeof overrideIDs === 'object') {
    for (const [key, value] of Object.entries(overrideIDs)) {
      if (value != null) {
        ids[key] = value;
      }
    }
  }

  const urls = getURLs(doc, pageURL, ids);
  if (overrideURLs && typeof overrideURLs === 'object') {
    for (const [key, value] of Object.entries(overrideURLs)) {
      if (value != null) {
        urls[key] = value;
      }
    }
  }

  // Populate core metadata by delegating to helper accessors.
  item.title = await getTitle(doc, urls, ids);

  // Add creators returned from getAuthors, which should yield an array of
  // creator objects (e.g., via ZU.cleanAuthor).
  for (let creator of await getAuthors(doc, urls, ids)) {
    item.creators.push(creator);
  }

  item.date = await getDate(doc, urls, ids);

  item.url = urls.item;

  let extra = getExtra(doc, urls, ids);
  if (extra) {
    item.extra = extra;
  }

  // TODO: Populate additional fields such as abstractNote, language,
  // publicationTitle, etc. Use ZU utilities (e.g., ZU.xpathText,
  // ZU.trimInternal, ZU.strToISO) for consistency.

  // Attachments commonly include snapshots and PDFs.
  const attachments = await getAttachments(doc, urls, ids);
  if (Array.isArray(attachments)) {
    for (let attachment of attachments) {
      item.attachments.push(attachment);
    }
  }
  const snapshotPresent = Array.isArray(attachments) && attachments.some(att => att && att.snapshot);

  Zotero.debug(`doWeb item title="${(item.title || '∅').replace(/"/g, '\\"')}" date=${item.date || '∅'} url=${item.url || '∅'} snapshot=${snapshotPresent ? 'true' : 'false'}`, LOG_LEVEL_DEBUG);

  // Optional: Collect tags, notes, or seeAlso references.

  item.complete();
  const elapsed = Date.now() - start;
  const creatorsCount = Array.isArray(item.creators) ? item.creators.length : 0;
  const attachmentCount = Array.isArray(item.attachments) ? item.attachments.length : 0;
  Zotero.debug(`[flow:new][getItem] done type=${itemType} title="${(item.title || '∅').replace(/"/g, '\\"')}" creators=${creatorsCount} attachments=${attachmentCount} ms=${elapsed}`, LOG_LEVEL_DEBUG);
}


/**
 * @description Determines the Zotero item type for the current page.
 * @param {Document} doc - The page DOM.
 * @param {string} url - The URL of the current page.
 * @returns {string} A Zotero item type such as 'journalArticle'.
 */
function getType(doc, url) {
  // TODO: Inspect the document or URL to determine the correct Zotero item type.
  const start = Date.now();
  const result = 'instantMessage';
  const elapsed = Date.now() - start;
  Zotero.debug(`[flow:new][getType] done type=${result} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}


/**
 * @description Extracts the item title from the page.
 * @param {Document} doc - The page DOM.
 * @param {{ page?: string|null }} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {Promise<string>} The item title.
*/
async function getTitle(doc, urls, ids) {
  const start = Date.now();
  let resolvedTitle = null;
  let source = 'default';
  let genericReplaced = false;
  let metadata = null;
  try {
    metadata = await getAPIMetadata(doc, urls, ids);
  }
  catch (err) {
    Zotero.debug(`[getTitle] getAPIMetadata error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
  }

  const metadataTitleRaw = metadata ? metadata.title : null;
  const metadataTitle = normalizeTitle(metadataTitleRaw);
  if (metadataTitle) {
    Zotero.debug(`[flow:new] getTitle returning API metadata title "${metadataTitle}"`, LOG_LEVEL_DEBUG);
    resolvedTitle = metadataTitle;
    source = 'api';
  }
  else if (metadataTitleRaw != null && `${metadataTitleRaw}`.trim()) {
    genericReplaced = true;
    Zotero.debug('[getTitle] API metadata title sanitized as generic; continuing lookup', LOG_LEVEL_DEBUG);
  }

  if (!resolvedTitle) {
    let domTitleRaw = null;
    let domTitle = null;
    if (typeof getDOMTitle === 'function') {
      try {
        domTitleRaw = await getDOMTitle(doc, urls, ids);
        domTitle = normalizeTitle(domTitleRaw);
      }
      catch (err) {
        Zotero.debug(`[getTitle] getDOMTitle error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
      }
    }
    else {
      Zotero.debug('[getTitle] DOM title helper not available; skipping DOM lookup', LOG_LEVEL_DEBUG);
    }

    if (domTitle) {
      Zotero.debug(`[flow:new] getTitle using DOM title "${domTitle}"`, LOG_LEVEL_DEBUG);
      resolvedTitle = domTitle;
      source = 'dom';
    }
    else if (domTitleRaw != null && `${domTitleRaw}`.trim()) {
      genericReplaced = true;
      Zotero.debug('[getTitle] DOM title sanitized as generic; falling back further', LOG_LEVEL_DEBUG);
    }
  }

  if (!resolvedTitle) {
    Zotero.debug('[getTitle] Falling back to default translator title', LOG_LEVEL_DEBUG);
    resolvedTitle = TRANSLATOR_DEFAULTS.title;
    source = 'default';
    genericReplaced = true;
    Zotero.debug(`[flow:new] getTitle falling back to default "${TRANSLATOR_DEFAULTS.title}"`, LOG_LEVEL_DEBUG);
  }

  const elapsed = Date.now() - start;
  Zotero.debug(`[flow:new][getTitle] done source=${source} value="${(resolvedTitle || '∅').replace(/"/g, '\\"')}" generic_replaced=${genericReplaced ? 'true' : 'false'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolvedTitle;
}


/**
 * @description Obtains creators for the item in Zotero's expected format.
 * @param {Document} doc - The page DOM.
 * @param {{}} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {Promise<Array<Object>>} Array of creator objects (e.g., from ZU.cleanAuthor).
 */
async function getAuthors(doc, urls, ids) {
  const start = Date.now();
  const authors = [];
  const aiCreator = (typeof getAIName === 'function')
    ? await getAIName(doc, urls, ids)
    : null;
  if (aiCreator) {
    authors.push(aiCreator);
  }

  const humanCreator = (typeof getHumanAuthor === 'function')
    ? await getHumanAuthor(doc, urls, ids)
    : null;
  if (humanCreator) {
    authors.push(humanCreator);
  }

  try {
    Zotero.debug(`[flow:new] getAuthors returning ${JSON.stringify(authors)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  const readName = (creator) => {
    if (!creator) return '∅';
    if (creator.lastName) return creator.lastName;
    if (creator.fullName) return creator.fullName;
    if (creator.name) return creator.name;
    return '∅';
  };
  const elapsed = Date.now() - start;
  Zotero.debug(`[flow:new][getAuthors] done ai="${readName(aiCreator).replace(/"/g, '\\"')}" human="${readName(humanCreator).replace(/"/g, '\\"')}" count=${authors.length} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return authors;
}


/**
 * @description Resolves the AI participant as a Zotero creator object.
 * @param {Document} doc - The page DOM.
 * @param {{}} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {Promise<Object|null>} Creator object or null when unavailable.
 */
async function getAIName(doc, urls, ids) {
  const start = Date.now();
  let resolved = null;
  let source = 'default';
  let metadata = null;
  try {
    metadata = await getAPIMetadata(doc, urls, ids);
  }
  catch (err) {
    Zotero.debug(`[getAIName] getAPIMetadata error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
  }

  const metadataAIName = metadata && metadata.aiName;
  const creatorFromAPI = normalizeSingleFieldCreator(metadataAIName, TRANSLATOR_DEFAULTS.aiName);
  if (creatorFromAPI) {
    try { Zotero.debug(`[flow:new] getAIName resolved from API ${JSON.stringify(creatorFromAPI)}`, LOG_LEVEL_DEBUG); } catch (_) {}
    resolved = creatorFromAPI;
    source = 'api';
  }

  if (!resolved && typeof getDOMAIName === 'function') {
    try {
      const domName = await getDOMAIName(doc, urls, ids);
      const creator = normalizeSingleFieldCreator(domName, TRANSLATOR_DEFAULTS.aiName);
      if (creator) {
        try { Zotero.debug(`[flow:new] getAIName resolved from DOM ${JSON.stringify(creator)}`, LOG_LEVEL_DEBUG); } catch (_) {}
        resolved = creator;
        source = 'dom';
      }
    }
    catch (err) {
      Zotero.debug(`[getAIName] getDOMAIName error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
    }
  }
  else {
    Zotero.debug('[getAIName] DOM AI name helper not available; skipping DOM lookup', LOG_LEVEL_DEBUG);
  }

  Zotero.debug('[getAIName] Falling back to default AI name', LOG_LEVEL_DEBUG);
  const fallback = normalizeSingleFieldCreator(TRANSLATOR_DEFAULTS.aiName, TRANSLATOR_DEFAULTS.aiName);
  try { Zotero.debug(`[flow:new] getAIName fallback ${JSON.stringify(fallback)}`, LOG_LEVEL_DEBUG); } catch (_) {}
  const finalCreator = resolved || fallback;
  if (!resolved) {
    source = 'fallback';
  }
  const elapsed = Date.now() - start;
  const nameForLog = finalCreator && finalCreator.lastName ? finalCreator.lastName : '∅';
  Zotero.debug(`[flow:new][getAIName] done source=${source} value="${String(nameForLog).replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return finalCreator;
}


async function getHumanAuthor(doc, urls, ids) {
  const start = Date.now();
  let source = 'default';
  let resolved = null;
  let metadata = null;
  try {
    metadata = await getAPIMetadata(doc, urls, ids);
  }
  catch (err) {
    Zotero.debug(`[getHumanAuthor] getAPIMetadata error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
  }

  const metadataHumanAuthor = metadata && metadata.humanAuthor;
  if (metadataHumanAuthor) {
    const creatorFromAPI = normalizeSingleFieldCreator(metadataHumanAuthor, TRANSLATOR_DEFAULTS.humanAuthor);
    if (creatorFromAPI) {
      try { Zotero.debug(`[flow:new] getHumanAuthor resolved from API ${JSON.stringify(creatorFromAPI)}`, LOG_LEVEL_DEBUG); } catch (_) {}
      resolved = creatorFromAPI;
      source = 'api';
    }
  }

  if (!resolved) {
    if (typeof getDOMHumanAuthor === 'function') {
      try {
        const domAuthor = await getDOMHumanAuthor(doc, urls, ids);
        if (domAuthor) {
          const creator = normalizeHumanAuthor(domAuthor);
          if (creator) {
            try { Zotero.debug(`[flow:new] getHumanAuthor resolved from DOM ${JSON.stringify(creator)}`, LOG_LEVEL_DEBUG); } catch (_) {}
            resolved = creator;
            source = 'dom';
          }
          else {
            const filteredLabel = typeof domAuthor === 'string' ? domAuthor : '∅';
            Zotero.debug(`[getHumanAuthor] DOM candidate filtered value="${String(filteredLabel).replace(/"/g, '\\"')}"`, LOG_LEVEL_DEBUG);
          }
        }
      }
      catch (err) {
        Zotero.debug(`[getHumanAuthor] getDOMHumanAuthor error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
      }
    }
    else {
      Zotero.debug('[getHumanAuthor] DOM human author helper not available; skipping DOM lookup', LOG_LEVEL_DEBUG);
    }
  }

  if (!resolved) {
    const fallback = normalizeSingleFieldCreator(TRANSLATOR_DEFAULTS.humanAuthor, TRANSLATOR_DEFAULTS.humanAuthor);
    Zotero.debug('[getHumanAuthor] Falling back to default human author', LOG_LEVEL_DEBUG);
    try { Zotero.debug(`[flow:new] getHumanAuthor fallback ${JSON.stringify(fallback)}`, LOG_LEVEL_DEBUG); } catch (_) {}
    resolved = fallback;
    source = 'fallback';
  }
  const finalCreator = resolved;
  const elapsed = Date.now() - start;
  const nameForLog = finalCreator && finalCreator.lastName ? finalCreator.lastName : '∅';
  Zotero.debug(`[flow:new][getHumanAuthor] done source=${source} value="${String(nameForLog).replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return finalCreator;
}


/**
 * @description Retrieves the AI model label associated with the conversation.
 * @param {Document} doc - The page DOM.
 * @param {{}} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {Promise<string|null>} AI model name or null when unavailable.
 */
async function getAIModel(doc, urls, ids) {
  const start = Date.now();
  let source = 'default';
  let resolved = null;
  if (typeof getDOMAIModel === 'function') {
    try {
      const domModel = normalizeAIModel(await getDOMAIModel(doc, urls, ids));
      if (domModel) {
        Zotero.debug(`[flow:new] getAIModel resolved from DOM "${domModel}"`, LOG_LEVEL_DEBUG);
        resolved = domModel;
        source = 'dom';
      }
    }
    catch (err) {
      Zotero.debug(`[getAIModel] getDOMAIModel error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
    }
  }
  else {
    Zotero.debug('[getAIModel] DOM AI model helper not available; skipping DOM lookup', LOG_LEVEL_DEBUG);
  }

  let metadata = null;
  try {
    metadata = await getAPIMetadata(doc, urls, ids);
  }
  catch (err) {
    Zotero.debug(`[getAIModel] getAPIMetadata error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
  }

  if (!resolved) {
    const metadataAIModel = metadata && normalizeAIModel(metadata.aiModel);
    if (metadataAIModel) {
      Zotero.debug(`[flow:new] getAIModel resolved from API "${metadataAIModel}"`, LOG_LEVEL_DEBUG);
      resolved = metadataAIModel;
      source = 'api';
    }
  }

  if (!resolved) {
    Zotero.debug('[getAIModel] Falling back to default AI model', LOG_LEVEL_DEBUG);
    const fallback = normalizeAIModel(TRANSLATOR_DEFAULTS.aiModel);
    Zotero.debug(`[flow:new] getAIModel fallback "${fallback}"`, LOG_LEVEL_DEBUG);
    resolved = fallback;
    source = 'fallback';
  }

  const elapsed = Date.now() - start;
  Zotero.debug(`[flow:new][getAIModel] done source=${source} value="${(resolved || '∅').replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}


/**
 * @description Extracts a publication date in ISO string format when available.
 * @param {Document} doc - The page DOM.
 * @param {{}} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {Promise<string>} An ISO-formatted date or an empty string when unavailable.
*/
async function getDate(doc, urls, ids) {
  const start = Date.now();
  let resolved = '';
  let source = 'fallback';
  let hasTime = false;
  let metadata = null;
  try {
    metadata = await getAPIMetadata(doc, urls, ids);
  }
  catch (err) {
    Zotero.debug(`[getDate] getAPIMetadata error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
  }

  const metadataDate = metadata && normalizeDate(metadata.isoDate || metadata.date);
  if (metadata && metadata.isoDate && metadata.isoDate.includes('T')) {
    Zotero.debug(`[flow:new] getDate resolved from API "${metadata.isoDate}"`, LOG_LEVEL_DEBUG);
    resolved = metadata.isoDate;
    source = 'api';
    hasTime = true;
  }
  else if (metadataDate) {
    Zotero.debug(`[flow:new] getDate resolved from API "${metadataDate}"`, LOG_LEVEL_DEBUG);
    resolved = metadataDate;
    source = 'api';
    hasTime = metadataDate.includes('T');
  }

  if (!resolved && typeof getDOMDate === 'function') {
    try {
      const domDate = normalizeDate(await getDOMDate(doc, urls, ids));
      if (domDate) {
        Zotero.debug(`[flow:new] getDate resolved from DOM "${domDate}"`, LOG_LEVEL_DEBUG);
        resolved = domDate;
        source = 'dom';
        hasTime = domDate.includes('T');
      }
    }
    catch (err) {
      Zotero.debug(`[getDate] getDOMDate error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
    }
  }
  else {
    Zotero.debug('[getDate] DOM date helper not available; skipping DOM lookup', LOG_LEVEL_DEBUG);
  }

  if (!resolved) {
    const nowISO = new Date().toISOString();
    const fallback = normalizeDate(nowISO) || nowISO;
    Zotero.debug(`[flow:new] getDate fallback "${fallback}"`, LOG_LEVEL_DEBUG);
    resolved = fallback;
    source = 'fallback';
    hasTime = true;
  }

  const elapsed = Date.now() - start;
  Zotero.debug(`[flow:new][getDate] done source=${source} iso="${(resolved || '').replace(/"/g, '\\"')}" has_time=${hasTime ? 'true' : 'false'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}


/**
 * @description Populates supplemental metadata stored in the extra field.
 * @param {Document} doc - The page DOM.
 * @param {{}} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {string} Extra field contents.
 */
function getExtra(doc, urls, ids) {
  const start = Date.now();
  let result = '';
  if (!urls) {
    Zotero.debug('[flow:new] getExtra no urls context', LOG_LEVEL_DEBUG);
  }
  else {
    const privateURL = urls.private;
    const publicURL = urls.public;
    if (privateURL && publicURL && privateURL !== publicURL) {
      Zotero.debug(`[flow:new] getExtra reporting private URL ${privateURL}`, LOG_LEVEL_DEBUG);
      result = `Private URL: ${privateURL}`;
    }
    else {
      Zotero.debug('[flow:new] getExtra empty', LOG_LEVEL_DEBUG);
    }
  }
  const elapsed = Date.now() - start;
  const hasPrivate = urls && urls.private ? 'true' : 'false';
  const hasPublic = urls && urls.public ? 'true' : 'false';
  Zotero.debug(`[flow:new][getExtra] done private_set=${hasPrivate} public_set=${hasPublic} value="${result ? result.replace(/"/g, '\\"') : '∅'}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}


/**
 * @description Lists attachments that should be saved with the item, such as snapshots or PDFs.
 * @param {Document} doc - The page DOM.
 * @param {{ snapshot?: string|null }} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {Array<Object>} Attachment descriptors compatible with Zotero.
 */
async function getAttachments(doc, urls, ids) {
  const start = Date.now();
  const pickURL = () => {
    if (!urls) return null;
    const candidates = [
      urls.private,
      urls.snapshot,
      urls.item,
      urls.page,
      urls.public
    ];
    return candidates.find(value => typeof value === 'string' && value) || null;
  };
  const snapshotURL = pickURL()
    || (doc && doc.location && doc.location.href)
    || null;
  const normalizeForComparison = (value) => {
    if (!value || typeof value !== 'string') {
      return null;
    }
    const base = doc && doc.location && typeof doc.location.origin === 'string'
      ? doc.location.origin
      : 'https://chatgpt.com';
    try {
      const parsed = new URL(value, base);
      parsed.hash = '';
      return parsed.href;
    }
    catch (_) {
      return value.replace(/#.*$/, '').trim() || null;
    }
  };
  const docURL = doc && doc.location && typeof doc.location.href === 'string'
    ? normalizeForComparison(doc.location.href)
    : null;
  const targetSnapshotForCompare = normalizeForComparison(snapshotURL);
  const needsBackgroundLoad = Boolean(targetSnapshotForCompare
    && docURL
    && targetSnapshotForCompare !== docURL);

  const attachments = [];
  let snapshotDocument = needsBackgroundLoad ? null : doc;
  let method = needsBackgroundLoad ? 'pending' : 'inline';
  if (needsBackgroundLoad && !ENABLE_EMULATED_SNAPSHOT_IN_MULTISAVE) {
    method = 'disabled';
    snapshotDocument = null;
    try {
      const effectiveURL = snapshotURL || '∅';
      Zotero.debug(`[attach][getAttachments] skip background snapshot (feature flag off) url="${String(effectiveURL).replace(/"/g, '\\"')}"`, LOG_LEVEL_DEBUG);
    }
    catch (_) {}
  }
  const ensureDocumentContext = (snapshotDoc, baseHref) => {
    if (!snapshotDoc || !baseHref) {
      return;
    }
    try {
      const head = snapshotDoc.head || snapshotDoc.querySelector && snapshotDoc.querySelector('head');
      if (head && !head.querySelector('base')) {
        const base = snapshotDoc.createElement('base');
        base.href = baseHref;
        head.insertBefore(base, head.firstChild || null);
      }
    }
    catch (_) {}
    try {
      if (!snapshotDoc.location || snapshotDoc.location.href !== baseHref) {
        Object.defineProperty(snapshotDoc, 'location', {
          value: { href: baseHref, toString() { return baseHref; } },
          configurable: true
        });
      }
    }
    catch (_) {}
  };
  const tryFetchSnapshotDocument = async () => {
    if (!snapshotURL) {
      return null;
    }
    const headers = {
      'Accept': 'text/html,application/xhtml+xml'
    };
    let auth = null;
    try {
      auth = await getAPIAuth(doc, urls, ids);
    }
    catch (err) {
      Zotero.debug(`[attach][getAttachments] auth fetch error msg="${err && err.message ? err.message : err}"`, LOG_LEVEL_DEBUG);
    }
    if (auth && auth.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    }
    const response = await callAPI(doc, {
      url: snapshotURL,
      headers,
      responseType: 'text',
      expectJSON: false,
      disableDefaultViewFallback: true,
      preferDefaultView: true,
      timeout: Math.max(9000, ZOTERO_FETCH_DEFAULT_TIMEOUT_MS)
    });
    if (!response || !response.ok || typeof response.data !== 'string') {
      Zotero.debug(`[attach][getAttachments] fetch fail ok=${response && response.ok ? 'true' : 'false'} type=${response && typeof response.data} status=${response && response.status != null ? response.status : '∅'}`, LOG_LEVEL_DEBUG);
      return null;
    }
    const html = response.data.trim();
    Zotero.debug(`[attach][getAttachments] fetch ok status=${response.status != null ? response.status : '∅'} contentType=${response.contentType || '∅'} length=${html.length}`, LOG_LEVEL_DEBUG);
    if (!html) {
      Zotero.debug('[attach][getAttachments] fetch rejected: empty html payload', LOG_LEVEL_DEBUG);
      return null;
    }
    const hasConversationTurn = /data-testid="conversation-turn"/i.test(html);
    const hasAuthorRole = /data-message-author-role/i.test(html);
    Zotero.debug(`[attach][getAttachments] fetch markers turn=${hasConversationTurn ? 'true' : 'false'} role=${hasAuthorRole ? 'true' : 'false'}`, LOG_LEVEL_DEBUG);
    if (!hasConversationTurn && !hasAuthorRole) {
      Zotero.debug('[attach][getAttachments] attempting emulation for pre-hydration markup', LOG_LEVEL_DEBUG);
      try {
        const emulated = await renderEmulatedPage(html, snapshotURL, doc, urls, ids);
        if (emulated && emulated.document) {
          ensureDocumentContext(emulated.document, snapshotURL);
          Zotero.debug(`[attach][getAttachments] emulation success method=${emulated.method || '∅'} url="${(snapshotURL || '∅').replace(/"/g, '\\"')}"`, LOG_LEVEL_DEBUG);
          return emulated;
        }
        Zotero.debug('[attach][getAttachments] emulation returned no document', LOG_LEVEL_DEBUG);
      }
      catch (err) {
        Zotero.debug(`[attach][getAttachments] emulation error msg="${err && err.message ? err.message : err}"`, LOG_LEVEL_ERROR);
      }
      Zotero.debug('[attach][getAttachments] fetch rejected: missing conversation markers', LOG_LEVEL_DEBUG);
      return null;
    }
    let parsed = null;
    try {
      Zotero.debug('[attach][getAttachments] invoking DOMParser on fetched html', LOG_LEVEL_DEBUG);
      parsed = new DOMParser().parseFromString(html, 'text/html');
    }
    catch (err) {
      Zotero.debug(`[attach][getAttachments] DOMParser error msg="${err && err.message ? err.message : err}"`, LOG_LEVEL_ERROR);
      parsed = null;
    }
    if (!parsed) {
      Zotero.debug('[attach][getAttachments] fetch rejected: DOMParser returned null', LOG_LEVEL_DEBUG);
      return null;
    }
    const readyState = parsed.readyState || '∅';
    const bodyChildCount = parsed.body ? parsed.body.childElementCount : '∅';
    Zotero.debug(`[attach][getAttachments] fetch parsed readyState=${readyState} bodyChildren=${bodyChildCount}`, LOG_LEVEL_DEBUG);
    ensureDocumentContext(parsed, snapshotURL);
    return { document: parsed, method: 'http-fetch' };
  };
  if (needsBackgroundLoad && snapshotURL && ENABLE_EMULATED_SNAPSHOT_IN_MULTISAVE) {
    try {
      const fetched = await tryFetchSnapshotDocument();
      if (fetched && fetched.document) {
        snapshotDocument = fetched.document;
        method = fetched.method || 'http-fetch';
        try {
          const effectiveURL = snapshotURL || (snapshotDocument.location && snapshotDocument.location.href) || '∅';
          Zotero.debug(`[attach][getAttachments] background fetch provided method=${method} url="${String(effectiveURL).replace(/"/g, '\\"')}"`, LOG_LEVEL_DEBUG);
        }
        catch (_) {}
      }
    }
    catch (err) {
      Zotero.debug(`[attach][getAttachments] fetch snapshot error target="${snapshotURL}" msg="${err && err.message ? err.message : err}"`, LOG_LEVEL_ERROR);
    }
  }
  if (needsBackgroundLoad && !snapshotDocument && snapshotURL && ENABLE_EMULATED_SNAPSHOT_IN_MULTISAVE) {
    const timeout = 12000;
    const loadHiddenSnapshotDocument = async () => {
      if (!doc || typeof doc.createElement !== 'function') {
        return null;
      }
      const container = doc.body || doc.documentElement;
      if (!container || typeof container.appendChild !== 'function') {
        return null;
      }

      const iframe = doc.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.position = 'fixed';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.opacity = '0';
      iframe.style.pointerEvents = 'none';
      iframe.style.border = '0';
      iframe.style.left = '-10000px';
      iframe.style.top = '-10000px';
      container.appendChild(iframe);

      const cleanupLater = () => {
        setTimeout(() => {
          try {
            if (iframe && iframe.parentNode) {
              iframe.src = 'about:blank';
              iframe.parentNode.removeChild(iframe);
            }
          }
          catch (_) {}
        }, 15000);
      };

      try {
        const loadedDocument = await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (result, isError, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (isError) {
              reject(error || new Error('iframe load error'));
            }
            else {
              resolve(result || null);
            }
          };

          const timer = setTimeout(() => {
            finish(null, true, new Error('iframe load timeout'));
          }, timeout);

          iframe.addEventListener('load', async () => {
            try {
              const frameDocument = iframe.contentDocument;
              if (!frameDocument) {
                finish(null, true, new Error('iframe missing document'));
                return;
              }
              const waitTimeout = Math.max(2500, timeout / 2);
              const selectors = [
                '[data-testid="conversation-turn"]',
                '[data-message-author-role]',
                'main',
                'article'
              ];
              const hasContent = () => {
                if (!frameDocument) return false;
                if (frameDocument.readyState === 'complete') {
                  return true;
                }
                if (!frameDocument.body) {
                  return false;
                }
                return selectors.some(selector => frameDocument.querySelector(selector));
              };

              const waitForContent = async () => {
                // Wait until the injected snapshot iframe finishes loading the conversation DOM.
                const startWait = Date.now();
                while (Date.now() - startWait < waitTimeout) {
                  if (hasContent()) {
                    return true;
                  }
                  await new Promise(resolve => setTimeout(resolve, 120));
                }
                return hasContent();
              };

              await waitForContent();
              finish(frameDocument, false, null);
            }
            catch (err) {
              finish(null, true, err);
            }
          }, { once: true });

          iframe.addEventListener('error', () => {
            finish(null, true, new Error('iframe error event'));
          }, { once: true });

          try {
            iframe.src = snapshotURL;
          }
          catch (err) {
            finish(null, true, err);
          }
        });

        cleanupLater();
        return loadedDocument;
      }
      catch (err) {
        cleanupLater();
        throw err;
      }
    };

    // Background-load conversation in hidden iframe to capture snapshot when viewing a different page.
    try {
      snapshotDocument = await loadHiddenSnapshotDocument();
      if (!snapshotDocument) {
        method = 'iframe-null';
      }
      else {
        method = 'iframe';
        ensureDocumentContext(snapshotDocument, snapshotURL);
      }
    }
    catch (err) {
      method = 'iframe-error';
      snapshotDocument = null;
      Zotero.debug(`[attach][getAttachments] iframe load failed target="${snapshotURL}" msg="${err && err.message ? err.message : err}"`, LOG_LEVEL_ERROR);
    }
  }
  else if (!needsBackgroundLoad) {
    method = 'inline';
  }

  const isEmulatedSnapshot = typeof method === 'string' && method.indexOf('emulated-') === 0;
  const allowEmulatedSnapshot = ENABLE_EMULATED_SNAPSHOT_IN_MULTISAVE || !isEmulatedSnapshot;

  if (snapshotDocument && !allowEmulatedSnapshot) {
    try {
      const effectiveURL = snapshotURL || (snapshotDocument.location && snapshotDocument.location.href) || '∅';
      Zotero.debug(`[attach][getAttachments] skipping emulated snapshot (feature flag off) method=${method} url="${String(effectiveURL).replace(/"/g, '\\"')}"`, LOG_LEVEL_DEBUG);
    }
    catch (_) {}
    snapshotDocument = null;
  }

  if (snapshotDocument) {
    try {
      const effectiveURL = snapshotURL || (snapshotDocument.location && snapshotDocument.location.href) || '∅';
      Zotero.debug(`[attach][getAttachments] attaching document snapshot method=${method} url="${String(effectiveURL).replace(/"/g, '\\"')}"`, LOG_LEVEL_DEBUG);
    }
    catch (_) {}
    attachments.push({
      title: 'ChatGPT Conversation Snapshot',
      document: snapshotDocument,
      url: snapshotURL || (snapshotDocument && snapshotDocument.location ? snapshotDocument.location.href : null),
      snapshot: true,
      mimeType: 'application/xhtml+xml'
    });
  }
  else if (snapshotURL && (ENABLE_EMULATED_SNAPSHOT_IN_MULTISAVE || !needsBackgroundLoad)) {
    try {
      Zotero.debug(`[attach][getAttachments] attaching url-only snapshot method=${method} url="${snapshotURL.replace(/"/g, '\\"')}"`, LOG_LEVEL_DEBUG);
    }
    catch (_) {}
    attachments.push({
      title: 'ChatGPT Conversation Snapshot',
      url: snapshotURL,
      snapshot: false
    });
  }

  try {
    const debugPayload = attachments.map(entry => ({
      title: entry.title,
      url: entry.url || null,
      snapshot: Object.prototype.hasOwnProperty.call(entry, 'snapshot') ? entry.snapshot : null
    }));
    Zotero.debug(`[flow:new] getAttachments method=${method} ${JSON.stringify(debugPayload)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  const elapsed = Date.now() - start;
  Zotero.debug(`[attach][getAttachments] done count=${attachments.length} snapshot="${(snapshotURL || '∅').replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return attachments;
}

async function renderEmulatedPage(htmlPayload, snapshotURL, doc, urls, ids) {
  const start = Date.now();
  const log = (message, level = LOG_LEVEL_DEBUG) => {
    Zotero.debug(`[attach][renderEmulatedPage] ${message}`, level);
  };
  const parseMaybeTimeToMs = (value) => {
    if (value == null) {
      return null;
    }
    if (typeof value === 'number') {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const numeric = Number(trimmed);
      if (!Number.isNaN(numeric)) {
        return numeric < 1e12 ? numeric * 1000 : numeric;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return null;
  };
  const conversationID = ids && ids.conversationID ? ids.conversationID : null;
  const shareRegex = /\/share\/([0-9a-f-]{36})/i;
  const extractShareID = () => {
    const sources = [];
    if (snapshotURL) sources.push(snapshotURL);
    if (urls && urls.public) sources.push(urls.public);
    if (typeof htmlPayload === 'string' && htmlPayload.length) {
      const shareMatch = htmlPayload.match(shareRegex);
      if (shareMatch && shareMatch[1]) {
        return shareMatch[1].toLowerCase();
      }
    }
    if (doc && doc.location && typeof doc.location.href === 'string') {
      sources.push(doc.location.href);
    }
    for (const source of sources) {
      if (typeof source !== 'string') continue;
      const match = source.match(shareRegex);
      if (match && match[1]) {
        return match[1].toLowerCase();
      }
    }
    return null;
  };

  let conversation = null;
  let source = '∅';
  const shareID = extractShareID();

  const fetchPublicConversation = async (shareId) => {
    if (!shareId) {
      return null;
    }
    const response = await callAPI(doc, {
      url: `/backend-api/public/conversation/${shareId}`,
      headers: { 'Accept': 'application/json' },
      responseType: 'json',
      expectJSON: true,
      label: `[chatgpt] /backend-api/public/conversation/${shareId}`
    });
    if (!response || !response.ok || !response.data || typeof response.data !== 'object') {
      log(`public conversation fetch failed share=${shareId} status=${response && response.status != null ? response.status : '∅'}`);
      return null;
    }
    log(`public conversation fetch ok share=${shareId}`, LOG_LEVEL_DEBUG);
    return response.data;
  };

  const fetchPrivateConversation = async (cid) => {
    if (!cid) {
      return null;
    }
    let auth = null;
    try {
      auth = await getAPIAuth(doc, urls, ids);
    }
    catch (err) {
      log(`auth error cid=${cid} msg="${err && err.message ? err.message : err}"`, LOG_LEVEL_ERROR);
    }
    if (!auth || !auth.token) {
      log(`auth missing token cid=${cid}`);
      return null;
    }
    const response = await callAPI(doc, {
      url: `/backend-api/conversation/${cid}`,
      headers: {
        'Authorization': `Bearer ${auth.token}`,
        'Accept': 'application/json'
      },
      responseType: 'json',
      expectJSON: true,
      label: `[chatgpt] /backend-api/conversation/${cid}`
    });
    if (!response || !response.ok || !response.data || typeof response.data !== 'object') {
      log(`private conversation fetch failed cid=${cid} status=${response && response.status != null ? response.status : '∅'}`);
      return null;
    }
    log(`private conversation fetch ok cid=${cid}`, LOG_LEVEL_DEBUG);
    return response.data;
  };

  try {
    if (shareID) {
      conversation = await fetchPublicConversation(shareID);
      if (conversation) {
        source = 'public';
      }
    }
    if (!conversation) {
      conversation = await fetchPrivateConversation(conversationID);
      if (conversation) {
        source = 'private';
      }
    }
  }
  catch (err) {
    log(`conversation fetch error msg="${err && err.message ? err.message : err}"`, LOG_LEVEL_ERROR);
    conversation = null;
  }

  if (!conversation) {
    log('no conversation payload available; cannot emulate');
    return null;
  }

  const resolveConversationRecord = (payload) => {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    if (payload.mapping && typeof payload.mapping === 'object') {
      return payload;
    }
    if (payload.conversation && payload.conversation.mapping && typeof payload.conversation.mapping === 'object') {
      return payload.conversation;
    }
    return null;
  };

  const conversationRecord = resolveConversationRecord(conversation);
  if (!conversationRecord || !conversationRecord.mapping || typeof conversationRecord.mapping !== 'object') {
    log('conversation mapping missing; cannot emulate');
    return null;
  }

  const assignDocumentLocation = (targetDoc, href) => {
    if (!targetDoc || !href || typeof href !== 'string') {
      return;
    }
    log(`assignDocumentLocation href="${href.replace(/"/g, '\\"')}"`);
    const fakeLocation = {
      href,
      toString() {
        return href;
      }
    };
    try {
      Object.defineProperty(targetDoc, 'location', { value: fakeLocation, configurable: true });
    }
    catch (_) {}
    try {
      Object.defineProperty(targetDoc, 'URL', { value: href, configurable: true });
    }
    catch (_) {}
    try {
      Object.defineProperty(targetDoc, 'documentURI', { value: href, configurable: true });
    }
    catch (_) {}
    try {
      Object.defineProperty(targetDoc, 'baseURI', { value: href, configurable: true });
    }
    catch (_) {}
  };

  const outputDoc = (doc && doc.implementation && typeof doc.implementation.createHTMLDocument === 'function')
    ? doc.implementation.createHTMLDocument('ChatGPT Conversation')
    : new DOMParser().parseFromString('<!DOCTYPE html><html><head><title>ChatGPT Conversation</title></head><body></body></html>', 'text/html');

  const head = outputDoc.head || outputDoc.getElementsByTagName('head')[0] || outputDoc.createElement('head');
  if (!outputDoc.head) {
    outputDoc.documentElement.insertBefore(head, outputDoc.documentElement.firstChild || null);
  }
  assignDocumentLocation(outputDoc, snapshotURL);
  if (snapshotURL) {
    const base = outputDoc.createElement('base');
    base.href = snapshotURL;
    head.insertBefore(base, head.firstChild || null);
    log(`inserted base href="${snapshotURL.replace(/"/g, '\\"')}"`);
  }
  if (!head.querySelector('meta[charset]')) {
    const meta = outputDoc.createElement('meta');
    meta.setAttribute('charset', 'UTF-8');
    head.appendChild(meta);
  }
  const documentTitle = conversation.title
    || conversationRecord.title
    || TRANSLATOR_DEFAULTS.title;
  if (!head.querySelector('title')) {
    const titleNode = outputDoc.createElement('title');
    titleNode.textContent = documentTitle;
    head.appendChild(titleNode);
  }
  else {
    head.querySelector('title').textContent = documentTitle;
  }

  const style = outputDoc.createElement('style');
  style.textContent = `
    :root {
      color-scheme: light dark;
      --bubble-radius: 14px;
      --assistant-bg: rgba(52, 152, 219, 0.12);
      --user-bg: rgba(155, 89, 182, 0.12);
      --system-bg: rgba(127, 140, 141, 0.15);
      --border-color: rgba(0,0,0,0.08);
      --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "Fira Code", "Menlo", "Consolas", monospace;
    }
    body {
      margin: 0 auto;
      padding: 32px 24px 64px;
      max-width: 860px;
      font-family: var(--font-body);
      line-height: 1.6;
      background: #f9f9fb;
      color: #111;
    }
    header {
      margin-bottom: 32px;
    }
    header h1 {
      margin: 0;
      font-size: 1.8rem;
      font-weight: 600;
    }
    header p {
      margin: 4px 0 0;
      color: #555;
    }
    .conversation {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .message {
      border-radius: var(--bubble-radius);
      padding: 18px 20px;
      border: 1px solid var(--border-color);
      background: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .message.role-assistant {
      background: var(--assistant-bg);
      border-color: rgba(41, 128, 185, 0.25);
    }
    .message.role-user {
      background: var(--user-bg);
      border-color: rgba(142, 68, 173, 0.25);
    }
    .message.role-system {
      background: var(--system-bg);
      border-color: rgba(127, 140, 141, 0.25);
    }
    .message-meta {
      font-size: 0.9rem;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px;
      color: #2c3e50;
    }
    .message-body p {
      margin: 0 0 12px;
      white-space: pre-wrap;
    }
    .message-body pre {
      background: rgba(0,0,0,0.06);
      border-radius: 10px;
      padding: 14px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 0.92rem;
      margin: 0 0 12px;
      white-space: pre;
    }
    .message-body code {
      font-family: var(--font-mono);
    }
    .message-body img {
      max-width: 100%;
      border-radius: 10px;
      margin: 12px 0;
    }
    footer {
      margin-top: 36px;
      font-size: 0.85rem;
      color: #7f8c8d;
      text-align: center;
    }
  `;
  head.appendChild(style);

  const body = outputDoc.body || outputDoc.createElement('body');
  if (!outputDoc.body) {
    outputDoc.documentElement.appendChild(body);
  }
  while (body.firstChild) {
    body.removeChild(body.firstChild);
  }

  const header = outputDoc.createElement('header');
  const heading = outputDoc.createElement('h1');
  heading.textContent = documentTitle;
  header.appendChild(heading);

  const infoLineParts = [];
  const humanAuthor = conversationRecord.metadata && typeof conversationRecord.metadata === 'object'
    ? (conversationRecord.metadata.author || null)
    : null;
  if (humanAuthor && typeof humanAuthor === 'string') {
    infoLineParts.push(`Shared by ${humanAuthor}`);
  }
  else if (conversation.metadata && conversation.metadata.share_author) {
    infoLineParts.push(`Shared by ${conversation.metadata.share_author}`);
  }

  const isoMs = conversation.update_time || conversationRecord.update_time || conversation.create_time || conversationRecord.create_time;
  const isoDateMs = parseMaybeTimeToMs(isoMs);
  if (isoDateMs != null) {
    const date = new Date(isoDateMs);
    infoLineParts.push(`Updated ${date.toLocaleString()}`);
  }
  if (infoLineParts.length) {
    const subheading = outputDoc.createElement('p');
    subheading.textContent = infoLineParts.join(' • ');
    header.appendChild(subheading);
  }
  body.appendChild(header);

  const conversationList = outputDoc.createElement('div');
  conversationList.className = 'conversation';
  body.appendChild(conversationList);

  const mapping = conversationRecord.mapping;
  const orderedMessages = [];
  const seenNodes = new Set();
  let cursor = conversationRecord.current_node || null;
  while (cursor && mapping[cursor] && !seenNodes.has(cursor)) {
    const node = mapping[cursor];
    if (node && node.message) {
      orderedMessages.push(node.message);
    }
    seenNodes.add(cursor);
    cursor = node && node.parent ? node.parent : null;
  }
  orderedMessages.reverse();

  const messageSet = new Set(orderedMessages.map(msg => msg && msg.id).filter(Boolean));
  const resolveTimestamp = (message) => {
    if (!message || typeof message !== 'object') return 0;
    const candidates = [
      message.update_time,
      message.create_time,
      message.metadata && typeof message.metadata === 'object' ? message.metadata.timestamp : null
    ];
    for (const entry of candidates) {
      const ms = parseMaybeTimeToMs(entry);
      if (ms != null && Number.isFinite(ms)) {
        return ms;
      }
    }
    return 0;
  };

  const remainingMessages = [];
  for (const node of Object.values(mapping)) {
    if (!node || !node.message) continue;
    if (node.id && messageSet.has(node.id)) continue;
    remainingMessages.push(node.message);
  }
  remainingMessages.sort((a, b) => resolveTimestamp(a) - resolveTimestamp(b));
  for (const message of remainingMessages) {
    if (!message) continue;
    if (message.id) {
      messageSet.add(message.id);
    }
    orderedMessages.push(message);
  }

  const roleLabels = {
    assistant: TRANSLATOR_DEFAULTS.aiName,
    user: TRANSLATOR_DEFAULTS.humanAuthor || 'User',
    system: 'System',
    tool: 'Tool'
  };

  const appendTextBlock = (container, text) => {
    if (!text) {
      return;
    }
    const trimmed = String(text);
    const hasCodeFence = trimmed.trim().startsWith('```') || trimmed.includes('\n');
    if (hasCodeFence) {
      const pre = outputDoc.createElement('pre');
      pre.textContent = trimmed.replace(/^```[a-zA-Z0-9-]*\s*/, '').replace(/```$/, '');
      container.appendChild(pre);
      return;
    }
    const paragraph = outputDoc.createElement('p');
    paragraph.textContent = trimmed;
    container.appendChild(paragraph);
  };

  const appendPart = (container, part) => {
    if (typeof part === 'string') {
      appendTextBlock(container, part);
      return;
    }
    if (!part || typeof part !== 'object') {
      return;
    }
    if (part.text) {
      appendTextBlock(container, part.text);
      return;
    }
    if (part.type === 'text' && part.content) {
      appendTextBlock(container, part.content);
      return;
    }
    if (part.type === 'image_url' && part.image_url && part.image_url.url) {
      const figure = outputDoc.createElement('figure');
      const img = outputDoc.createElement('img');
      img.src = part.image_url.url;
      figure.appendChild(img);
      if (part.image_url.alt_text) {
        const caption = outputDoc.createElement('figcaption');
        caption.textContent = part.image_url.alt_text;
        figure.appendChild(caption);
      }
      container.appendChild(figure);
      return;
    }
    const pre = outputDoc.createElement('pre');
    try {
      pre.textContent = JSON.stringify(part, null, 2);
    }
    catch (_) {
      pre.textContent = String(part);
    }
    container.appendChild(pre);
  };

  for (const message of orderedMessages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const author = message.author && typeof message.author === 'object' ? message.author.role : null;
    const role = typeof author === 'string' ? author.toLowerCase() : 'system';
    if (role === 'tool') {
      continue;
    }
    const section = outputDoc.createElement('section');
    section.className = `message role-${role}`;

    const meta = outputDoc.createElement('div');
    meta.className = 'message-meta';
    const label = roleLabels[role] || role.charAt(0).toUpperCase() + role.slice(1);
    const titleSpan = outputDoc.createElement('span');
    titleSpan.textContent = label;
    meta.appendChild(titleSpan);

    const ts = resolveTimestamp(message);
    if (ts) {
      const tsSpan = outputDoc.createElement('span');
      tsSpan.textContent = new Date(ts).toLocaleString();
      meta.appendChild(tsSpan);
    }

    section.appendChild(meta);
    const bodyContainer = outputDoc.createElement('div');
    bodyContainer.className = 'message-body';

    const content = message.content;
    if (content && typeof content === 'object') {
      if (Array.isArray(content.parts) && content.parts.length) {
        for (const part of content.parts) {
          appendPart(bodyContainer, part);
        }
      }
      else if (typeof content.text === 'string') {
        appendTextBlock(bodyContainer, content.text);
      }
    }
    else if (message.text) {
      appendTextBlock(bodyContainer, message.text);
    }

    if (!bodyContainer.firstChild) {
      appendTextBlock(bodyContainer, '[empty response]');
    }

    section.appendChild(bodyContainer);
    conversationList.appendChild(section);
  }

  const footer = outputDoc.createElement('footer');
  footer.textContent = 'Snapshot rendered by Zotero ChatGPT translator emulation.';
  body.appendChild(footer);

  const elapsed = Date.now() - start;
  let finalHref = '∅';
  try {
    finalHref = outputDoc && outputDoc.location && outputDoc.location.href ? outputDoc.location.href : '∅';
  }
  catch (_) {}
  log(`emulation complete source=${source} messages=${orderedMessages.length} url="${String(finalHref).replace(/"/g, '\\"')}" ms=${elapsed}`);
  return { document: outputDoc, method: `emulated-${source}` };
}

/**
 * @description Determines the key URLs associated with the current conversation context.
 * @param {Document} doc - The page DOM.
 * @param {string} pageURL - The URL passed into getItem.
 * @param {{ conversationID?: string|null }} ids - Identifier bundle returned from getIDs.
 * @param {{}} apiEndpoints - Map returned from getAPIEndpoints with related API paths.
 * @returns {{ page: string|null, private: string|null, public: string|null, item: string|null, snapshot: string|null }}
 */
function getURLs(doc, pageURL, ids, apiEndpoints = {}) {
  const start = Date.now();
  const normalize = (value) => {
    if (!value || typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const base = doc && doc.location && doc.location.origin ? doc.location.origin : undefined;
    try {
      const parsed = new URL(trimmed, base);
      parsed.hash = '';
      return parsed.href;
    }
    catch (_) {
      const cleaned = trimmed.replace(/#.*$/, '').trim();
      return cleaned || null;
    }
  };
  const resolveOrigin = (hintURL) => {
    if (doc && doc.location && typeof doc.location.origin === 'string' && doc.location.origin) {
      return doc.location.origin;
    }
    if (typeof hintURL === 'string') {
      try {
        return new URL(hintURL, 'https://chatgpt.com').origin;
      }
      catch (_) {}
    }
    return 'https://chatgpt.com';
  };
  const extractProjectSlug = (value) => {
    let slug = null;
    if (value && typeof value === 'string') {
      let pathname = value;
      if (/^https?:\/\//i.test(value) || value.startsWith('//')) {
        try {
          pathname = new URL(value, 'https://chatgpt.com').pathname;
        }
        catch (_) {
          pathname = value;
        }
      }
      const match = pathname.match(/\/g\/([^/]+)/i);
      if (match && match[1]) {
        try {
          slug = decodeURIComponent(match[1].trim());
        }
        catch (_) {
          slug = match[1].trim();
        }
        if (slug && slug.includes('/')) {
          slug = slug.split('/')[0];
        }
      }
    }
    return slug || null;
  };
  const buildProjectConversationURL = (conversationID, projectSlug, originHint) => {
    const slug = typeof projectSlug === 'string' && projectSlug.trim() ? projectSlug.trim() : null;
    const normalizedConversationID = normalizeConversationID(conversationID);
    let resolvedOrigin = null;
    if (typeof originHint === 'string' && originHint.trim()) {
      resolvedOrigin = originHint.trim();
    }
    if (!resolvedOrigin && doc && doc.location && typeof doc.location.origin === 'string' && doc.location.origin) {
      resolvedOrigin = doc.location.origin;
    }
    if (!resolvedOrigin) {
      resolvedOrigin = 'https://chatgpt.com';
    }
    const cleanOrigin = resolvedOrigin.replace(/\/$/, '');
    if (!cleanOrigin || !slug || !normalizedConversationID) {
      return null;
    }
    const cleanSlug = slug.replace(/^\//, '').split('/')[0];
    if (!cleanSlug) {
      return null;
    }
    return `${cleanOrigin}/g/${cleanSlug}/c/${normalizedConversationID}`;
  };
  const isConversationURL = (value) => {
    if (!value || typeof value !== 'string') {
      return false;
    }
    try {
      const origin = doc && doc.location && doc.location.origin
        ? doc.location.origin
        : 'https://chatgpt.com';
      const parsed = new URL(value, origin);
      return PROJECT_CONVERSATION_PATH_REGEX.test(parsed.pathname || '');
    }
    catch (_) {
      return PROJECT_CONVERSATION_PATH_REGEX.test(value);
    }
  };
  const hasProjectPath = (value) => {
    if (!value || typeof value !== 'string') {
      return false;
    }
    return /\/project(?:\/|$)/i.test(value);
  };

  const normalizedPage = normalize(pageURL) || normalize(doc && doc.location && doc.location.href);
  const detectProjectURL = () => {
    const candidates = [];
    if (doc && doc.location && typeof doc.location.href === 'string') {
      candidates.push(doc.location.href);
    }
    if (pageURL && typeof pageURL === 'string') {
      candidates.push(pageURL);
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'string') continue;
      if (!PROJECT_PAGE_REGEX.test(candidate)) continue;
      const normalized = normalize(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  };
  const projectURL = detectProjectURL();

  const privateURL = getPrivateURL(doc, normalizedPage, ids);
  const publicURL = getPublicURL(doc, normalizedPage, ids);
  
  let itemURL = null;
  let snapshotURL = null;

  if (privateURL && publicURL) {
    itemURL = publicURL;
    snapshotURL = privateURL;
  }
  else if (privateURL || publicURL) {
    itemURL = privateURL || publicURL;
    snapshotURL = itemURL;
  }

  const result = {
    page: normalizedPage,
    private: privateURL || null,
    public: publicURL || null,
    item: itemURL,
    snapshot: snapshotURL,
    project: projectURL
  };
  const resolveConversationURL = () => {
    if (!ids || !ids.conversationID) {
      return null;
    }
    const existingConversation = [result.private, result.page, result.item, result.public]
      .find(candidate => candidate && isConversationURL(candidate));
    if (existingConversation) {
      return existingConversation;
    }
    const slugHints = [
      ids && ids.projectSlug,
      extractProjectSlug(result.project),
      extractProjectSlug(result.page),
      extractProjectSlug(result.private),
      extractProjectSlug(result.public),
      extractProjectSlug(pageURL),
      extractProjectSlug(doc && doc.location && doc.location.href)
    ].filter(Boolean);
    if (!slugHints.length) {
      return null;
    }
    const originGuess = resolveOrigin(result.project || result.page || pageURL);
    return buildProjectConversationURL(
      ids.conversationID,
      slugHints[0],
      originGuess
    );
  };
  const conversationURL = resolveConversationURL();
  if (conversationURL && isConversationURL(conversationURL)) {
    if (!result.item || hasProjectPath(result.item)) {
      result.item = conversationURL;
    }
    if (!result.snapshot || hasProjectPath(result.snapshot)) {
      result.snapshot = conversationURL;
    }
    if (!result.private || hasProjectPath(result.private)) {
      result.private = conversationURL;
    }
  }
  try {
    Zotero.debug(`[flow:new] getURLs result ${JSON.stringify(result)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  const elapsed = Date.now() - start;
  Zotero.debug(`[urls][getURLs] done page="${(result.page || '∅').replace(/"/g, '\\"')}" private_set=${result.private ? 'true' : 'false'} public_set=${result.public ? 'true' : 'false'} item="${(result.item || '∅').replace(/"/g, '\\"')}" snapshot="${(result.snapshot || '∅').replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}



/**
 * @description Resolves the best authenticated URL for the current conversation.
 * @param {Document} doc - The page DOM.
 * @param {string|null} pageURL - Normalized page URL.
 * @param {{ conversationID?: string|null }} ids - Identifier bundle returned from getIDs.
 * @returns {string|null}
 */
function getPrivateURL(doc, pageURL, ids) {
  const start = Date.now();
  const normalize = (value) => {
    if (!value || typeof value !== 'string') {
      return null;
    }
    const base = doc && doc.location && doc.location.origin ? doc.location.origin : undefined;
    try {
      const parsed = new URL(value, base);
      parsed.hash = '';
      return parsed.href;
    }
    catch (_) {
      const cleaned = value.replace(/#.*$/, '').trim();
      return cleaned || null;
    }
  };

  const candidates = [];
  if (typeof pageURL === 'string') {
    candidates.push(pageURL);
  }
  if (doc && doc.location && typeof doc.location.href === 'string') {
    candidates.push(doc.location.href);
  }

  let resolved = null;
  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    if (!normalized) continue;
    if (/\/share(?:\/|$)/i.test(normalized)) {
      continue;
    }
    Zotero.debug(`[flow:new] getPrivateURL selected ${normalized}`, LOG_LEVEL_DEBUG);
    resolved = normalized;
    break;
  }

  if (!resolved) {
    Zotero.debug('[flow:new] getPrivateURL no private URL resolved', LOG_LEVEL_DEBUG);
  }
  const elapsed = Date.now() - start;
  Zotero.debug(`[urls][getPrivateURL] done value="${(resolved || '∅').replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}

/**
 * @description Resolves a shareable/public URL for the conversation when available.
 * @param {Document} doc - The page DOM.
 * @param {string|null} pageURL - Normalized page URL.
 * @param {{ conversationID?: string|null }} ids - Identifier bundle returned from getIDs.
 * @returns {string|null}
 */
function getPublicURL(doc, pageURL, ids) {
  const start = Date.now();
  if (!doc || typeof doc.querySelector !== 'function') return null;

  const defaultHost = (() => {
    const host = doc && doc.location && String(doc.location.host || '').toLowerCase();
    if (host && host.includes('chat.openai.com')) {
      return 'https://chat.openai.com';
    }
    return 'https://chatgpt.com';
  })();

  const normalizeShare = (candidate, keyHint) => {
    if (!candidate || typeof candidate !== 'string') return null;
    let cleaned = candidate.trim();
    if (!cleaned) return null;
    if (cleaned.includes('\\u002F')) {
      cleaned = cleaned.replace(/\\u002F/gi, '/');
    }
    const direct = cleaned.match(SHARE_URL_REGEX);
    if (direct) {
      const hostMatch = cleaned.match(/https?:\/\/(chatgpt\.com|chat\.openai\.com)/i);
      const host = hostMatch ? `https://${hostMatch[1].toLowerCase()}` : defaultHost;
      return `${host}/share/${direct[1].toLowerCase()}`;
    }
    const pathMatch = cleaned.match(SHARE_PATH_REGEX);
    if (pathMatch) {
      return `${defaultHost}/share/${pathMatch[1].toLowerCase()}`;
    }
    if (keyHint && /share/i.test(keyHint)) {
      const idMatch = cleaned.match(SHARE_ID_REGEX);
      if (idMatch) {
        return `${defaultHost}/share/${idMatch[0].toLowerCase()}`;
      }
    }
    return null;
  };

  const seen = new Set();
  const candidates = [];
  const pushCandidate = (raw, source) => {
    const normalized = normalizeShare(raw, source);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  if (typeof pageURL === 'string') {
    pushCandidate(pageURL, 'page');
  }

  const metaSelectors = [
    { selector: 'meta[property="og:url"]', attr: 'content', source: 'meta[og:url]' },
    { selector: 'meta[name="twitter:url"]', attr: 'content', source: 'meta[twitter:url]' },
    { selector: 'meta[name="share-url"]', attr: 'content', source: 'meta[share-url]' },
    { selector: 'meta[name="shareUrl"]', attr: 'content', source: 'meta[shareUrl]' },
    { selector: 'link[rel="canonical"]', attr: 'href', source: 'link[canonical]' }
  ];
  for (const entry of metaSelectors) {
    const node = doc.querySelector(entry.selector);
    if (!node) continue;
    pushCandidate(node.getAttribute(entry.attr), entry.source);
  }

  const shareMetaNodes = doc.querySelectorAll('meta[content*="/share/"]');
  for (const node of shareMetaNodes) {
    pushCandidate(node.getAttribute('content'), 'meta[*="/share/"]');
  }

  const linkNodes = doc.querySelectorAll('a[href*="/share/"]');
  let linkCount = 0;
  for (const node of linkNodes) {
    pushCandidate(node.getAttribute('href') || node.href, 'a[href*="/share/"]');
    if (++linkCount >= 4) break;
  }

  const dataNodes = doc.querySelectorAll('[data-share-url], [data-share-link], [data-public-share-url]');
  for (const node of dataNodes) {
    const attrs = ['data-share-url', 'data-share-link', 'data-public-share-url'];
    for (const attr of attrs) {
      const value = node.getAttribute(attr);
      if (value) {
        pushCandidate(value, attr);
      }
    }
  }

  const body = doc.body;
  if (body && body.dataset) {
    for (const key of Object.keys(body.dataset)) {
      if (!/share/i.test(key)) continue;
      pushCandidate(body.dataset[key], `body.dataset.${key}`);
    }
  }

  const scriptSelectors = 'script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__, script[data-state]';
  const scripts = doc.querySelectorAll(scriptSelectors);
  for (const script of scripts) {
    const text = script && script.textContent;
    if (!text || text.length > 750000) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    }
    catch (_) {
      parsed = null;
    }
    if (!parsed) continue;
    const seenObjects = new Set();
    const findShare = (value, keyHint) => {
      if (typeof value === 'string') {
        const normalized = normalizeShare(value, keyHint);
        if (normalized) {
          return normalized;
        }
        return null;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          const result = findShare(entry, keyHint);
          if (result) {
            return result;
          }
        }
        return null;
      }
      if (value && typeof value === 'object') {
        if (seenObjects.has(value)) {
          return null;
        }
        seenObjects.add(value);
        for (const [key, entry] of Object.entries(value)) {
          const result = findShare(entry, key);
          if (result) {
            return result;
          }
        }
      }
      return null;
    };
    const fromScript = findShare(parsed, '');
    if (fromScript) {
      const source = script.id ? `script#${script.id}` : script.getAttribute('type') || 'script[data-state]';
      pushCandidate(fromScript, source);
    }
  }

  const resolved = candidates.length ? candidates[0] : null;
  Zotero.debug(`[flow:new] getPublicURL resolved ${resolved || '∅'}`, LOG_LEVEL_DEBUG);
  const elapsed = Date.now() - start;
  Zotero.debug(`[urls][getPublicURL] done value="${(resolved || '∅').replace(/"/g, '\\"')}" candidates=${candidates.length} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}


/**
 * @description Collects the primary identifiers needed to stitch together chat transcripts.
 * @param {Document} doc - The page DOM.
 * @param {string} url - The URL of the current page.
 * @returns {{ conversationID: string|null, lastPromptID: string|null, lastResponseID: string|null }}
 */
function getIDs(doc, url) {
  const start = Date.now();
  const extractFromURL = (value) => {
    if (!value || typeof value !== 'string') return null;
    const shareMatch = value.match(/\/share\/(?:e\/|embed\/)?([0-9a-f-]{36})(?=($|[/?#]))/i);
    if (shareMatch && shareMatch[1]) {
      return shareMatch[1].toLowerCase();
    }
    const conversationMatch = value.match(/\/(?:app\/)?c\/([0-9a-f-]{36})(?=($|[/?#]))/i)
      || value.match(/\/conversation\/([0-9a-f-]{36})(?=($|[/?#]))/i);
    if (conversationMatch && conversationMatch[1]) {
      return conversationMatch[1].toLowerCase();
    }
    return null;
  };

  let conversationID = null;
  if (typeof url === 'string') {
    conversationID = extractFromURL(url);
  }
  if (!conversationID && doc && doc.location && typeof doc.location.href === 'string') {
    conversationID = extractFromURL(doc.location.href);
  }

  if (!conversationID && typeof getDOMConversationID === 'function') {
    conversationID = normalizeConversationID(getDOMConversationID(doc, url));
  }

  if (!conversationID && doc && typeof doc.querySelector === 'function') {
    const selectors = [
      '[data-conversation-id]',
      '[data-conversationid]',
      '[data-conversation]',
      'meta[name="conversation-id"]',
      'meta[name="conversationId"]',
      'meta[property="conversation-id"]',
      'meta[property="conversationId"]'
    ];
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      if (!node) continue;
      const raw = node.getAttribute('data-conversation-id')
        || node.getAttribute('data-conversationid')
        || node.getAttribute('data-conversation')
        || node.getAttribute('content')
        || node.getAttribute('value');
      const candidate = extractFromURL(raw)
        || (raw && SHARE_ID_REGEX.test(raw) ? raw.match(SHARE_ID_REGEX)[0].toLowerCase() : null);
      if (candidate) {
        conversationID = candidate;
        break;
      }
    }
  }

  if (!conversationID) {
    const publicURL = getPublicURL(doc, url, {});
    if (publicURL) {
      conversationID = extractFromURL(publicURL);
    }
  }

  const result = {
    conversationID: conversationID || null,
    lastPromptID: typeof getDOMLastPromptID === 'function'
      ? getDOMLastPromptID(doc)
      : null,
    lastResponseID: typeof getDOMLastResponseID === 'function'
      ? getDOMLastResponseID(doc)
      : null
  };
  try {
    Zotero.debug(`[flow:new] getIDs result ${JSON.stringify(result)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  const elapsed = Date.now() - start;
  Zotero.debug(`[ids][getIDs] done cid=${result.conversationID || '∅'} lastPromptID=${result.lastPromptID || '∅'} lastResponseID=${result.lastResponseID || '∅'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

/* Above this Line functions should be identical to ai_translator_pattern with rare exception */


  ///////////////////
 // DOM Functions //
///////////////////


/**
 * @description Derives the stable conversation identifier from the DOM/URL for the current chat view.
 * @param {Document} doc - The page DOM.
 * @param {string} url - The URL of the current page.
 * @returns {string|null} A normalized conversation ID or null when unavailable.
 */
function getDOMConversationID(doc, url) {
  const start = Date.now();
  let resolved = null;
  const extractFromURL = (value) => {
    if (!value || typeof value !== 'string') return null;
    const shareMatch = value.match(/\/share\/(?:e\/|embed\/)?([0-9a-f-]{36})(?=($|[/?#]))/i);
    if (shareMatch && shareMatch[1]) {
      return shareMatch[1].toLowerCase();
    }
    const conversationMatch = value.match(/\/(?:app\/)?c\/([0-9a-f-]{36})(?=($|[/?#]))/i)
      || value.match(/\/conversation\/([0-9a-f-]{36})(?=($|[/?#]))/i);
    if (conversationMatch && conversationMatch[1]) {
      return conversationMatch[1].toLowerCase();
    }
    return null;
  };

  if (typeof url === 'string') {
    const fromURL = extractFromURL(url);
    if (fromURL) {
      resolved = fromURL;
    }
  }

  if (!resolved && doc && doc.location && typeof doc.location.href === 'string') {
    const fromLocation = extractFromURL(doc.location.href);
    if (fromLocation) {
      resolved = fromLocation;
    }
  }

  const elapsed = Date.now() - start;
  Zotero.debug(`[dom][getDOMConversationID] done value=${resolved || '∅'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}

/**
 * @description Resolves the identifier for the most recent user prompt in the transcript.
 * @param {Document} doc - The page DOM.
 * @returns {string|null} The latest user prompt ID or null when it cannot be determined.
 */
function getDOMLastPromptID(doc) {
  const start = Date.now();
  let resolved = null;
  if (!doc || typeof doc.querySelectorAll !== 'function') {
    const elapsedEarly = Date.now() - start;
    Zotero.debug(`[dom][getDOMLastPromptID] done value=∅ ms=${elapsedEarly}`, LOG_LEVEL_DEBUG);
    return null;
  }

  // TODO: Inspect DOM attributes or embedded data to capture the latest user message ID.
  // Example approach: querySelectorAll('[id^="message-content-id-r_"]') and extract the trailing token.

  const elapsed = Date.now() - start;
  Zotero.debug(`[dom][getDOMLastPromptID] done value=${resolved || '∅'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}

/**
 * @description Resolves the identifier for the most recent AI response in the transcript.
 * @param {Document} doc - The page DOM.
 * @returns {string|null} The latest AI response ID or null when it cannot be determined.
 */
function getDOMLastResponseID(doc) {
  const start = Date.now();
  let resolved = null;
  if (!doc || typeof doc.querySelectorAll !== 'function') {
    const elapsedEarly = Date.now() - start;
    Zotero.debug(`[dom][getDOMLastResponseID] done value=∅ ms=${elapsedEarly}`, LOG_LEVEL_DEBUG);
    return null;
  }

  // TODO: Inspect DOM attributes or embedded data to capture the latest AI response ID.
  // Example approach: querySelectorAll('[data-test-draft-id^="rc_"]') or scan inline telemetry payloads.

  const elapsed = Date.now() - start;
  Zotero.debug(`[dom][getDOMLastResponseID] done value=${resolved || '∅'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}

function getDOMTitle(doc, urls, ids) {
  const start = Date.now();
  if (!doc || typeof doc.querySelector !== 'function') {
    const elapsedEarly = Date.now() - start;
    Zotero.debug(`[dom][getDOMTitle] done value="∅" source=∅ ms=${elapsedEarly}`, LOG_LEVEL_DEBUG);
    return null;
  }

  let resolved = null;
  let source = '∅';

  const extractText = (node) => {
    if (!node) return null;
    if (node.getAttribute) {
      const content = node.getAttribute('content');
      if (content && content.trim()) return content.trim();
      const valueAttr = node.getAttribute('value');
      if (valueAttr && valueAttr.trim()) return valueAttr.trim();
    }
    if (typeof node.textContent === 'string') {
      const textContent = node.textContent.trim();
      if (textContent) return textContent;
    }
    return null;
  };

  const recordIfValid = (rawValue, label) => {
    if (!rawValue) return false;
    const normalized = normalizeTitle(rawValue);
    if (!normalized) return false;
    resolved = normalized;
    source = label;
    return true;
  };

  if (typeof doc.title === 'string' && doc.title.trim()) {
    recordIfValid(doc.title, 'document.title');
  }

  if (!resolved) {
    const titleNode = doc.querySelector('title');
    if (titleNode && typeof titleNode.textContent === 'string') {
      recordIfValid(titleNode.textContent.trim(), 'title');
    }
  }

  if (!resolved) {
    const targetedSelectors = [
      '[data-testid="conversation-title"]',
      '[data-testid="conversation-detail-title"]'
    ];
    for (const selector of targetedSelectors) {
      const node = doc.querySelector(selector);
      if (!node) continue;
      const value = extractText(node);
      if (recordIfValid(value, selector)) {
        break;
      }
    }
  }

  if (!resolved) {
    const metaSelectors = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="title"]'
    ];
    for (const selector of metaSelectors) {
      const node = doc.querySelector(selector);
      if (!node) continue;
      const value = extractText(node);
      if (recordIfValid(value, selector)) {
        break;
      }
    }
  }

  const elapsed = Date.now() - start;
  Zotero.debug(`[dom][getDOMTitle] done value="${(resolved || '∅').replace(/"/g, '\\"')}" source=${source} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}

/**
 * @description Extracts the AI participant name from the DOM.
 * @param {Document} doc - The page DOM.
 * @param {{}} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {string|null} Raw AI name text or null when unavailable.
 */
function getDOMAIName(doc, urls, ids) {
  const start = Date.now();
  const resolved = 'ChatGPT';
  const elapsed = Date.now() - start;
  Zotero.debug(`[dom][getDOMAIName] done value="${resolved}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}

/**
 * @description Extracts the human participant name from the DOM.
 * @param {Document} doc - The page DOM.
 * @param {{}} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {string|null} Raw human name text or null when unavailable.
 */
function getDOMHumanAuthor(doc, urls, ids) {
  const start = Date.now();
  if (!doc || typeof doc.querySelector !== 'function') {
    const elapsedEarly = Date.now() - start;
    Zotero.debug(`[dom][getDOMHumanAuthor] done value="∅" candidates=0 ms=${elapsedEarly}`, LOG_LEVEL_DEBUG);
    return null;
  }

  const candidates = [];
  const seenValues = new Set();
  const trimValue = (value) => {
    if (value == null) return null;
    const base = typeof value === 'string' ? value : String(value);
    const trimmed = typeof ZU !== 'undefined' && typeof ZU.trimInternal === 'function'
      ? ZU.trimInternal(base)
      : base.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/\s+/g, ' ');
    const lower = normalized.toLowerCase();
    if (lower === 'chatgpt' || lower === 'chat gpt' || lower === 'openai') {
      return null;
    }
    return normalized;
  };
  const pushCandidate = (value, source) => {
    const normalized = trimValue(value);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seenValues.has(key)) return;
    seenValues.add(key);
    candidates.push({ value: normalized, source });
  };

  if (typeof doc.evaluate === 'function') {
    const xpathSources = [
      { expression: '//*[@id][starts-with(@id,"radix-")]/div[2]/div[1]/div', label: 'radix-owner-business' },
      { expression: '//*[@id][starts-with(@id,"radix-")]/div[1]/div[2]/div[1]/div', label: 'radix-owner-personal' }
    ];
    for (const xpath of xpathSources) {
      try {
        const node = doc.evaluate(xpath.expression, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)?.singleNodeValue;
        if (node && typeof node.textContent === 'string') {
          pushCandidate(node.textContent, xpath.label);
        }
      }
      catch (_) {}
    }
  }

  const attributeSelectors = [
    { selector: '[data-conversation-owner]', attribute: 'data-conversation-owner', label: 'data-conversation-owner' },
    { selector: 'meta[name="author"]', attribute: 'content', label: 'meta[name=\"author\"]' },
    { selector: 'meta[property="profile:username"]', attribute: 'content', label: 'meta[property=\"profile:username\"]' },
    { selector: 'meta[property="profile:last_name"]', attribute: 'content', label: 'meta[property=\"profile:last_name\"]' },
    { selector: 'meta[name="twitter:creator"]', attribute: 'content', label: 'meta[name=\"twitter:creator\"]' }
  ];
  for (const { selector, attribute, label } of attributeSelectors) {
    try {
      const node = doc.querySelector(selector);
      if (!node) continue;
      const attrValue = attribute
        ? node.getAttribute(attribute)
        : (node.getAttribute('content') || node.getAttribute('value'));
      const fallbackText = !attribute && node && typeof node.textContent === 'string' ? node.textContent : null;
      pushCandidate(attrValue || fallbackText, label);
    }
    catch (_) {}
  }

  const resolvedEntry = candidates.length ? candidates[0] : null;
  const resolved = resolvedEntry ? resolvedEntry.value : null;
  const elapsed = Date.now() - start;
  const sourcesForLog = candidates.length
    ? candidates.map(entry => entry.source).join('|')
    : '∅';
  Zotero.debug(`[dom][getDOMHumanAuthor] done value="${(resolved || '∅').replace(/"/g, '\\"')}" candidates=${candidates.length} sources="${String(sourcesForLog).replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}

/**
 * @description Extracts the AI model label from the DOM.
 * @param {Document} doc - The page DOM.
 * @param {{}} urls - Normalized URLs returned from getURLs.
 * @param {{}} ids - Identifier bundle returned from getIDs.
 * @returns {string|null} Raw model text or null when unavailable.
 */
function getDOMAIModel(doc, urls, ids) {
  const start = Date.now();
  if (!doc || typeof doc.querySelector !== 'function') {
    const elapsedEarly = Date.now() - start;
    Zotero.debug(`[dom][getDOMAIModel] done value="∅" source=∅ ms=${elapsedEarly}`, LOG_LEVEL_DEBUG);
    return null;
  }

  let resolved = null;
  let source = '∅';
  const selectors = [
    'meta[name="ai-model"]',
    'meta[name="model"]',
    'meta[property="ai:model"]'
  ];
  for (const selector of selectors) {
    const node = doc.querySelector(selector);
    if (!node) continue;
    const value = node.getAttribute('content') || node.getAttribute('value');
    if (value && value.trim()) {
      resolved = value.trim();
      source = selector;
      break;
    }
  }

  const body = doc.body;
  if (body && body.dataset) {
    if (body.dataset.aiModel) {
      resolved = body.dataset.aiModel;
      source = 'body.dataset.aiModel';
    }
    if (!resolved && body.dataset.model) {
      resolved = body.dataset.model;
      source = 'body.dataset.model';
    }
  }

  const elapsed = Date.now() - start;
  Zotero.debug(`[dom][getDOMAIModel] done value="${(resolved || '∅').replace(/"/g, '\\"')}" source=${source} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}

function getDOMDate(doc, urls, ids) {
  const start = Date.now();
  if (!doc || typeof doc.querySelector !== 'function') {
    const elapsedEarly = Date.now() - start;
    Zotero.debug(`[dom][getDOMDate] done value="∅" source=∅ ms=${elapsedEarly}`, LOG_LEVEL_DEBUG);
    return null;
  }
  let resolved = null;
  let source = '∅';
  const time = doc.querySelector('time[datetime]');
  if (time) {
    const value = time.getAttribute('datetime');
    if (value && value.trim()) {
      resolved = value.trim();
      source = 'time[datetime]';
    }
  }

  if (!resolved) {
    const metaSelectors = [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[name="timestamp"]'
    ];
    for (const selector of metaSelectors) {
      const node = doc.querySelector(selector);
      if (!node) continue;
      const value = node.getAttribute('content') || node.getAttribute('value');
      if (value && value.trim()) {
        resolved = value.trim();
        source = selector;
        break;
      }
    }
  }

  const elapsed = Date.now() - start;
  Zotero.debug(`[dom][getDOMDate] done value="${(resolved || '∅').replace(/"/g, '\\"')}" source=${source} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return resolved;
}


  ///////////////////
 // API Functions //
///////////////////

async function getAPIMetadata(doc, urls, ids) {
  const start = Date.now();
  const cid = ids && ids.conversationID ? ids.conversationID : (ids && ids.apiMetadata && ids.apiMetadata.cid) || '∅';
  const logDone = (metadata, source) => {
    const elapsed = Date.now() - start;
    const titleValue = metadata && metadata.title ? metadata.title : '∅';
    Zotero.debug(`[api][getAPIMetadata] done cid=${(metadata && metadata.cid) || cid || '∅'} source=${source} title="${String(titleValue).replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
    return metadata || null;
  };
  if (ids && ids.apiMetadata) {
    try {
      Zotero.debug(`[flow:new] getAPIMetadata cache ${JSON.stringify(ids.apiMetadata)}`, LOG_LEVEL_DEBUG);
    } catch (_) {}
    return logDone(ids.apiMetadata, 'cache');
  }

  if (typeof getAPIConversationsList !== 'function') {
    Zotero.debug('[getAPIMetadata] API conversations list helper not implemented; skipping API lookup', LOG_LEVEL_DEBUG);
    return logDone(null, 'missing-helper');
  }

  let summary = null;
  try {
    summary = await getAPIConversationsList(doc, urls, ids);
  }
  catch (err) {
    Zotero.debug(`[getAPIMetadata] getAPIConversationsList error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
    return logDone(null, 'list-error');
  }

  if (!summary) {
    Zotero.debug('[flow:new] getAPIMetadata summary null', LOG_LEVEL_DEBUG);
    return logDone(null, 'empty');
  }

  try {
    Zotero.debug(`[flow:new] getAPIMetadata summary ${JSON.stringify(summary)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}

  const metadata = {
    cid: summary.cid || null,
    title: summary.title || null,
    isoDate: summary.isoDate || null,
    aiName: summary.aiName || null,
    humanAuthor: summary.humanAuthor || null,
    aiModel: summary.aiModel || null
  };

  if (ids) {
    ids.apiMetadata = metadata;
  }

  try {
    Zotero.debug(`[flow:new] getAPIMetadata normalized ${JSON.stringify(metadata)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  return logDone(metadata, 'list');
}

async function getAPIAuth(doc, urls, ids) {
  const start = Date.now();
  const path = '/api/auth/session';
  const cid = ids && ids.conversationID ? ids.conversationID : '∅';
  const finish = (result, source, status, errorMsg) => {
    const elapsed = Date.now() - start;
    const tokenSet = result && result.token ? 'true' : 'false';
    const userName = result && result.userName ? result.userName : '∅';
    Zotero.debug(`[api][getAPIAuth] done source=${source} token=${tokenSet} user="${String(userName).replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
    if (errorMsg) {
      Zotero.debug(`[chatgpt:error][getAPIAuth] fail cid=${cid || '∅'} path="${path}" status=${status != null ? status : '∅'} ms=${elapsed} msg="${errorMsg}"`, LOG_LEVEL_ERROR);
    }
    return result;
  };

  if (!doc) {
    return finish({ token: null, userName: null }, 'no-doc', null, 'no document context');
  }

  if (CHATGPT_API_AUTH_CACHE.has(doc)) {
    const cached = CHATGPT_API_AUTH_CACHE.get(doc);
    return finish(cached, 'cache', null, null);
  }

  const response = await callAPI(doc, {
    url: path,
    headers: { 'Accept': 'application/json' },
    responseType: 'json',
    expectJSON: true,
    label: '[chatgpt] /api/auth/session'
  });

  if (!response) {
    return finish({ token: null, userName: null }, 'network', null, 'no response');
  }

  if (!response.ok) {
    return finish({ token: null, userName: null }, 'network', response.status, 'http error');
  }

  let data = null;
  if (response && response.data && typeof response.data === 'object') {
    data = response.data;
  }
  else if (response && typeof response.data === 'string') {
    data = safeJSONParseWithLabel(response.data, '[chatgpt] /api/auth/session body') || null;
  }
  else if (response && typeof response.raw === 'string') {
    data = safeJSONParseWithLabel(response.raw, '[chatgpt] /api/auth/session raw') || null;
  }

  let token = null;
  let userName = null;
  if (data && typeof data === 'object') {
    token = data.accessToken || data.access_token
      || (data.user && (data.user.accessToken || data.user.access_token)) || null;
    if (data.user && typeof data.user.name === 'string') {
      userName = data.user.name.trim() || null;
    }
  }

  const result = { token: token || null, userName: userName || null };
  CHATGPT_API_AUTH_CACHE.set(doc, result);
  try {
    Zotero.debug(`[flow:new] getAPIAuth result token=${result.token ? 'yes' : 'no'} user=${result.userName || '∅'}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  const status = response && typeof response.status === 'number' ? response.status : null;
  const errorMsg = result.token ? null : 'missing token';
  return finish(result, 'network', status, errorMsg);
}

async function getAPIConversation(doc, urls, ids, options = {}) {
  const start = Date.now();
  const conversationID = options && options.conversationId
    ? options.conversationId
    : (ids && ids.conversationID) || null;
  const path = conversationID ? `/backend-api/conversation/${conversationID}` : '/backend-api/conversation/∅';
  const finish = (summary, source, status, errorMsg) => {
    const elapsed = Date.now() - start;
    const shareFlag = urls && urls.public ? 'true' : 'false';
    const titleValue = summary && summary.title ? summary.title : '∅';
    const isoValue = summary && summary.isoDate ? summary.isoDate : '∅';
    const modelValue = summary && summary.aiModel ? summary.aiModel : '∅';
    Zotero.debug(`[api][getAPIConversation] done cid=${conversationID || '∅'} source=${source} status=${status != null ? status : '∅'} title="${String(titleValue).replace(/"/g, '\\"')}" iso="${String(isoValue).replace(/"/g, '\\"')}" share=${shareFlag} model="${String(modelValue).replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
    if (errorMsg) {
      Zotero.debug(`[chatgpt:error][getAPIConversation] fail cid=${conversationID || '∅'} path="${path}" status=${status != null ? status : '∅'} ms=${elapsed} msg="${errorMsg}"`, LOG_LEVEL_ERROR);
    }
    return summary;
  };
  if (!conversationID) {
    return finish(null, 'no-id', null, null);
  }

  let cache = CHATGPT_API_METADATA_CACHE.get(doc);
  if (!cache) {
    cache = new Map();
    CHATGPT_API_METADATA_CACHE.set(doc, cache);
  }
  if (cache.has(conversationID)) {
    return finish(cache.get(conversationID), 'cache', null, null);
  }

  const defaultShareHost = (() => {
    const host = doc && doc.location && String(doc.location.host || '').toLowerCase();
    if (host && host.includes('chat.openai.com')) {
      return 'https://chat.openai.com';
    }
    return 'https://chatgpt.com';
  })();

  const normalizeShare = (candidate, keyHint) => {
    if (!candidate || typeof candidate !== 'string') return null;
    let cleaned = candidate.trim();
    if (!cleaned) return null;
    if (cleaned.includes('\\u002F')) {
      cleaned = cleaned.replace(/\\u002F/gi, '/');
    }
    const direct = cleaned.match(SHARE_URL_REGEX);
    if (direct) {
      const hostMatch = cleaned.match(/https?:\/\/(chatgpt\.com|chat\.openai\.com)/i);
      const host = hostMatch ? `https://${hostMatch[1].toLowerCase()}` : defaultShareHost;
      return `${host}/share/${direct[1].toLowerCase()}`;
    }
    const pathMatch = cleaned.match(SHARE_PATH_REGEX);
    if (pathMatch) {
      return `${defaultShareHost}/share/${pathMatch[1].toLowerCase()}`;
    }
    if (keyHint && /share/i.test(keyHint)) {
      const idMatch = cleaned.match(SHARE_ID_REGEX);
      if (idMatch) {
        return `${defaultShareHost}/share/${idMatch[0].toLowerCase()}`;
      }
    }
    return null;
  };

  const findShareInValue = (value, keyHint, seen = new Set()) => {
    if (typeof value === 'string') {
      return normalizeShare(value, keyHint);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findShareInValue(entry, keyHint, seen);
        if (found) {
          return found;
        }
      }
      return null;
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) {
        return null;
      }
      seen.add(value);
      for (const [key, entry] of Object.entries(value)) {
        const found = findShareInValue(entry, key, seen);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };

  const parseMaybeTimeToMs = (value) => {
    if (value == null) return null;
    if (typeof value === 'number') {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const direct = Number(trimmed);
      if (!Number.isNaN(direct)) {
        return direct < 1e12 ? direct * 1000 : direct;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return null;
  };

  const formatLocalOffset = (ms) => {
    const date = new Date(ms);
    const yyyy = date.getFullYear();
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const tzMinutes = -date.getTimezoneOffset();
    const sign = tzMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(tzMinutes);
    const tzH = String(Math.floor(abs / 60)).padStart(2, '0');
    const tzM = String(abs % 60).padStart(2, '0');
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${sign}${tzH}:${tzM}`;
  };

  const pickIsoDate = (conversation) => {
    if (!conversation || typeof conversation !== 'object') {
      return null;
    }
    const times = [];
    const push = (value) => {
      const ms = parseMaybeTimeToMs(value);
      if (ms != null && Number.isFinite(ms)) {
        times.push(ms);
      }
    };
    push(conversation.update_time);
    push(conversation.create_time);
    if (conversation.mapping && typeof conversation.mapping === 'object') {
      for (const key of Object.keys(conversation.mapping)) {
        const node = conversation.mapping[key];
        const message = node && node.message;
        if (!message) continue;
        push(message.update_time);
        push(message.create_time);
        if (message.metadata && typeof message.metadata === 'object') {
          push(message.metadata.timestamp);
        }
      }
    }
    if (!times.length) {
      return null;
    }
    times.sort((a, b) => b - a);
    return formatLocalOffset(times[0]);
  };

  const extractModel = (conversation) => {
    if (!conversation || typeof conversation !== 'object') {
      return null;
    }
    if (typeof conversation.default_model_slug === 'string' && conversation.default_model_slug.trim()) {
      return conversation.default_model_slug.trim();
    }
    if (conversation.mapping && typeof conversation.mapping === 'object') {
      for (const node of Object.values(conversation.mapping)) {
        const message = node && node.message;
        if (!message || typeof message !== 'object') continue;
        const metadata = message.metadata;
        if (!metadata || typeof metadata !== 'object') continue;
        if (typeof metadata.model_slug === 'string' && metadata.model_slug.trim()) {
          return metadata.model_slug.trim();
        }
        if (typeof metadata.model === 'string' && metadata.model.trim()) {
          return metadata.model.trim();
        }
        if (metadata.author && typeof metadata.author === 'object' && typeof metadata.author.role === 'string') {
          // ignore
        }
      }
    }
    return null;
  };

  const auth = options && options.auth ? options.auth : await getAPIAuth(doc, urls, ids);
  const baselineTitle = normalizeTitle(getDOMTitle(doc, urls, ids)) || TRANSLATOR_DEFAULTS.title;
  const baselineDate = normalizeDate(getDOMDate(doc, urls, ids));
  const privateURL = urls && urls.private ? urls.private : null;

  const summary = {
    cid: conversationID,
    title: baselineTitle,
    isoDate: baselineDate || null,
    aiName: TRANSLATOR_DEFAULTS.aiName,
    humanAuthor: auth && auth.userName ? auth.userName : null,
    aiModel: null
  };
  try {
    Zotero.debug(`[flow:new] getAPIConversation baseline ${JSON.stringify(summary)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}

  if (!auth || !auth.token) {
    cache.set(conversationID, summary);
    Zotero.debug('[flow:new] getAPIConversation skipping API fetch (no token)', LOG_LEVEL_DEBUG);
    return finish(summary, 'no-token', null, null);
  }

  const response = await callAPI(doc, {
    url: `/backend-api/conversation/${conversationID}`,
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Accept': 'application/json'
    },
    responseType: 'json',
    expectJSON: true,
    label: `[chatgpt] /backend-api/conversation/${conversationID}`
  });

  if (!response) {
    cache.set(conversationID, summary);
    return finish(summary, 'network', null, 'no response');
  }

  if (!response.ok) {
    cache.set(conversationID, summary);
    return finish(summary, 'network', response.status, 'http error');
  }

  if (!response.data || typeof response.data !== 'object') {
    cache.set(conversationID, summary);
    return finish(summary, 'network', response.status, 'empty payload');
  }

  const conversation = response.data;
  if (typeof conversation.title === 'string') {
    const apiTitle = normalizeTitle(conversation.title);
    if (apiTitle) {
      summary.title = apiTitle;
    }
  }

  const isoFromAPI = pickIsoDate(conversation);
  if (isoFromAPI) {
    summary.isoDate = isoFromAPI;
  }

  const model = extractModel(conversation);
  if (model) {
    summary.aiModel = model;
  }

  const shareURL = findShareInValue(conversation, '', new Set());
  if (shareURL && urls) {
    Zotero.debug(`[flow:new] getAPIConversation shareURL ${shareURL}`, LOG_LEVEL_DEBUG);
    if (!urls.public) {
      urls.public = shareURL;
    }
    if (!urls.item || urls.item === privateURL || (urls.page && urls.item === urls.page)) {
      urls.item = shareURL;
    }
    if (!urls.snapshot || urls.snapshot === privateURL || (urls.page && urls.snapshot === urls.page)) {
      urls.snapshot = shareURL;
    }
  }

  cache.set(conversationID, summary);
  try {
    Zotero.debug(`[flow:new] getAPIConversation summary ${JSON.stringify(summary)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  const status = response && typeof response.status === 'number' ? response.status : null;
  return finish(summary, 'network', status, null);
}

async function getAPIConversationsList(doc, urls, ids, options = {}) {
  const start = Date.now();
  const conversationID = ids && ids.conversationID;
  const listPath = '/backend-api/shared_conversations?order=created';
  let listStatus = null;
  let listFound = 0;
  let listMatched = false;
  const finish = (summary, source, errorMsg, errorPath, errorStatus) => {
    const elapsed = Date.now() - start;
    Zotero.debug(`[api][getAPIConversationsList] done cid=${conversationID || '∅'} source=${source} status=${listStatus != null ? listStatus : '∅'} found=${listFound} matched=${listMatched ? 'true' : 'false'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
    if (errorMsg) {
      const statusValue = errorStatus != null ? errorStatus : (listStatus != null ? listStatus : '∅');
      const errorPathValue = errorPath || listPath;
      Zotero.debug(`[chatgpt:error][getAPIConversationsList] fail cid=${conversationID || '∅'} path="${errorPathValue}" status=${statusValue} ms=${elapsed} msg="${errorMsg}"`, LOG_LEVEL_ERROR);
    }
    return summary;
  };
  if (!conversationID) {
    return finish(null, 'no-id', null, null, null);
  }

  const applyShareHints = (shareURL) => {
    if (!shareURL || !urls) return;
    const privateURL = urls.private || null;
    Zotero.debug(`[flow:new] getAPIConversationsList applyShareHints ${shareURL}`, LOG_LEVEL_DEBUG);
    if (!urls.public) {
      urls.public = shareURL;
    }
    if (!urls.item || urls.item === privateURL || (urls.page && urls.item === urls.page)) {
      urls.item = shareURL;
    }
    if (!urls.snapshot || (!privateURL && (urls.snapshot === urls.page || urls.snapshot === urls.item))) {
      urls.snapshot = shareURL;
    }
  };

  const summary = {
    cid: conversationID,
    title: null,
    isoDate: null,
    aiName: TRANSLATOR_DEFAULTS.aiName,
    humanAuthor: null,
    aiModel: null
  };
  const pageURL = (urls && (urls.page || urls.item || urls.public || urls.private)) || options.pageURL || null;
  try {
    Zotero.debug(`[flow:new] getAPIConversationsList start conversationID=${conversationID} page=${pageURL || '∅'}`, LOG_LEVEL_DEBUG);
  } catch (_) {}

  const isShareLike = (value) => typeof value === 'string' && /\/share(?:\/|$)/i.test(value);
  const pageIsShare = isShareLike(pageURL) || (urls && urls.public && isShareLike(urls.public) && (!urls.private || urls.private !== urls.public));

  if (pageIsShare) {
    const shareMeta = await getAPIShare(doc, urls, ids, { shareId: conversationID, mode: 'public' });
    if (shareMeta) {
      if (shareMeta.title) {
        const normalized = normalizeTitle(shareMeta.title);
        if (normalized) {
          summary.title = normalized;
        }
      }
      if (shareMeta.isoDate) {
        const normalizedDate = normalizeDate(shareMeta.isoDate);
        if (normalizedDate) {
          summary.isoDate = normalizedDate;
        }
      }
      if (shareMeta.shareURL) {
        applyShareHints(shareMeta.shareURL);
      }
      if (shareMeta.status != null) {
        listStatus = shareMeta.status;
      }
    }
    return finish(summary, 'public-share', null, null, null);
  }

  const auth = await getAPIAuth(doc, urls, ids);
  if (auth && auth.userName) {
    summary.humanAuthor = auth.userName;
  }

  const conversationMeta = await getAPIConversation(doc, urls, ids, { conversationId: conversationID, auth });
  if (conversationMeta) {
    if (conversationMeta.title) {
      summary.title = conversationMeta.title;
    }
    if (conversationMeta.isoDate) {
      summary.isoDate = conversationMeta.isoDate;
    }
    if (conversationMeta.humanAuthor) {
      summary.humanAuthor = conversationMeta.humanAuthor;
    }
    if (conversationMeta.aiModel) {
      summary.aiModel = conversationMeta.aiModel;
    }
    if (conversationMeta.aiName) {
      summary.aiName = conversationMeta.aiName;
    }
  }

  let skipShareList = false;
  if (!urls || !urls.public) {
    const shareProbe = await getAPIShare(doc, urls, ids, { conversationId: conversationID, auth, mode: 'probe' });
    if (shareProbe) {
      try { Zotero.debug(`[flow:new] getAPIConversationsList shareProbe ${JSON.stringify(shareProbe)}`, LOG_LEVEL_DEBUG); } catch (_) {}
      if (shareProbe.shareURL) {
        applyShareHints(shareProbe.shareURL);
      }
      if (shareProbe.confirmedNone) {
        skipShareList = true;
      }
      if (shareProbe.status != null) {
        listStatus = shareProbe.status;
      }
      listFound = shareProbe.shareURL ? 1 : 0;
      listMatched = !!shareProbe.shareURL;
    }
  }

  if (!skipShareList && (!urls || !urls.public)) {
    const shareListEntry = await getAPIShareList(doc, urls, ids, { conversationId: conversationID, auth });
    if (shareListEntry && shareListEntry.shareURL) {
      applyShareHints(shareListEntry.shareURL);
      if (!summary.isoDate && shareListEntry.isoDate) {
        const normalizedDate = normalizeDate(shareListEntry.isoDate);
        if (normalizedDate) {
          summary.isoDate = normalizedDate;
        }
      }
      if (typeof shareListEntry.matched === 'boolean') {
        listMatched = shareListEntry.matched;
      }
      if (typeof shareListEntry.found === 'number') {
        listFound = shareListEntry.found;
      }
      if (shareListEntry.status != null) {
        listStatus = shareListEntry.status;
      }
    }
    else if (shareListEntry) {
      if (typeof shareListEntry.found === 'number') {
        listFound = shareListEntry.found;
      }
      if (shareListEntry.status != null) {
        listStatus = shareListEntry.status;
      }
      if (typeof shareListEntry.matched === 'boolean') {
        listMatched = shareListEntry.matched;
      }
    }
  }
  try {
    Zotero.debug(`[flow:new] getAPIConversationsList summary ${JSON.stringify(summary)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  return finish(summary, 'complete', null, null, null);
}

async function getAPIShare(doc, urls, ids, options = {}) {
  const start = Date.now();
  const mode = options && options.mode ? options.mode : 'probe';
  const conversationID = options && options.conversationId ? options.conversationId : (ids && ids.conversationID);
  const shareIdOption = options && options.shareId ? String(options.shareId).toLowerCase() : null;
  const path = mode === 'public' && shareIdOption
    ? `/backend-api/public/conversation/${shareIdOption}`
    : (conversationID ? `/backend-api/conversation/${conversationID}/share` : '/backend-api/conversation/∅/share');
  const finish = (result, status, errorMsg) => {
    const elapsed = Date.now() - start;
    const shareFlag = result && result.shareURL ? 'true' : 'false';
    Zotero.debug(`[api][getAPIShare] done mode=${mode} status=${status != null ? status : '∅'} share=${shareFlag} ms=${elapsed}`, LOG_LEVEL_DEBUG);
    if (errorMsg) {
      Zotero.debug(`[chatgpt:error][getAPIShare] fail cid=${conversationID || '∅'} path="${path}" status=${status != null ? status : '∅'} ms=${elapsed} msg="${errorMsg}"`, LOG_LEVEL_ERROR);
    }
    if (result && status != null && result.status == null) {
      result.status = status;
    }
    return result || null;
  };

  const defaultShareHost = (() => {
    const host = doc && doc.location && String(doc.location.host || '').toLowerCase();
    if (host && host.includes('chat.openai.com')) {
      return 'https://chat.openai.com';
    }
    return 'https://chatgpt.com';
  })();
  try {
    const debugOptions = {
      mode: options && options.mode ? options.mode : null,
      shareId: options && options.shareId ? options.shareId : null,
      conversationId: options && options.conversationId ? options.conversationId : (ids && ids.conversationID) || null
    };
    Zotero.debug(`[flow:new] getAPIShare options ${JSON.stringify(debugOptions)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}

  const normalizeShare = (candidate, keyHint) => {
    if (!candidate || typeof candidate !== 'string') return null;
    let cleaned = candidate.trim();
    if (!cleaned) return null;
    if (cleaned.includes('\\u002F')) {
      cleaned = cleaned.replace(/\\u002F/gi, '/');
    }
    const direct = cleaned.match(SHARE_URL_REGEX);
    if (direct) {
      const hostMatch = cleaned.match(/https?:\/\/(chatgpt\.com|chat\.openai\.com)/i);
      const host = hostMatch ? `https://${hostMatch[1].toLowerCase()}` : defaultShareHost;
      return `${host}/share/${direct[1].toLowerCase()}`;
    }
    const pathMatch = cleaned.match(SHARE_PATH_REGEX);
    if (pathMatch) {
      return `${defaultShareHost}/share/${pathMatch[1].toLowerCase()}`;
    }
    if (keyHint && /share/i.test(keyHint)) {
      const idMatch = cleaned.match(SHARE_ID_REGEX);
      if (idMatch) {
        return `${defaultShareHost}/share/${idMatch[0].toLowerCase()}`;
      }
    }
    return null;
  };

  const findShareInValue = (value, keyHint, seen = new Set()) => {
    if (typeof value === 'string') {
      return normalizeShare(value, keyHint);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findShareInValue(entry, keyHint, seen);
        if (found) {
          return found;
        }
      }
      return null;
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) {
        return null;
      }
      seen.add(value);
      for (const [key, entry] of Object.entries(value)) {
        const found = findShareInValue(entry, key, seen);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };

  const parseMaybeTimeToMs = (value) => {
    if (value == null) return null;
    if (typeof value === 'number') {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const direct = Number(trimmed);
      if (!Number.isNaN(direct)) {
        return direct < 1e12 ? direct * 1000 : direct;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return null;
  };

  const formatLocalOffset = (ms) => {
    const date = new Date(ms);
    const yyyy = date.getFullYear();
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const tzMinutes = -date.getTimezoneOffset();
    const sign = tzMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(tzMinutes);
    const tzH = String(Math.floor(abs / 60)).padStart(2, '0');
    const tzM = String(abs % 60).padStart(2, '0');
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${sign}${tzH}:${tzM}`;
  };

  const pickIsoDateFromShare = (value) => {
    const times = [];
    const push = (candidate) => {
      const ms = parseMaybeTimeToMs(candidate);
      if (ms != null && Number.isFinite(ms)) {
        times.push(ms);
      }
    };
    if (value && typeof value === 'object') {
      push(value.update_time);
      push(value.create_time);
      if (Array.isArray(value.messages)) {
        for (const entry of value.messages) {
          if (entry && typeof entry === 'object') {
            push(entry.update_time);
            push(entry.create_time);
          }
        }
      }
    }
    if (!times.length) return null;
    times.sort((a, b) => b - a);
    return formatLocalOffset(times[0]);
  };

  if (mode === 'public' && shareIdOption) {
    const response = await callAPI(doc, {
      url: `/backend-api/public/conversation/${shareIdOption}`,
      headers: { 'Accept': 'application/json' },
      responseType: 'json',
      expectJSON: true,
      label: `[chatgpt] /backend-api/public/conversation/${shareIdOption}`
    });
    if (!response) {
      return finish(null, null, 'no response');
    }
    if (!response.ok) {
      return finish(null, response.status, 'http error');
    }
    const data = response.data && typeof response.data === 'object' ? response.data : null;
    const title = data && typeof data.title === 'string' ? data.title : null;
    const isoDate = data ? (pickIsoDateFromShare(data) || null) : null;
    const shareURL = `${defaultShareHost}/share/${shareIdOption}`;
    try {
      Zotero.debug(`[flow:new] getAPIShare public result ${JSON.stringify({ shareURL, isoDate, title })}`, LOG_LEVEL_DEBUG);
    } catch (_) {}
    return finish({ title, isoDate, shareURL }, response.status, null);
  }

  const auth = options && options.auth;
  if (!conversationID || !auth || !auth.token) {
    return finish(null, null, null);
  }

  const response = await callAPI(doc, {
    url: `/backend-api/conversation/${conversationID}/share`,
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Accept': 'application/json'
    },
    responseType: 'json',
    expectJSON: true,
    timeout: typeof options.timeout === 'number' ? options.timeout : SHARE_PROBE_TIMEOUT_MS,
    label: `[chatgpt] /backend-api/conversation/${conversationID}/share`
  });

  if (!response) {
    return finish(null, null, 'no response');
  }

  if (!response.ok && response.status !== 404) {
    return finish(null, response.status, 'http error');
  }

  if (response.status === 404) {
    Zotero.debug('[flow:new] getAPIShare probe confirmed none', LOG_LEVEL_DEBUG);
    return finish({ confirmedNone: true }, response.status, null);
  }

  if (!response.ok) {
    return finish(null, response.status, 'http error');
  }

  const data = response.data;
  const shareURL = findShareInValue(data, '', new Set())
    || (data && typeof data === 'object' && data.share_id ? `${defaultShareHost}/share/${String(data.share_id).toLowerCase()}` : null);
  let isoDate = null;
  if (data && typeof data === 'object') {
    const ms = parseMaybeTimeToMs(data.update_time || data.create_time);
    if (ms != null) {
      isoDate = formatLocalOffset(ms);
    }
  }
  try {
    Zotero.debug(`[flow:new] getAPIShare result ${JSON.stringify({ shareURL, isoDate })}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  return finish({ shareURL, isoDate }, response.status, null);
}

async function getAPIShareList(doc, urls, ids, options = {}) {
  const start = Date.now();
  const conversationID = options && options.conversationId
    ? options.conversationId
    : (ids && ids.conversationID);
  const auth = options && options.auth;
  const path = '/backend-api/shared_conversations?order=created';
  const finish = (result, source, status, found, matched, errorMsg) => {
    const elapsed = Date.now() - start;
    Zotero.debug(`[api][getAPIShareList] done cid=${conversationID || '∅'} source=${source} status=${status != null ? status : '∅'} found=${found != null ? found : 0} matched=${matched ? 'true' : 'false'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
    if (errorMsg) {
      Zotero.debug(`[chatgpt:error][getAPIShareList] fail cid=${conversationID || '∅'} path="${path}" status=${status != null ? status : '∅'} ms=${elapsed} msg="${errorMsg}"`, LOG_LEVEL_ERROR);
    }
    if (result && result.status == null && status != null) {
      result.status = status;
    }
    if (result && result.found == null && found != null) {
      result.found = found;
    }
    if (result && result.matched == null && matched != null) {
      result.matched = matched;
    }
    return result || null;
  };
  if (!conversationID || !auth || !auth.token) {
    return finish(null, 'no-auth', null, 0, false, null);
  }

  let cache = CHATGPT_SHARE_LIST_CACHE.get(doc);
  if (!cache) {
    cache = new Map();
    CHATGPT_SHARE_LIST_CACHE.set(doc, cache);
  }
  if (cache.has(conversationID)) {
    try {
      Zotero.debug(`[flow:new] getAPIShareList cache hit ${JSON.stringify(cache.get(conversationID))}`, LOG_LEVEL_DEBUG);
    } catch (_) {}
    const cached = cache.get(conversationID);
    return finish(cached, 'cache', cached && cached.status != null ? cached.status : null, cached && cached.found != null ? cached.found : 0, cached && cached.matched === true, null);
  }

  const defaultShareHost = (() => {
    const host = doc && doc.location && String(doc.location.host || '').toLowerCase();
    if (host && host.includes('chat.openai.com')) {
      return 'https://chat.openai.com';
    }
    return 'https://chatgpt.com';
  })();
  try {
    Zotero.debug(`[flow:new] getAPIShareList request conversationID=${conversationID}`, LOG_LEVEL_DEBUG);
  } catch (_) {}

  const parseMaybeTimeToMs = (value) => {
    if (value == null) return null;
    if (typeof value === 'number') {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const direct = Number(trimmed);
      if (!Number.isNaN(direct)) {
        return direct < 1e12 ? direct * 1000 : direct;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return null;
  };

  const formatLocalOffset = (ms) => {
    const date = new Date(ms);
    const yyyy = date.getFullYear();
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const tzMinutes = -date.getTimezoneOffset();
    const sign = tzMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(tzMinutes);
    const tzH = String(Math.floor(abs / 60)).padStart(2, '0');
    const tzM = String(abs % 60).padStart(2, '0');
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${sign}${tzH}:${tzM}`;
  };

  const response = await callAPI(doc, {
    url: '/backend-api/shared_conversations?order=created',
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'Accept': 'application/json'
    },
    responseType: 'json',
    expectJSON: true,
    timeout: SHARE_LIST_TIMEOUT_MS,
    label: '[chatgpt] /backend-api/shared_conversations'
  });

  if (!response) {
    cache.set(conversationID, null);
    return finish(null, 'network', null, 0, false, 'no response');
  }

  if (!response.ok) {
    cache.set(conversationID, null);
    return finish(null, 'network', response.status, 0, false, 'http error');
  }

  if (!response.data || typeof response.data !== 'object' || !Array.isArray(response.data.items)) {
    cache.set(conversationID, null);
    return finish(null, 'network', response.status, 0, false, 'malformed payload');
  }

  const matches = response.data.items.filter(entry => entry && (entry.conversation_id === conversationID));
  Zotero.debug(`[flow:new] getAPIShareList matches=${matches.length}`, LOG_LEVEL_DEBUG);
  let matched = false;
  let found = matches.length;
  if (!matches.length) {
    cache.set(conversationID, null);
    return finish(null, 'network', response.status, found, false, null);
  }

  matches.sort((a, b) => {
    const aTime = parseMaybeTimeToMs(a.update_time || a.create_time) || 0;
    const bTime = parseMaybeTimeToMs(b.update_time || b.create_time) || 0;
    return bTime - aTime;
  });

  const best = matches[0];
  const shareId = best.id || best.share_id;
  if (!shareId) {
    cache.set(conversationID, null);
    return finish(null, 'network', response.status, found, false, 'missing share id');
  }
  matched = true;

  const ms = parseMaybeTimeToMs(best.update_time || best.create_time);
  const shareURL = `${defaultShareHost}/share/${String(shareId).toLowerCase()}`;
  const result = {
    shareURL,
    isoDate: ms != null ? formatLocalOffset(ms) : null,
    status: response.status,
    found,
    matched
  };
  cache.set(conversationID, result);
  try {
    Zotero.debug(`[flow:new] getAPIShareList result ${JSON.stringify(result)}`, LOG_LEVEL_DEBUG);
  } catch (_) {}
  return finish(result, 'network', response.status, found, matched, null);
}


  /////////////////////////////
 // Normalization Functions //
/////////////////////////////

function normalizeConversationID(value) {
  const start = Date.now();
  let result = null;
  if (typeof value === 'string') {
    const trimmed = typeof ZU !== 'undefined' && typeof ZU.trimInternal === 'function'
      ? ZU.trimInternal(value)
      : value.trim();
    result = trimmed ? trimmed.toLowerCase() : null;
  }
  const elapsed = Date.now() - start;
  Zotero.debug(`[norm][normalizeConversationID] done value=${result || '∅'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

function normalizeTitle(value) {
  const start = Date.now();
  let result = null;
  if (value) {
    const trimAndStrip = (input) => {
      const trimmed = ZU.trimInternal(input);
      if (!trimmed) return null;
      const stripped = trimmed.replace(/\s+\|\s*(ChatGPT|OpenAI)$/i, '').trim();
      return stripped || trimmed;
    };
    if (typeof value === 'string') {
      result = trimAndStrip(value);
    }
    else if (typeof value === 'object') {
      if (typeof value.title === 'string') {
        result = trimAndStrip(value.title);
      }
      else if (typeof value.data === 'string') {
        result = trimAndStrip(value.data);
      }
      else if (value.data && typeof value.data.title === 'string') {
        result = trimAndStrip(value.data.title);
      }
    }
  }
  if (result) {
    const trim = (str) => {
      if (typeof ZU !== 'undefined' && typeof ZU.trimInternal === 'function') {
        return ZU.trimInternal(str);
      }
      return String(str).trim();
    };
    const trimmedResult = trim(result);
    const lowered = trimmedResult ? trimmedResult.toLowerCase() : '';
    const defaultsTitle = TRANSLATOR_DEFAULTS && typeof TRANSLATOR_DEFAULTS.title === 'string'
      ? trim(TRANSLATOR_DEFAULTS.title).toLowerCase()
      : null;
    if (!lowered
      || (defaultsTitle && lowered === defaultsTitle)
      || lowered === 'chatgpt'
      || lowered === 'chatgpt conversation') {
      result = null;
    }
    else {
      result = trimmedResult;
    }
  }
  const elapsed = Date.now() - start;
  Zotero.debug(`[norm][normalizeTitle] done value="${(result || '∅').replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

function normalizeAIName(value) {
  const start = Date.now();
  let result = null;
  if (value && typeof value === 'object' && value.data !== undefined) {
    result = normalizeAIName(value.data);
  }
  else if (value) {
    if (Array.isArray(value) && value.length) {
      result = normalizeAIName(value[0]);
    }
    else if (typeof value === 'string') {
      const trimmed = ZU.trimInternal(value);
      result = trimmed ? ZU.cleanAuthor(trimmed, 'programmer') : null;
    }
    else if (typeof value === 'object') {
      if (value.lastName || value.firstName) {
        result = Object.assign({ creatorType: 'programmer' }, value);
      }
      else if (typeof value.aiName === 'string') {
        const trimmed = ZU.trimInternal(value.aiName);
        result = trimmed ? ZU.cleanAuthor(trimmed, 'programmer') : null;
      }
      else if (typeof value.fullName === 'string') {
        const trimmed = ZU.trimInternal(value.fullName);
        result = trimmed ? ZU.cleanAuthor(trimmed, 'programmer') : null;
      }
      else if (typeof value.displayName === 'string') {
        const trimmed = ZU.trimInternal(value.displayName);
        result = trimmed ? ZU.cleanAuthor(trimmed, 'programmer') : null;
      }
      else if (typeof value.name === 'string') {
        const trimmed = ZU.trimInternal(value.name);
        result = trimmed ? ZU.cleanAuthor(trimmed, 'programmer') : null;
      }
    }
  }
  const elapsed = Date.now() - start;
  const label = result && (result.lastName || result.fullName || result.name) ? (result.lastName || result.fullName || result.name) : '∅';
  Zotero.debug(`[norm][normalizeAIName] done has=${result ? 'true' : 'false'} value="${String(label).replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

function normalizeHumanAuthor(value) {
  const start = Date.now();
  let result = null;
  const rejectIfChatGPT = (str) => {
    const trimmed = ZU.trimInternal(str);
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower === 'chatgpt' || lower === 'openai') {
      return null;
    }
    return trimmed;
  };
  if (value && typeof value === 'object' && value.data !== undefined) {
    result = normalizeHumanAuthor(value.data);
  }
  else if (value) {
    if (Array.isArray(value) && value.length) {
      result = normalizeHumanAuthor(value[0]);
    }
    else if (typeof value === 'string') {
      const trimmed = rejectIfChatGPT(value);
      result = trimmed ? ZU.cleanAuthor(trimmed, 'author') : null;
    }
    else if (typeof value === 'object') {
      if (value.lastName || value.firstName) {
        result = Object.assign({ creatorType: 'author' }, value);
      }
      else if (typeof value.userName === 'string') {
        const trimmed = rejectIfChatGPT(value.userName);
        result = trimmed ? ZU.cleanAuthor(trimmed, 'author') : null;
      }
      else if (typeof value.fullName === 'string') {
        const trimmed = rejectIfChatGPT(value.fullName);
        result = trimmed ? ZU.cleanAuthor(trimmed, 'author') : null;
      }
      else if (typeof value.displayName === 'string') {
        const trimmed = rejectIfChatGPT(value.displayName);
        result = trimmed ? ZU.cleanAuthor(trimmed, 'author') : null;
      }
      else if (typeof value.name === 'string') {
        const trimmed = rejectIfChatGPT(value.name);
        result = trimmed ? ZU.cleanAuthor(trimmed, 'author') : null;
      }
    }
  }
  const elapsed = Date.now() - start;
  const label = result && (result.lastName || result.fullName || result.name) ? (result.lastName || result.fullName || result.name) : '∅';
  Zotero.debug(`[norm][normalizeHumanAuthor] done has=${result ? 'true' : 'false'} value="${String(label).replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

function normalizeSingleFieldCreator(value, fallbackName, creatorType = 'author') {
  const start = Date.now();
  const extract = (input) => {
    if (!input) return null;
    if (typeof input === 'string') {
      return input;
    }
    if (Array.isArray(input) && input.length) {
      return extract(input[0]);
    }
    if (typeof input === 'object') {
      if (input.fieldMode === 1 && typeof input.lastName === 'string') {
        return input.lastName;
      }
      const pieces = [];
      if (typeof input.fullName === 'string') pieces.push(input.fullName);
      if (typeof input.displayName === 'string') pieces.push(input.displayName);
      if (typeof input.name === 'string') pieces.push(input.name);
      if (typeof input.aiName === 'string') pieces.push(input.aiName);
      if (typeof input.firstName === 'string' || typeof input.lastName === 'string') {
        const joined = [input.firstName, input.lastName].filter(Boolean).join(' ').trim();
        if (joined) pieces.push(joined);
      }
      if (pieces.length) {
        return pieces.find(str => typeof str === 'string' && str.trim()) || null;
      }
    }
    return null;
  };

  let name = extract(value);
  if (!name && fallbackName) {
    name = fallbackName;
  }
  if (!name) {
    const elapsedMissing = Date.now() - start;
    Zotero.debug(`[norm][normalizeSingleFieldCreator] done has=false reason=missing-input ms=${elapsedMissing}`, LOG_LEVEL_DEBUG);
    return null;
  }
  const trimmed = typeof ZU !== 'undefined' && typeof ZU.trimInternal === 'function'
    ? ZU.trimInternal(name)
    : String(name).trim();
  if (!trimmed) {
    const elapsedEmpty = Date.now() - start;
    Zotero.debug(`[norm][normalizeSingleFieldCreator] done has=false reason=empty ms=${elapsedEmpty}`, LOG_LEVEL_DEBUG);
    return null;
  }
  const result = {
    lastName: trimmed,
    fieldMode: 1,
    creatorType
  };
  const elapsed = Date.now() - start;
  Zotero.debug(`[norm][normalizeSingleFieldCreator] done has=true value="${trimmed.replace(/"/g, '\\"')}" type=${creatorType} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

function normalizeAIModel(value) {
  const start = Date.now();
  let result = null;
  if (value && typeof value === 'object' && value.data !== undefined) {
    result = normalizeAIModel(value.data);
  }
  else if (value) {
    if (typeof value === 'number') {
      result = String(value);
    }
    else if (Array.isArray(value) && value.length) {
      result = normalizeAIModel(value[0]);
    }
    else if (typeof value === 'string') {
      const trimmed = ZU.trimInternal(value);
      result = trimmed || null;
    }
    else if (typeof value === 'object') {
      const candidates = [
        value.aiModel,
        value.model,
        value.displayName,
        value.name,
        value.label,
        value.version
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'string') {
          const trimmed = ZU.trimInternal(candidate);
          if (trimmed) {
            result = trimmed;
            break;
          }
        }
      }
    }
  }
  const elapsed = Date.now() - start;
  Zotero.debug(`[norm][normalizeAIModel] done value="${(result || '∅').replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

function normalizeDate(value) {
  const start = Date.now();
  let result = null;
  if (value && typeof value === 'object' && value.data !== undefined) {
    result = normalizeDate(value.data);
  }
  else if (value) {
    if (typeof value === 'string') {
      const trimmed = ZU.trimInternal(value);
      if (trimmed) {
        const iso = ZU.strToISO(trimmed);
        result = iso || trimmed;
      }
    }
    else if (typeof value === 'object') {
      if (value.date) {
        result = normalizeDate(value.date);
      }
      else if (value.data && value.data.date) {
        result = normalizeDate(value.data.date);
      }
    }
  }
  const elapsed = Date.now() - start;
  Zotero.debug(`[norm][normalizeDate] done iso="${(result || '∅').replace(/"/g, '\\"')}" ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}



  ///////////////////////////////////////
 // Library of Zotero Helper Functions//
///////////////////////////////////////

function normalizeAPIText(value, contextLabel) {
  const start = Date.now();
  let result = '';
  if (!value && value !== 0) {
    result = '';
  }
  else if (typeof value === 'string') {
    result = value;
  }
  else if (typeof value === 'number' || typeof value === 'boolean') {
    result = String(value);
  }
  else if (value instanceof ArrayBuffer) {
    try {
      result = new TextDecoder('utf-8').decode(value);
    }
    catch (err) {
      Zotero.debug(`${contextLabel || '[decode]'} TextDecoder error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
      result = '';
    }
  }
  else if (value && typeof value === 'object') {
    const toUint8 = (input) => {
      if (!input) return null;
      if (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) {
        return input;
      }
      if (typeof ArrayBuffer !== 'undefined') {
        if (input instanceof ArrayBuffer) {
          return new Uint8Array(input);
        }
        if (ArrayBuffer.isView && ArrayBuffer.isView(input)) {
          try {
            return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength || input.buffer.byteLength);
          }
          catch (_) {
            return new Uint8Array(input.buffer);
          }
        }
      }
      if (typeof input.byteLength === 'number') {
        try {
          return new Uint8Array(input);
        }
        catch (_) {}
      }
      if (input.buffer && typeof input.buffer.byteLength === 'number') {
        try {
          return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength || input.buffer.byteLength);
        }
        catch (_) {
          return new Uint8Array(input.buffer);
        }
      }
      return null;
    };

    const view = toUint8(value);
    if (view) {
      if (view.length === 0) {
        result = '';
      }
      else if (typeof TextDecoder !== 'undefined') {
        try {
          result = new TextDecoder('utf-8').decode(view);
        }
        catch (err) {
          Zotero.debug(`${contextLabel || '[decode]'} TextDecoder error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
          let fallback = '';
          for (let i = 0; i < view.length; i++) {
            fallback += String.fromCharCode(view[i]);
          }
          result = fallback;
        }
      }
      else {
        let fallback = '';
        for (let i = 0; i < view.length; i++) {
          fallback += String.fromCharCode(view[i]);
        }
        result = fallback;
      }
    }
    else if (typeof value.text === 'string') {
      result = value.text;
    }
    else if (value && value.body && typeof value.body === 'string') {
      result = value.body;
    }
    else if (value && value.body && value.body.data) {
      if (Array.isArray(value.body.data)) {
        result = value.body.data.join('\n');
      }
      else if (value.body.data instanceof ArrayBuffer) {
        result = normalizeAPIText(value.body.data, contextLabel);
      }
    }
    else if (value && value.message && typeof value.message === 'string') {
      result = value.message;
    }
    else if (value && value.error && typeof value.error === 'string') {
      result = value.error;
    }
    else if (value && value.raw) {
      result = normalizeAPIText(value.raw, contextLabel);
    }
    else if (typeof value.toString === 'function') {
      try {
        const str = value.toString();
        result = str != null && str !== '[object Object]' ? str : '';
      }
      catch (_) {
        result = '';
      }
    }
    if (!result || (typeof result === 'string' && !result.trim())) {
      try {
        const jsonString = JSON.stringify(value);
        if (typeof jsonString === 'string'
          && jsonString.length
          && jsonString !== '{}'
          && jsonString !== '[]') {
          result = jsonString;
        }
      }
      catch (err) {
        Zotero.debug(`${contextLabel || '[decode]'} JSON stringify error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
      }
    }
    if (!result) {
      result = '';
    }
  }
  const elapsed = Date.now() - start;
  const length = typeof result === 'string' ? result.length : 0;
  Zotero.debug(`[norm][normalizeAPIText] done label="${contextLabel || '∅'}" length=${length} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

function extractAPIResponseText(apiResponse, label) {
  const start = Date.now();
  let result = '';
  if (!apiResponse) {
    result = '';
  }
  else if (typeof apiResponse.raw === 'string' && apiResponse.raw) {
    result = apiResponse.raw;
  }
  else if (typeof apiResponse.data === 'string' && apiResponse.data) {
    result = apiResponse.data;
  }
  else {
    result = normalizeAPIText(apiResponse.raw || apiResponse.data, label || '[title-api]');
  }
  const elapsed = Date.now() - start;
  const length = typeof result === 'string' ? result.length : 0;
  Zotero.debug(`[api][extractAPIResponseText] done label="${label || '∅'}" length=${length} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return result;
}

function safeJSONParseWithLabel(text, label) {
  const start = Date.now();
  let parsed = null;
  let empty = false;
  let errorMsg = null;
  if (typeof text === 'string') {
    const trimmed = text.trim();
    if (!trimmed) {
      empty = true;
    }
    else {
      try {
        parsed = JSON.parse(trimmed);
      }
      catch (err) {
        errorMsg = err && err.message ? err.message : String(err);
      }
    }
  }
  const elapsed = Date.now() - start;
  if (errorMsg) {
    Zotero.debug(`[chatgpt:error][safeJSONParseWithLabel] fail cid=∅ path="${label || '∅'}" status=∅ ms=${elapsed} msg="${String(errorMsg).replace(/"/g, '\'')}"`, LOG_LEVEL_ERROR);
  }
  Zotero.debug(`[api][safeJSONParseWithLabel] done label="${label || '∅'}" parsed=${parsed ? 'true' : 'false'} empty=${empty ? 'true' : 'false'} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return parsed;
}

async function callAPI(doc, apiOptions = {}) {
  const start = Date.now();
  if (!apiOptions || !apiOptions.url) {
    throw new Error('callAPI requires an options object with a url property');
  }

  const target = apiOptions.url;
  const baseHref = doc && doc.location ? String(doc.location.href) : null;
  let targetURL;
  try {
    targetURL = new URL(target, baseHref || undefined).href;
  }
  catch (_) {
    targetURL = target;
  }

  const opts = Object.assign({ headers: {}, method: 'GET' }, apiOptions);
  if (opts.credentials == null) {
    opts.credentials = 'include';
  }

  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({}, opts.headers || {});
  const allowBody = opts.allowBody !== undefined ? !!opts.allowBody : (method !== 'GET' && method !== 'HEAD');
  const body = allowBody && opts.body !== undefined ? opts.body : null;
  const label = opts.label || `[callAPI] ${method} ${targetURL}`;

  if (opts.timeout == null) {
    opts.timeout = ZOTERO_FETCH_DEFAULT_TIMEOUT_MS;
    Zotero.debug(`${label} using default timeout ${ZOTERO_FETCH_DEFAULT_TIMEOUT_MS}ms`, LOG_LEVEL_DEBUG);
  }

  const wantsJSON = (() => {
    if (opts.responseType === 'json') return true;
    const accept = headers.Accept || headers.accept;
    if (accept && typeof accept === 'string' && accept.toLowerCase().includes('application/json')) {
      return true;
    }
    if (typeof opts.expectJSON === 'boolean') {
      return opts.expectJSON;
    }
    return false;
  })();

  const forceDefaultFallback = !!opts.forceDefaultViewFallback;
  const preferDefaultView = !!opts.preferDefaultView;
  const disableDefaultView = !!opts.disableDefaultViewFallback;

  const normalizeRaw = (value, contextLabel = label) => normalizeAPIText(value, contextLabel);
  const safeJSONParse = (text) => safeJSONParseWithLabel(text, label);

  const cookieSnapshot = (() => {
    try {
      if (doc && typeof doc.cookie === 'string' && doc.cookie.length) {
        return doc.cookie;
      }
    }
    catch (_) {}
    try {
      const win = doc && doc.defaultView;
      if (win && win.document && typeof win.document.cookie === 'string' && win.document.cookie.length) {
        return win.document.cookie;
      }
    }
    catch (_) {}
    return null;
  })();

  applyChatGPTRequestHeaders(doc, targetURL, headers, cookieSnapshot);

  if (ENABLE_VERBOSE_API_LOGGING) {
    let bodyForLog = null;
    if (allowBody && body != null) {
      if (typeof body === 'string') {
        bodyForLog = body;
      }
      else if (body && typeof body === 'object') {
        try {
          bodyForLog = JSON.stringify(body);
        }
        catch (err) {
          bodyForLog = `[object ${body.constructor && body.constructor.name ? body.constructor.name : 'unknown'}]`;
        }
      }
      else {
        bodyForLog = String(body);
      }
    }
    const requestLog = {
      url: targetURL,
      method,
      headers,
      credentials: opts.credentials || null,
      cookies: cookieSnapshot
    };
    if (bodyForLog != null) {
      requestLog.body = bodyForLog;
    }
    try {
      Zotero.debug(`[api][callAPI] request detail ${JSON.stringify(requestLog)}`, LOG_LEVEL_DEBUG);
    }
    catch (err) {
      Zotero.debug(`[api][callAPI] request detail serialization error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
    }
  }

  const expectJSONFromContentType = (contentType) => {
    if (typeof opts.expectJSON === 'boolean') {
      return opts.expectJSON;
    }
    if (wantsJSON) return true;
    return typeof contentType === 'string' && /\bapplication\/([a-z0-9.+-]*json)\b/i.test(contentType);
  };

  const buildResult = (status, rawCandidate, jsonCandidate, expectJSON, contentType, responseHeaders) => {
    const raw = normalizeRaw(rawCandidate);
    const ok = status >= 200 && status < 300;
    if (expectJSON) {
      const parsed = jsonCandidate !== undefined ? jsonCandidate : safeJSONParse(raw);
      if (parsed && typeof parsed === 'object') {
        return { ok, status, data: parsed, raw, contentType: contentType || null, headers: responseHeaders || null };
      }
      if (raw && typeof raw === 'string') {
        return { ok, status, data: raw, raw, contentType: contentType || null, headers: responseHeaders || null };
      }
      return { ok, status, data: parsed, raw, contentType: contentType || null, headers: responseHeaders || null };
    }
    return { ok, status, data: raw, raw, contentType: contentType || null, headers: responseHeaders || null };
  };

  const hasMeaningfulPayload = (result) => {
    if (!result) return false;
    if (typeof result.raw === 'string' && result.raw.length) return true;
    if (result.raw && typeof result.raw === 'object') return true;
    if (typeof result.data === 'string' && result.data.length) return true;
    if (result.data && typeof result.data === 'object') return true;
    return false;
  };

  const readStatus = (source) => (source && typeof source.status === 'number' ? source.status : 0);
  const readContentType = (source) => {
    if (!source) return null;
    if (typeof source.getResponseHeader === 'function') {
      const header = source.getResponseHeader('Content-Type');
      if (header) return header;
    }
    const sourceHeaders = source.headers;
    if (sourceHeaders && typeof sourceHeaders === 'object') {
      const targetHeader = 'content-type';
      for (const key of Object.keys(sourceHeaders)) {
        if (typeof key === 'string' && key.toLowerCase() === targetHeader) {
          const value = sourceHeaders[key];
          if (value == null) {
            return null;
          }
          return Array.isArray(value) ? value.join(',') : value;
        }
      }
    }
    return null;
  };

  const readBody = (source) => {
    if (!source) return null;
    if (typeof source.responseText === 'string') return source.responseText;
    if (typeof source.response === 'string') return source.response;
    if (source.body !== undefined) return source.body;
    if (source.response && typeof source.response === 'object') return source.response;
    return null;
  };

  const readHeaders = (source) => {
    if (!source) return null;
    const result = {};
    const record = (key, value) => {
      if (!key) return;
      const name = String(key).toLowerCase();
      if (!name) return;
      if (value == null) return;
      const valueStr = Array.isArray(value) ? value.join(',') : String(value);
      if (!valueStr) return;
      result[name] = valueStr;
    };
    const parseHeaderString = (raw) => {
      if (!raw || typeof raw !== 'string') return;
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1).trim();
        record(key, value);
      }
    };
    try {
      if (typeof source.getAllResponseHeaders === 'function') {
        parseHeaderString(source.getAllResponseHeaders());
      }
    }
    catch (_) {}
    if (source.responseHeaders) {
      const headerSource = source.responseHeaders;
      if (typeof headerSource === 'string') {
        parseHeaderString(headerSource);
      }
      else if (typeof headerSource === 'object') {
        for (const [key, value] of Object.entries(headerSource)) {
          record(key, value);
        }
      }
    }
    const directHeaders = source.headers;
    if (directHeaders) {
      if (typeof directHeaders.entries === 'function') {
        try {
          for (const [key, value] of directHeaders.entries()) {
            record(key, value);
          }
        }
        catch (_) {}
      }
      else if (Array.isArray(directHeaders)) {
        for (const entry of directHeaders) {
          if (Array.isArray(entry) && entry.length >= 2) {
            record(entry[0], entry[1]);
          }
        }
      }
      else if (typeof directHeaders === 'object') {
        for (const [key, value] of Object.entries(directHeaders)) {
          record(key, value);
        }
      }
    }
    return Object.keys(result).length ? result : null;
  };

  let defaultViewAttempted = false;
  let defaultViewCached = null;
  const maybeRunDefaultViewFallback = async () => {
    if (disableDefaultView) {
      return null;
    }
    if (defaultViewAttempted) {
      return defaultViewCached;
    }
    defaultViewAttempted = true;

    const win = doc && doc.defaultView;
    if (!win || typeof win.fetch !== 'function') {
      Zotero.debug(`${label} default-view fetch unavailable`, LOG_LEVEL_DEBUG);
      defaultViewCached = null;
      return null;
    }

    const fetchLabel = `${label} (default-view fallback)`;
    const fetchOptions = {
      method,
      credentials: opts.credentials,
      headers: Object.assign({}, headers || {})
    };
    if (allowBody && body != null) {
      fetchOptions.body = body;
    }

    try {
      const response = await win.fetch(targetURL, fetchOptions);
      let raw = '';
      if (typeof response.clone === 'function' && typeof response.arrayBuffer === 'function') {
        try {
          const buffer = await response.clone().arrayBuffer();
          raw = normalizeRaw(buffer, fetchLabel) || raw;
        }
        catch (err) {
          Zotero.debug(`[fetch] ${fetchLabel} arrayBuffer error: ${err && err.message}`, LOG_LEVEL_DEBUG);
        }
      }
      if (!raw && typeof response.text === 'function') {
        try {
          const text = await response.text();
          if (text != null) {
            raw = text;
          }
        }
        catch (err) {
          Zotero.debug(`[fetch] ${fetchLabel} text error: ${err && err.message}`, LOG_LEVEL_DEBUG);
        }
      }
      if (!raw && typeof response.arrayBuffer === 'function' && !response.bodyUsed) {
        try {
          const buffer = await response.arrayBuffer();
          raw = normalizeRaw(buffer, fetchLabel) || raw;
        }
        catch (err) {
          Zotero.debug(`[fetch] ${fetchLabel} arrayBuffer fallback error: ${err && err.message}`, LOG_LEVEL_DEBUG);
        }
      }

      const fallback = {
        ok: !!response.ok,
        status: typeof response.status === 'number' ? response.status : 0,
        raw,
        contentType: response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('content-type')
          : null,
        headers: readHeaders(response)
      };
      const fallbackExpectJSON = expectJSONFromContentType(fallback.contentType);
      const fallbackParsed = fallbackExpectJSON ? safeJSONParse(fallback.raw) : fallback.raw;
      defaultViewCached = buildResult(fallback.status || 0, fallback.raw, fallbackParsed, fallbackExpectJSON, fallback.contentType, fallback.headers);
      return defaultViewCached;
    }
    catch (e) {
      Zotero.debug(`${fetchLabel} error: ${e && e.message}`, LOG_LEVEL_DEBUG);
      defaultViewCached = null;
      return null;
    }
  };

  const promoteResult = async (result, expectJSON) => {
    if (!result) return null;

    if (forceDefaultFallback || preferDefaultView) {
      const fallbackResult = await maybeRunDefaultViewFallback();
      if (fallbackResult && fallbackResult.ok) {
        if (preferDefaultView) {
          return fallbackResult;
        }
        if (hasMeaningfulPayload(fallbackResult)) {
          return fallbackResult;
        }
      }
    }

    if (!disableDefaultView && expectJSON && (!result.data || typeof result.data !== 'object')) {
      const fallbackResult = await maybeRunDefaultViewFallback();
      if (fallbackResult && fallbackResult.ok && hasMeaningfulPayload(fallbackResult)) {
        return fallbackResult;
      }
    }

    return result;
  };

  const finalizePayload = (payload) => {
    if (!payload) return null;
    const status = typeof payload.status === 'number' ? payload.status : 0;
    const contentType = payload.contentType || null;
    const expectJSON = expectJSONFromContentType(contentType);
    const raw = normalizeRaw(payload.raw);
    const responseHeaders = payload.headers || null;
    const seededJSON = payload.jsonCandidate !== undefined
      ? payload.jsonCandidate
      : (expectJSON ? safeJSONParse(raw) : undefined);
    const ok = status >= 200 && status < 300;
    if (expectJSON) {
      if (seededJSON && typeof seededJSON === 'object') {
        return { ok, status, data: seededJSON, raw, contentType, headers: responseHeaders };
      }
      if (typeof seededJSON === 'string' && seededJSON.length) {
        return { ok, status, data: seededJSON, raw, contentType, headers: responseHeaders };
      }
      return { ok, status, data: seededJSON, raw, contentType, headers: responseHeaders };
    }
    return { ok, status, data: raw, raw, contentType, headers: responseHeaders };
  };

  const runTransport = async (transportName, transportLabel, runner) => {
    try {
      const payload = await runner();
      const result = finalizePayload(payload);
      if (!result) return null;
      const expectJSON = expectJSONFromContentType(result.contentType);
      const promoted = await promoteResult(result, expectJSON);
      return promoted;
    }
    catch (e) {
      const msg = `${transportLabel} error: ${e && e.message}`;
      if (transportName === 'pageXHR') {
        Zotero.debug(`[scaffoldFetch-xhr-error] ${targetURL}: ${e && e.message}`, LOG_LEVEL_DEBUG);
      }
      else {
        Zotero.debug(msg, LOG_LEVEL_DEBUG);
      }
      return null;
    }
  };

  const transports = [
    {
      name: 'ZU.request',
      label: `${label} via ZU.request`,
      runner: async () => {
        if (typeof ZU === 'undefined' || typeof ZU.request !== 'function') {
          return null;
        }
        const params = {
          method,
          headers,
          responseType: wantsJSON ? 'json' : 'text'
        };
        if (allowBody && body != null) {
          params.body = body;
        }
        if (opts.timeout) {
          params.timeout = opts.timeout;
        }
        const resp = await ZU.request(targetURL, params);
        if (!resp) return null;
        return {
          status: readStatus(resp),
          raw: readBody(resp),
          contentType: readContentType(resp),
          headers: readHeaders(resp),
          jsonCandidate: resp && resp.responseJSON !== undefined ? resp.responseJSON : undefined
        };
      }
    },
    {
      name: 'Zotero.HTTP.request',
      label: `${label} via Zotero.HTTP.request`,
      runner: async () => {
        if (typeof Zotero === 'undefined' || !Zotero.HTTP || typeof Zotero.HTTP.request !== 'function') {
          return null;
        }
        const httpOpts = {
          headers,
          responseType: 'text'
        };
        if (allowBody && body != null) {
          httpOpts.body = body;
        }
        if (opts.timeout) {
          httpOpts.timeout = opts.timeout;
        }
        const xhr = await Zotero.HTTP.request(method, targetURL, httpOpts);
        return {
          status: readStatus(xhr),
          raw: readBody(xhr),
          contentType: readContentType(xhr),
          headers: readHeaders(xhr)
        };
      }
    },
    {
      name: 'pageXHR',
      label: `${label} via page XHR`,
      runner: async () => {
        const win = doc && doc.defaultView;
        const XHR = (win && win.XMLHttpRequest) ? win.XMLHttpRequest : (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null);
        if (!XHR) {
          return null;
        }
        const xhr = new XHR();
        xhr.open(method, targetURL, true);
        const useCredentials = opts.credentials !== 'omit';
        if ('withCredentials' in xhr) {
          xhr.withCredentials = useCredentials;
        }
        for (const [key, value] of Object.entries(headers)) {
          if (value != null) {
            xhr.setRequestHeader(key, value);
          }
        }
        if (opts.timeout) {
          xhr.timeout = opts.timeout;
        }
        try {
          const response = await new Promise((resolve, reject) => {
            xhr.onload = () => resolve(xhr);
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.onabort = () => reject(new Error('Request aborted'));
            const payload = allowBody && body != null ? body : null;
            xhr.send(payload);
          });
          return {
            status: readStatus(response),
            raw: readBody(response),
            contentType: readContentType(response),
            headers: readHeaders(response)
          };
        }
        catch (err) {
          Zotero.debug(`${label} pageXHR error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
          return null;
        }
      }
    }
  ];

  let finalResult = null;
  let usedTransport = null;
  for (const transport of transports) {
    const promoted = await runTransport(transport.name, transport.label, transport.runner);
    if (promoted) {
      finalResult = promoted;
      usedTransport = transport.name;
      break;
    }
  }

  const elapsed = Date.now() - start;
  if (!finalResult) {
    Zotero.debug(`[chatgpt:error][callAPI] fail cid=∅ path="${targetURL}" status=0 ms=${elapsed} msg="no transport"`, LOG_LEVEL_ERROR);
    const fallback = { ok: false, status: 0, data: null, raw: '', contentType: null };
    Zotero.debug(`[api][callAPI] done path="${targetURL}" transport=∅ status=0 bytes=0 ms=${elapsed}`, LOG_LEVEL_DEBUG);
    return fallback;
  }

  if (ENABLE_VERBOSE_API_LOGGING) {
    if (finalResult.headers) {
      try {
        Zotero.debug(`[api][callAPI] response headers path="${targetURL}" ${JSON.stringify(finalResult.headers)}`, LOG_LEVEL_DEBUG);
      }
      catch (err) {
        Zotero.debug(`[api][callAPI] response headers serialization error: ${err && err.message ? err.message : err}`, LOG_LEVEL_DEBUG);
      }
    }
    if (finalResult.raw != null && finalResult.raw !== '') {
      let rawOut = null;
      if (typeof finalResult.raw === 'string') {
        rawOut = finalResult.raw;
      }
      else {
        try {
          rawOut = JSON.stringify(finalResult.raw);
        }
        catch (err) {
          rawOut = `[unserializable raw: ${err && err.message ? err.message : err}]`;
        }
      }
      if (rawOut != null) {
        Zotero.debug(`[api][callAPI] response raw path="${targetURL}" ${rawOut}`, LOG_LEVEL_DEBUG);
      }
    }
    else if (finalResult.data != null) {
      let dataOut = null;
      if (typeof finalResult.data === 'string') {
        dataOut = finalResult.data;
      }
      else {
        try {
          dataOut = JSON.stringify(finalResult.data);
        }
        catch (err) {
          dataOut = `[unserializable data: ${err && err.message ? err.message : err}]`;
        }
      }
      if (dataOut != null) {
        Zotero.debug(`[api][callAPI] response data path="${targetURL}" ${dataOut}`, LOG_LEVEL_DEBUG);
      }
    }
  }

  const statusForLog = typeof finalResult.status === 'number' ? finalResult.status : '∅';
  const bytes = (() => {
    if (!finalResult) return 0;
    if (typeof finalResult.raw === 'string') return finalResult.raw.length;
    if (finalResult.raw && typeof finalResult.raw.byteLength === 'number') return finalResult.raw.byteLength;
    if (typeof finalResult.data === 'string') return finalResult.data.length;
    return 0;
  })();
  Zotero.debug(`[api][callAPI] done path="${targetURL}" transport=${usedTransport || '∅'} status=${statusForLog} bytes=${bytes} ms=${elapsed}`, LOG_LEVEL_DEBUG);
  return finalResult;
}


/*
 * Translator tests intentionally omitted. Capturing private ChatGPT
 * conversations requires account-specific authentication and cannot be made
 * into a reusable fixture. This matches the precedent set by other
 * account-bound translators (e.g., Gmail.js, Evernote.js, Intellixir.js),
 * which also ship without automated tests.
 */

/** BEGIN TEST CASES **/
var testCases = [
]
/** END TEST CASES **/
