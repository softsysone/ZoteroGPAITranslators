/* Gemini Chat translator — v0.5.1-beta
 *
 * # Vibe Coding Directives:
 * 
 * ## Initial Directive for a New Vibe Coding Session
 *    1. Review all header comments to understand directives, conventions, provenances, and recent changes
 *    2. Review code to understand it
 *    3. Briefly review provenances to see how the code follows them
 * 
 * ## Continual Directives
 *    - Every change of the file should have a version bump as a higher alpha, 
 *      unless you are specifically asked to increment the beta or release
 * 
 *    - Always follow the conventions listed in the header comments
 * 
 * ## Debugging 
 *    1. You will be given the output from either the Scaffold IDE and/or the Zotero debug log from a web browser
 *    2. Determine what you think is causing the problem by comparing current methods to the provenances methods
 *    3. Work to fix the code based on following the methods in the provenences
 *    4. Add debug logging to both test the fix, and to see if something different was actually the cause
 *    5. Explain what you thought the cause was, what you did to try and fix it, and what logging you added to check your hypothesis
 *
 * 
 * @fileoverview Zotero connector translator for Gemini Chat, 
 * to fill the following fields with listed formats based on the methods in order of priority:
 * 
 * Item Type: 'instantMessage' (/app/c/<id>, /app/<id>, /share/<id> )
 * Title: DOM sidebar selection, fallback method MaZiqc API lookup
 * Author 1: 'Google Gemini' + '(' engine/model via internal API if available ')'
 * Author 2: DOM XPath of human/workspace
 * Date: Timestamp with timezone offset via internal API, fallback to current local time
 * URL: prefer public /share/<id> when discovered, otherwise local URL
 * Attachment: snapshot of the current page
 * 
 * Conventions:
 * - Versioning convention is as follows:
 *   R.0.0 is a Release that should work
 *   R.B.0-beta is a Beta that seems to mostly work
 *   R.B.A-alpha is the default of an Alpha to internally test
 * 
 * - The Changelog should always be updated as follows depending upon the type of version update:
 *   Alpha update put a short description of what we are attempting to do that will be tested
 *   Beta update remove the list of alpha changes and rd replace with the problem tackled and solution found
 *   Release update remove the beta and alpha list and put in what new features this update has, or fix not caught in Beta
 * 
 * - As much as possible we want to align with the provenances
 * 
 * Provenance:
 * - Internal API Calls Modeled after Gemini-API and Gemini-API-dsd python projects (see local clones).
 * - Structure and Zotero functions modeled after codex-ChatGPT.js
 * 

 *
* Changelog
* - v0.5.0-beta: Refactored into a cleaner release, emphasizing reduced complexity and leaner API/date handling.
* - v0.4.0-beta: Can get major metadata via DOM and API (of sidebar) for both Scaffold and Chromium
 */

const ZOTERO_FETCH_DEFAULT_TIMEOUT_MS = 7000;
const GEMINI_HOST = 'https://gemini.google.com';
const LIST_CONVERSATION_LIMIT = 100;
const DEFAULT_AI_NAME = 'Google Gemini';

let BATCH_EXECUTE_REQ_COUNTER = Math.floor(Math.random() * 9000) + 1000;
const GEMINI_BATCH_CONTEXT_CACHE = new WeakMap();

function detectWeb(doc, url) {
  return /https?:\/\/gemini\.google\.com\/(?:app(?:\/c)?|share)\/[A-Za-z0-9_-]+/i.test(url)
    ? 'instantMessage' : false;
}

async function doWeb(doc, url) {
  const VERSION = 'v0.5.1-beta';
  Zotero.debug(`Gemini Chat doWeb ${VERSION}`);

  await getItem(doc, url);
}


/**
 * @description Build and populate a Zotero item for the current Gemini conversation.
 * @param {Document} doc
 * @param {string} url
 * @returns {Promise<void>}
 */
async function getItem(doc, url) {
	// Create the new Zotero item with the appropriate type
	const item = new Zotero.Item(getType(doc, url));

  // Get the IDs from the DOM that are needed for the Internal API
	const ids = getIDs(doc, url);
	Zotero.debug(`[ids] conversation=${ids.conversationID || '∅'} lastPrompt=${ids.lastPromptID || '∅'} lastResponse=${ids.lastResponseID || '∅'}`);

  //getTitle, getAuthors, getURL, getExtra, and getAttachments abstract away these parts
	item.title = getTitle(doc, url, ids);


	for (const creator of getAuthors(doc, url, ids)) {
		item.creators.push(creator);
	}

	item.url = getURL(doc, url, ids);

	const extra = getExtra(doc, url, ids);
	if (extra) {
		item.extra = extra;
	}

	for (const attachment of getAttachments(doc, url, ids)) {
		item.attachments.push(attachment);
	}

	item.date = await getDate(doc, url, ids);

	const summaryTitle = cleanTitle(ids?.apiSummary?.title);
	if (summaryTitle) {
		const currentTitle = item.title ? item.title.trim() : '';
		if (!currentTitle
			|| currentTitle === 'Google Gemini'
			|| currentTitle === 'Gemini Chat Conversation'
			|| currentTitle === (doc?.title || '').trim()) {
			item.title = summaryTitle;
		}
	}

	item.complete();
}


/**
 * @description Resolve the Zotero item type to use for Gemini Chat saves.
 * @param {Document} doc
 * @param {string} url
 * @returns {string}
 */
function getType(doc, url) {
	// Until a General Purpose AI (GPAI) type is added to Zotero, 
  // chat based AIs are closest to an Instant Message
	return 'instantMessage';
}


/**
 * @description Gets the IDs for the conversation that are used for the API
 * @param {Document} doc
 * @param {string} url
 * @returns {{conversationID: string|null, lastPromptID: string|null, lastResponseID: string|null}}
 */
function getIDs(doc, url) {
  return {
    conversationID: getConversationID(doc, url),
    lastPromptID: getLastPromptID(doc),
    lastResponseID: getLastResponseID(doc)
  };
}


/**
 * @description Gets the ID for the current conversation. In Gemini, c_id is the conversation_id
 * @param {Document} doc
 * @param {string} url
 * @returns {string|null}
 */
function getConversationID(doc, url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/(?:app(?:\/c)?|share)\/([A-Za-z0-9_-]+)/i);
  if (!match || !match[1]) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  return raw.startsWith('c_') ? raw : `c_${raw}`;
}


/**
 * @description Gets the ID of the last prompt from the user. In Gemini, r_id (request message id) is lastPromptID
 * @param {Document} doc
 * @returns {string|null}
 */
function getLastPromptID(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;

  let lastPromptID = null;

  const captureFromText = (text) => {
    if (!text || typeof text !== 'string') return;
    const matches = text.match(/r_[A-Za-z0-9]+/g);
    if (matches && matches.length) {
      lastPromptID = matches[matches.length - 1];
    }
  };

  // Scrape inline jslog payloads for the latest r_ ids
  const jslogNodes = doc.querySelectorAll('[jslog]');
  for (const node of jslogNodes) {
    captureFromText(node.getAttribute('jslog'));
  }

  if (lastPromptID) {
    return lastPromptID;
  }

  // Fallback: scan known message containers for r_ ids
  const messageNodes = doc.querySelectorAll(
    '[id^="message-content-id-r_"], ' +
    '[id^="model-response-message-contentr_"], ' +
    '[id^="message-content-r_"]'
  );
  for (const node of messageNodes) {
    const idAttr = node.getAttribute('id');
    const match = idAttr && idAttr.match(/r_[A-Za-z0-9]+/);
    if (match) {
      lastPromptID = match[0];
    }
  }

  return lastPromptID;
}


/**
 * @description Gets the ID for the last Response. In Gemini, rc_id (response candidate id) is lastResponseID
 * @param {Document} doc
 * @returns {string|null}
 */
function getLastResponseID(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;

  let lastResponseID = null;

  const captureFromText = (text) => {
    if (!text || typeof text !== 'string') return;
    const matches = text.match(/rc_[A-Za-z0-9]+/g);
    if (matches && matches.length) {
      lastResponseID = matches[matches.length - 1];
    }
  };

  // Scrape inline jslog payloads for the latest rc_ ids
  const jslogNodes = doc.querySelectorAll('[jslog]');
  for (const node of jslogNodes) {
    captureFromText(node.getAttribute('jslog'));
  }

  if (lastResponseID) {
    return lastResponseID;
  }

  // Fallback: scan draft attributes for rc_ ids
  const responseDrafts = doc.querySelectorAll('[data-test-draft-id^="rc_"]');
  for (const node of responseDrafts) {
    const draftID = node.getAttribute('data-test-draft-id');
    const match = draftID && draftID.match(/rc_[A-Za-z0-9]+/);
    if (match) {
      lastResponseID = match[0];
    }
  }

  if (lastResponseID) {
    return lastResponseID;
  }

  // Fallback: scan generic id attributes for rc_ ids
  const responseAttrNodes = doc.querySelectorAll('[id*="rc_"]');
  for (const node of responseAttrNodes) {
    const idAttr = node.getAttribute('id');
    const match = idAttr && idAttr.match(/rc_[A-Za-z0-9]+/);
    if (match) {
      lastResponseID = match[0];
    }
  }

  return lastResponseID;
}


/**
 * @description Derive the AI display name from the document title, falling back to a default label.
 * @param {Document} doc
 * @returns {string}
 */
function getAIName(doc) {
	if (!doc || typeof doc.title !== 'string') {
		return DEFAULT_AI_NAME;
	}

	const rawTitle = doc.title.trim();
	if (!rawTitle) {
		return DEFAULT_AI_NAME;
	}

	const separators = [' — ', ' – ', ' - ', ': '];
	const candidates = [rawTitle];
	for (const sep of separators) {
		if (!rawTitle.includes(sep)) continue;
		const parts = rawTitle.split(sep);
		for (const part of parts) {
			const candidate = typeof part === 'string' ? part.trim() : '';
			if (candidate) {
				candidates.push(candidate);
			}
		}
	}

	for (const candidate of candidates) {
		if (typeof candidate === 'string' && /gemini/i.test(candidate)) {
			return candidate;
		}
	}

	return candidates[0] || DEFAULT_AI_NAME;
}


/**
 * @description Extract the AI model name from DOM elements and meta tags.
 * @param {Document} doc
 * @returns {string|null}
 */
function getAIModel(doc) {
	if (!doc || typeof doc.querySelectorAll !== 'function') {
		return null;
	}

	const sanitizeModelName = (value) => {
		if (!value) return null;
		const trimmed = value.trim().replace(/\s+/g, ' ');
		if (!trimmed) return null;
		const normalized = trimmed.replace(/[.,;\s]+$/, '');
		if (!normalized || /^Gemini$/i.test(normalized)) {
			return null;
		}
		return normalized;
	};

	const parseModelCandidate = (value) => {
		if (!value || typeof value !== 'string') return null;
		const cleaned = value.trim().replace(/\s+/g, ' ');
		if (!cleaned) return null;

		const normalized = cleaned.replace(/^current model:\s*/i, '').replace(/^model:\s*/i, '');

		const parenMatch = normalized.match(/\(([^)]+)\)/);
		if (parenMatch && parenMatch[1]) {
			const inParens = sanitizeModelName(parenMatch[1]);
			if (inParens) return inParens;
		}

		const labelMatch = normalized.match(/(?:model|using|with)[:\-]?\s*(Gemini[^|]+)/i);
		if (labelMatch && labelMatch[1]) {
			const candidate = sanitizeModelName(labelMatch[1]);
			if (candidate) return candidate;
		}

		const geminiMatch = normalized.match(/Gemini\s+[A-Za-z0-9 .+-]+/);
		if (geminiMatch && geminiMatch[0]) {
			const candidate = sanitizeModelName(geminiMatch[0]);
			if (candidate) return candidate;
		}

		const simpleMatch = normalized.match(/\b(?:1(?:\.[0-9]+)?\s+(?:Pro|Flash|Nano)|Nano|Pro)\b/i);
		if (simpleMatch && simpleMatch[0]) {
			const candidate = sanitizeModelName(simpleMatch[0]);
			if (candidate) return candidate;
		}

		return null;
	};

	const selectors = [
		'[data-test-id="model-switcher"]',
		'[data-test-id="model-chip"]',
		'[data-test-id="model-pill"]',
		'[aria-label*="model" i]',
		'[title*="model" i]'
	];

	for (const selector of selectors) {
		const nodes = doc.querySelectorAll(selector);
		for (const node of nodes) {
			const aria = node.getAttribute && node.getAttribute('aria-label');
			const fromAria = parseModelCandidate(aria);
			if (fromAria) return fromAria;

			const title = node.getAttribute && node.getAttribute('title');
			const fromTitle = parseModelCandidate(title);
			if (fromTitle) return fromTitle;

			const text = typeof node.textContent === 'string' ? node.textContent : null;
			const fromText = parseModelCandidate(text);
			if (fromText) return fromText;
		}
	}

	const metaSelectors = [
		'meta[name="model"]',
		'meta[itemprop="softwareVersion"]',
		'meta[name="application-name"]'
	];
	for (const selector of metaSelectors) {
		const el = doc.querySelector(selector);
		if (!el) continue;
		const content = el.getAttribute('content') || el.getAttribute('value');
		const fromMeta = parseModelCandidate(content);
		if (fromMeta) return fromMeta;
	}

	return null;
}


/**
 * @description Resolve the conversation title using sidebar DOM heuristics backed by the URL ID.
 * @param {Document} doc
 * @param {string} url
 * @param {{conversationID?: (string|null)}} ids
 * @returns {string}
 */
function getTitle(doc, url, ids) {
	const extractTitle = (node) => {
		if (!node || typeof node.querySelector !== 'function') {
			return null;
		}
		const candidateValues = [];
		const titleNode = node.querySelector('.conversation-title');
		if (titleNode && typeof titleNode.textContent === 'string') {
			candidateValues.push(titleNode.textContent);
		}
		const directLabel = node.getAttribute && node.getAttribute('aria-label');
		if (directLabel) {
			candidateValues.push(directLabel);
		}
		const labelled = node.querySelector('[aria-label]');
		if (labelled) {
			const labelValue = labelled.getAttribute('aria-label');
			if (labelValue) {
				candidateValues.push(labelValue);
			}
		}
		const titleAttr = node.getAttribute && node.getAttribute('title');
		if (titleAttr) {
			candidateValues.push(titleAttr);
		}
		const textContent = typeof node.textContent === 'string' ? node.textContent : null;
		if (textContent) {
			candidateValues.push(textContent);
		}
		for (const value of candidateValues) {
			const cleaned = cleanTitle(value);
			if (cleaned) {
				return cleaned;
			}
		}
		return null;
	};

	const convID = (ids && ids.conversationID) || getConversationID(doc, url);
	if (doc && convID) {
		const normalized = convID.startsWith('c_') ? convID : `c_${convID}`;
		const bare = normalized.slice(2);
		const selectors = [
			`[data-test-id="conversation"][data-conversation-id="${normalized}"]`,
			`[data-test-id="conversation"][data-conversation-id="${bare}"]`
		];
		for (const selector of selectors) {
			const title = extractTitle(doc.querySelector(selector));
			if (title) {
				return title;
			}
		}
	}

	if (doc && typeof doc.querySelector === 'function') {
		const selectionSelectors = [
			'[data-test-id="conversation"][aria-selected="true"]',
			'[data-test-id="conversation"][aria-current="page"]',
			'[data-test-id="conversation"].selected'
		];
		for (const selector of selectionSelectors) {
			const title = extractTitle(doc.querySelector(selector));
			if (title) {
				return title;
			}
		}
	}

	const generic = cleanTitle(doc && doc.title);
	if (generic) {
		return generic;
	}

	return 'Gemini Chat Conversation';
}


/**
 * @description Collect the AI and human authors for the current conversation.
 * @param {Document} doc
 * @param {string} url
 * @param {{}} ids
 * @returns {Array<{lastName: string, fieldMode: number, creatorType: string}>}
 */
function getAuthors(doc, url, ids) {
	const aiName = getAIName(doc);
	const modelName = getAIModel(doc);

	const scrubName = (value) => {
		if (!value || typeof value !== 'string') return null;
		const stripped = value.replace(/Google Account:\s*/i, '').trim();
		if (!stripped) return null;

		const withoutParen = stripped.replace(/\s*\([^)]*\)\s*$/, '').trim();
		const firstLine = withoutParen.split(/\r?\n/).map(part => part.trim()).find(Boolean) || withoutParen;
		if (!firstLine) return null;
		if (/^(?:google\s+account|gemini)$/i.test(firstLine)) return null;
		if (/google\s+gemini/i.test(firstLine)) return null;

		const segments = firstLine
			.split(/[—–\-:|]/)
			.map(part => part.trim())
			.filter(Boolean);

		return segments[0] || firstLine;
	};

	const humanName =
		Array.from(doc?.querySelectorAll?.('[aria-label*="Google Account" i]') || [])
			.map(node => scrubName(node.getAttribute?.('aria-label') || node.textContent))
			.find(Boolean)
		|| ['meta[name="author"]', "meta[property='og:title']", "meta[name='twitter:title']"]
			.map(selector => doc?.querySelector?.(selector))
			.map(node => scrubName(node?.getAttribute('content') || node?.getAttribute('value')))
			.find(Boolean)
		|| scrubName(typeof doc?.title === 'string' ? doc.title : null);

	return [
		modelName ? `${aiName} (${modelName})` : aiName,
		humanName
	]
		.filter(Boolean)
		.map(name => ({
			lastName: name,
			fieldMode: 1,
			creatorType: 'author'
		}));
}


/**
 * @description Resolve the conversation timestamp, preferring API metadata.
 * @param {Document} doc
 * @param {string} url
 * @param {{ conversationID?: string|null, apiSummary?: { isoDate?: string } }} ids
 * @returns {Promise<string|null>}
 */
async function getDate(doc, url, ids) {

  // If a date has already been found while running the code, just use that
	let summary = ids && ids.apiSummary ? ids.apiSummary : null;
	const convID = (ids && ids.conversationID) || getConversationID(doc, url);

  // Call the Internal API to get the Conversation Summary based on the Conversation ID
	if (!summary && convID) {
		try {
			const auth = await getAPIAuthInfo(doc);
			if (!auth || !auth.token) {
				Zotero.debug(`[summary] missing auth token; skipping MaZiqc lookup for cid=${convID}`);
			} else {
					const matched = await getConversationSummary(doc, auth, {
						cid: convID
					});
				if (matched) {
					if (ids) {
						ids.apiSummary = matched;
					}
					summary = matched;
					Zotero.debug(`[summary] matched cid=${matched.cid || '∅'} title=${cleanTitle(matched.title) || '∅'} iso=${matched.isoDate || '∅'}`);
				} else {
					Zotero.debug(`[summary] MaZiqc summaries lacked entry for cid=${convID}`);
				}
			}
		} catch (err) {
			Zotero.debug(`[summary] MaZiqc lookup failed: ${err && err.message}`);
		}
	}

  // If we have an ISO Date, return it
	if (summary && summary.isoDate) {
		Zotero.debug(`[date] MaZiqc summary cid=${summary.cid || '∅'} iso=${summary.isoDate}`);
		return summary.isoDate;
	}

  // Returns today's date as a fallback
	return formatLocalOffset(Date.now());
}


/**
 * @description Resolve the final item URL, preferring shared links when available.
 * @param {Document} doc
 * @param {string} url
 * @param {{}} ids
 * @returns {string}
 */
function getURL(doc, url, ids) {
	// Return the public URL for the item, if possible, otherwise the private url

  // Check if a Shared URL exists

  // Try to get the shared URL via API

  // Fallback to scraping DOM for shared URL

  // If shared URL does not exist, or cannot be found use current URL

	return url;
}


/**
 * @description Build the `extra` field with supplemental metadata for the item.
 * @param {Document} doc
 * @param {string} url
 * @param {{}} ids
 * @returns {string}
 */
function getExtra(doc, url, ids) {
	// Populate the extra field with additional metadata
  // Each Metadata should be on its own line in the form Label: Data   
	return '';
}


/**
 * @description Provide snapshot attachments that capture the conversation state.
 * @param {Document} doc
 * @param {string} url
 * @param {{}} ids
 * @returns {Array<{title: string, document?: Document, url?: string, snapshot?: boolean}>>
 */
function getAttachments(doc, url, ids) {
	const attachments = [];

	// Always capture a snapshot so the saved item reflects the conversation state.
	if (doc) {
		attachments.push({
			title: 'Gemini Chat Conversation Snapshot',
			document: doc,
			url,
			snapshot: true
		});
	}

	return attachments;
}


async function getConversationSummary(doc, auth, options) {
  const token = auth?.token;
  if (!token) {
    Zotero.debug('[api] MaZiqc skipped (missing token)');
    return null;
  }

  const targetCID = options?.cid || null;
  const endpoint = getAPIEndpoint(doc, 'MaZiqc', auth);

  const normalizeCID = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.startsWith('c_') ? trimmed : `c_${trimmed}`;
  };

  const normalizedTarget = normalizeCID(targetCID);

  const seenCIDs = new Set();
  let fallbackSummary = null;

  const considerEntry = (entry) => {
    if (!entry) return false;
    const entryCID = typeof entry.cid === 'string' ? entry.cid : null;
    if (entryCID) {
      if (seenCIDs.has(entryCID)) {
        return false;
      }
      seenCIDs.add(entryCID);
    }

    if (!normalizedTarget && !fallbackSummary) {
      fallbackSummary = entry;
    }

    if (normalizedTarget && entryCID) {
      const normalizedEntry = normalizeCID(entryCID);
      if (normalizedEntry && normalizedEntry === normalizedTarget) {
        return true;
      }
    }
    return false;
  };

  const runAttempt = async (identifier, buildArgs, initialPageToken) => {
    const seenPageTokens = new Set();
    let pageToken = initialPageToken;

    while (true) {
      const requestArgs = buildArgs(pageToken);
      const entry = ['MaZiqc', JSON.stringify(requestArgs), null, identifier];
      const body = `f.req=${encodeURIComponent(JSON.stringify([[entry]]))}&at=${encodeURIComponent(token)}`;
      const label = pageToken ? `${identifier} pageToken=${pageToken}` : identifier;

      const response = await callAPI(doc, endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Origin': 'https://gemini.google.com',
          'Referer': 'https://gemini.google.com/app',
          'X-Same-Domain': '1'
        },
        body,
        timeout: ZOTERO_FETCH_DEFAULT_TIMEOUT_MS,
        responseType: 'text',
        forceDefaultViewFallback: true
      });

      if (!response.ok) {
        Zotero.debug(`[sidebarApi] ${label} status=${response.status}`);
        return null;
      }

      const payloadText = decodeBufferToText(response.raw ?? response.data, `[sidebarApi] ${label}`);
      if (!payloadText) {
        Zotero.debug(`[sidebarApi] ${label} empty payload`);
        return null;
      }

      const payloads = (() => {
        if (!payloadText || typeof payloadText !== 'string') return [];

        let cursor = 0;
        const length = payloadText.length;
        const results = [];
        let abortedToFallback = false;

        const recordWrBPayload = (entry) => {
          if (!entry || !Array.isArray(entry) || entry[0] !== 'wrb.fr') return;

          let payloadCandidate = null;
          for (let i = 1; i < entry.length; i++) {
            const candidate = entry[i];
            if (!candidate) continue;
            if (typeof candidate === 'string') {
              const parsedCandidate = safeJSONParse(candidate);
              if (parsedCandidate) {
                payloadCandidate = parsedCandidate;
                break;
              }
            } else if (typeof candidate === 'object') {
              payloadCandidate = candidate;
              break;
            }
          }

          if (payloadCandidate) {
            results.push(payloadCandidate);
          } else {
            Zotero.debug('[batch] wrb.fr entry lacked parsable payload');
          }
        };

        if (payloadText.startsWith(")]}'")) {
          const firstBreak = payloadText.indexOf('\n', cursor);
          cursor = firstBreak === -1 ? length : firstBreak + 1;
        }

        while (cursor < length) {
          while (cursor < length && /\s/.test(payloadText[cursor])) {
            cursor++;
          }
          if (cursor >= length) break;

          if (!/[0-9]/.test(payloadText[cursor])) {
            abortedToFallback = true;
            break;
          }

          let lenStr = '';
          while (cursor < length && /[0-9]/.test(payloadText[cursor])) {
            lenStr += payloadText[cursor++];
          }
          if (!lenStr) {
            abortedToFallback = true;
            break;
          }

          const chunkLen = parseInt(lenStr, 10);
          if (!Number.isFinite(chunkLen) || chunkLen <= 0) {
            Zotero.debug(`[batch] skip chunk with lenStr=${lenStr}`);
            while (cursor < length && payloadText[cursor] !== '\n') cursor++;
            cursor++;
            abortedToFallback = true;
            continue;
          }

          if (payloadText[cursor] === '\n') cursor++;

          if (cursor + chunkLen > length) {
            Zotero.debug(`[batch] chunk overruns buffer: need=${chunkLen} have=${length - cursor}`);
            abortedToFallback = true;
            break;
          }

          const chunk = payloadText.slice(cursor, cursor + chunkLen);
          cursor += chunkLen;
          if (payloadText[cursor] === '\n') cursor++;

          const parsed = safeJSONParse(chunk);
          if (!parsed) {
            abortedToFallback = true;
            continue;
          }

          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              recordWrBPayload(entry);
            }
          } else {
            recordWrBPayload(parsed);
          }
        }

        if (!results.length || abortedToFallback) {
          Zotero.debug('[batch] fallback parser engaged');
          const lines = payloadText.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === ')]}\'') continue;
            const parsed = safeJSONParse(trimmed);
            if (!parsed) continue;
            if (Array.isArray(parsed)) {
              for (const entry of parsed) {
                recordWrBPayload(entry);
              }
            } else {
              recordWrBPayload(parsed);
            }
          }
        }

        return results;
      })();

      const { summaries, nextPageToken } = extractConversationSummariesFromPayloads(payloads);
      Zotero.debug(`[sidebarApi] ${label} summaries=${summaries.length}`);

      for (const summary of summaries) {
        const matched = considerEntry(summary);
        if (matched) {
          return summary;
        }
      }

      if (!nextPageToken) {
        return null;
      }
      if (seenPageTokens.has(nextPageToken)) {
        Zotero.debug(`[sidebarApi] ${label} repeated page token; stopping pagination`);
        return null;
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
  };

  const attempts = [];
  attempts.push({
    identifier: targetCID ? `SIDEBAR target=${targetCID}` : 'SIDEBAR',
    buildArgs: (pageToken) => [[
      pageToken ?? '',
      LIST_CONVERSATION_LIMIT,
      [[false, true, targetCID || '']]
    ]],
    initialToken: ''
  });
  if (targetCID) {
    attempts.push({
      identifier: 'SIDEBAR default',
      buildArgs: (pageToken) => [[
        pageToken ?? '',
        LIST_CONVERSATION_LIMIT,
        [[false, true, '']]
      ]],
      initialToken: ''
    });
  }
  attempts.push({
    identifier: 'generic listing',
    buildArgs: (pageToken) => [
      LIST_CONVERSATION_LIMIT,
      pageToken ?? null,
      [0, null, 1]
    ],
    initialToken: null
  });

  for (const attempt of attempts) {
    const matched = await runAttempt(attempt.identifier, attempt.buildArgs, attempt.initialToken);
    if (matched) {
      return matched;
    }
    if (!normalizedTarget && fallbackSummary) {
      return fallbackSummary;
    }
  }

  if (!normalizedTarget) {
    return fallbackSummary;
  }

  Zotero.debug(`[sidebarApi] MaZiqc returned no conversations for cid=${targetCID || '∅'}`);
  return null;
}


function extractConversationSummariesFromPayloads(payloads) {
  const summaries = [];
  let nextPageToken = null;
  if (!Array.isArray(payloads)) {
    return { summaries, nextPageToken };
  }

  for (const payload of payloads) {
    if (!Array.isArray(payload)) continue;
    if (payload.length > 1 && typeof payload[1] === 'string' && payload[1] && !nextPageToken) {
      nextPageToken = payload[1];
    }
    const rows = Array.isArray(payload[2]) ? payload[2] : null;
    if (!rows || !rows.length) continue;

    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const cid = typeof row[0] === 'string' ? row[0] : null;
      const title = cleanTitle(typeof row[1] === 'string' ? row[1] : null);
      const tsParts = Array.isArray(row[5]) ? row[5] : null;
      let timestampMs = null;
      if (tsParts && tsParts.length) {
        const seconds = Number(tsParts[0]);
        if (Number.isFinite(seconds)) {
          const nanos = tsParts.length > 1 ? Number(tsParts[1]) : 0;
          const millis = Number.isFinite(nanos) ? Math.round(nanos / 1e6) : 0;
          timestampMs = (seconds * 1000) + millis;
        }
      }
      const summary = {
        cid,
        title,
        timestampMs,
        isoDate: timestampMs != null ? formatLocalOffset(timestampMs) : null,
        rawRow: row
      };
      summaries.push(summary);
    }
  }

  summaries.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
  return { summaries, nextPageToken };
}

function cleanTitle(title) {
  if (!title) return null;
  const trimmed = title.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s+\|\s*Gemini$/i, '').trim();
}

function formatLocalOffset(ms) {
  const d = new Date(ms);
  if (!isFinite(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzMin);
  const tzh = String(Math.floor(abs / 60)).padStart(2, '0');
  const tzm = String(abs % 60).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${sign}${tzh}:${tzm}`;
}

function safeJSONParse(text, options) {
  const { logError = false, label = '' } = options || {};
  try {
    return JSON.parse(text);
  } catch (e) {
    if (logError) {
      const prefix = label ? `${label} ` : '';
      Zotero.debug(`[json] ${prefix}parse error: ${e && e.message}`);
    }
    return null;
  }
}

function decodeBufferToText(value, contextLabel) {
  const label = contextLabel ? `${contextLabel} ` : '';
  try {
    if (!value && value !== 0) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      try {
        return JSON.stringify(value);
      } catch (_) {
        return value.join(',');
      }
    }
    if (value && typeof value === 'object') {
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
            } catch (_) {
              return new Uint8Array(input.buffer);
            }
          }
        }
        if (typeof input.byteLength === 'number') {
          try {
            return new Uint8Array(input);
          } catch (_) {}
        }
        if (input.buffer && typeof input.buffer.byteLength === 'number') {
          try {
            return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength || input.buffer.byteLength);
          } catch (_) {
            return new Uint8Array(input.buffer);
          }
        }
        return null;
      };

      const view = toUint8(value);
      if (view && view.length) {
        if (typeof TextDecoder !== 'undefined') {
          try {
            return new TextDecoder('utf-8').decode(view);
          } catch (_) {}
        }
        let result = '';
        for (let i = 0; i < view.length; i++) {
          result += String.fromCharCode(view[i]);
        }
        return result;
      }

      if (view && view.length === 0) {
        return '';
      }

      if (typeof value.toString === 'function') {
        const str = value.toString();
        if (str && str !== '[object Object]') {
          return str;
        }
      }

      try {
        return JSON.stringify(value);
      } catch (_) {}
    }
  } catch (err) {
    Zotero.debug(`[buffer] ${label}decode error: ${err && err.message}`);
  }
  return '';
}

// Internal API Related Functions //

async function getAPIAuthInfo(doc) {
  const context = getAPIContext(doc);
  let token = getAPIToken(doc);
  if (token) {
    return Object.assign({ token }, context);
  }

  const origin = getAPIOrigin(doc);
  try {
    const fallback = await callAPI(doc, `${origin}/app`, {
      method: 'GET',
      headers: {
        'Accept': 'text/html',
        'X-Same-Domain': '1'
      },
      timeout: 4000
    });
    if (fallback && fallback.ok && typeof fallback.data === 'string') {
      token = getAPIToken(fallback.data);
      if (token) {
        Zotero.debug('[auth] SNlM0e token acquired via fallback fetch');
        return Object.assign({ token }, context);
      }
    } else if (fallback && !fallback.ok) {
      Zotero.debug(`[auth] fallback /app fetch status=${fallback.status}`);
    }
  } catch (e) {
    Zotero.debug(`[auth] fallback fetch error: ${e && e.message}`);
  }

  return Object.assign({ token: null }, context);
}

function getAPIToken(source) {
  if (!source) return null;
  let html = null;
  if (typeof source === 'string') {
    html = source;
  } else if (source && source.documentElement) {
    html = source.documentElement.innerHTML;
  }
  if (!html) return null;
  const match = /"SNlM0e":"([^"]+)"/.exec(html);
  return match ? match[1] : null;
}

function getAPIEndpoint(doc, rpcID, auth, extraParams) {
  const origin = getAPIOrigin(doc);
  const params = new URLSearchParams();
  params.set('rpcids', rpcID);
  params.set('source-path', '/app');

  const bl = auth?.bl != null ? String(auth.bl) : null;
  const hl = auth?.hl != null ? String(auth.hl) : null;
  const fSid = auth?.fSid != null ? String(auth.fSid) : null;

  if (bl) params.set('bl', bl);
  if (hl) params.set('hl', hl);
  if (fSid) params.set('f.sid', fSid);

  params.set('soc-app', '162');
  params.set('soc-platform', '1');
  params.set('soc-device', '1');
  params.set('_reqid', String(BATCH_EXECUTE_REQ_COUNTER++));
  params.set('rt', 'c');

  if (extraParams && typeof extraParams === 'object') {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value == null) continue;
      params.set(key, String(value));
    }
  }

  const debugParams = new URLSearchParams(params);
  if (debugParams.has('f.sid')) {
    debugParams.set('f.sid', '***');
  }
  Zotero.debug(`[batchUrl] rpc=${rpcID} params=${debugParams.toString()}`);
  return `${origin}/_/BardChatUi/data/batchexecute?${params.toString()}`;
}

function getAPIContext(doc) {
  if (!doc) {
    return { bl: null, fSid: null, hl: null };
  }

  if (GEMINI_BATCH_CONTEXT_CACHE.has(doc)) {
    return GEMINI_BATCH_CONTEXT_CACHE.get(doc);
  }

  const context = { bl: null, fSid: null, hl: null };
  const html = (() => {
    try {
      return doc.documentElement ? String(doc.documentElement.innerHTML) : '';
    } catch (_) {
      return '';
    }
  })();

  const matchAny = (patterns) => {
    for (const pattern of patterns) {
      const m = pattern.exec(html);
      if (m && m[1]) {
        return m[1];
      }
    }
    return null;
  };

  const globalData = (() => {
    try {
      return doc?.defaultView?.WIZ_global_data || doc?.defaultView?.__WIZ_global_data || null;
    } catch (_) {
      return null;
    }
  })();

  const readGlobalValue = (obj, key) => {
    if (!obj) return null;
    const value = obj[key];
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return null;
  };

  if (!context.bl) {
    context.bl = readGlobalValue(globalData, 'cfb2h');
  }
  if (!context.fSid) {
    context.fSid = readGlobalValue(globalData, 'FdrFJe');
  }
  if (!context.hl) {
    context.hl = readGlobalValue(globalData, 'hl');
  }

  if (!context.bl) {
    context.bl = matchAny([
      /"cfb2h":"([^"\\]+)"/,
      /\\"cfb2h\\":\\"([^"\\]+)\\"/
    ]);
  }

  if (!context.fSid) {
    context.fSid = matchAny([
      /"FdrFJe":"([^"\\]+)"/,
      /\\"FdrFJe\\":\\"([^"\\]+)\\"/
    ]);
  }

  if (!context.fSid) {
    context.fSid = matchAny([
      /"f\.sid":"([^"]+)"/,
      /\\"f\.sid\\":\\"([^"]+)\\"/
    ]);
  }

  if (!context.hl) {
    const hlCandidate = matchAny([
      /"hl":"([a-zA-Z-]+)"/,
      /\\"hl\\":\\"([a-zA-Z-]+)\\"/
    ]);
    if (hlCandidate) {
      context.hl = hlCandidate;
    }
  }

  if (!context.hl) {
    const docLang = doc.documentElement && (doc.documentElement.lang || doc.documentElement.getAttribute('lang'));
    if (docLang) {
      context.hl = docLang;
    }
  }

  if (!context.hl) {
    context.hl = 'en';
  }

  GEMINI_BATCH_CONTEXT_CACHE.set(doc, context);
  Zotero.debug(`[apiCtx] bl=${context.bl || '∅'} fSid=${context.fSid || '∅'} hl=${context.hl}`);
  return context;
}

function getAPIOrigin(doc) {
  try {
    return new URL(doc?.location?.href || GEMINI_HOST).origin;
  } catch (_) {
    return GEMINI_HOST;
  }
}


async function callAPI(doc, target, options) {
  const baseHref = doc && doc.location ? String(doc.location.href) : null;
  let url;
  try {
    url = new URL(target, baseHref || undefined).href;
  } catch (_) {
    url = target;
  }

  const opts = Object.assign({ headers: {}, method: 'GET' }, options || {});
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({}, opts.headers || {});
  const body = opts.body !== undefined ? opts.body : null;
  const label = opts.label || `[callAPI] ${method} ${target}`;
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
    if (typeof opts.expectJSON === 'boolean') {
      return opts.expectJSON;
    }
    return false;
  })();
  const forceDefaultFallback = !!opts.forceDefaultViewFallback;
  const preferDefaultView = !!opts.preferDefaultView;
  const disableDefaultView = !!opts.disableDefaultViewFallback;

  const allowBody = opts.allowBody !== undefined
    ? !!opts.allowBody
    : (method !== 'GET' && method !== 'HEAD');

  const expectJSONFromContentType = (contentType) => {
    if (typeof opts.expectJSON === 'boolean') {
      return opts.expectJSON;
    }
    if (wantsJSON) return true;
    return typeof contentType === 'string' && /\bapplication\/([a-z0-9.+-]*json)\b/i.test(contentType);
  };

  const normalizeRaw = (value) => {
    if (typeof value === 'string') {
      return value;
    }
    if (value == null) {
      return '';
    }
    if (typeof value === 'object') {
      const decoded = decodeBufferToText(value, label);
      return decoded != null ? decoded : '';
    }
    return String(value);
  };

  const buildResult = (status, rawCandidate, jsonCandidate, expectJSON, contentType) => {
    const raw = normalizeRaw(rawCandidate);
    const ok = status >= 200 && status < 300;
    if (expectJSON) {
      const parsed = jsonCandidate !== undefined ? jsonCandidate : safeJSONParse(raw);
      if (parsed && typeof parsed === 'object') {
        return { ok, status, data: parsed, raw, contentType: contentType || null };
      }
      if (raw && typeof raw === 'string') {
        return { ok, status, data: raw, raw, contentType: contentType || null };
      }
      return { ok, status, data: parsed, raw, contentType: contentType || null };
    }
    return { ok, status, data: raw, raw, contentType: contentType || null };
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
    const headers = source.headers;
    if (headers && typeof headers === 'object') {
      const target = 'content-type';
      for (const key of Object.keys(headers)) {
        if (typeof key === 'string' && key.toLowerCase() === target) {
          const value = headers[key];
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
    return null;
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
      Zotero.debug(`${label} default-view fetch unavailable`);
      defaultViewCached = null;
      return null;
    }

    const fetchLabel = `${label} (default-view fallback)`;
    const fetchOptions = {
      method,
      credentials: 'include',
      headers: Object.assign({}, headers || {})
    };
    if (allowBody && body != null) {
      fetchOptions.body = body;
    }

    try {
      const response = await win.fetch(url, fetchOptions);
      let raw = '';
      if (typeof response.clone === 'function' && typeof response.arrayBuffer === 'function') {
        try {
          const buffer = await response.clone().arrayBuffer();
          raw = decodeBufferToText(buffer, fetchLabel) || raw;
        } catch (err) {
          Zotero.debug(`[fetch] ${fetchLabel} arrayBuffer error: ${err && err.message}`);
        }
      }
      if (!raw && typeof response.text === 'function') {
        try {
          const text = await response.text();
          if (text != null) {
            raw = text;
          }
        } catch (err) {
          Zotero.debug(`[fetch] ${fetchLabel} text error: ${err && err.message}`);
        }
      }
      if (!raw && typeof response.arrayBuffer === 'function' && !response.bodyUsed) {
        try {
          const buffer = await response.arrayBuffer();
          raw = decodeBufferToText(buffer, fetchLabel) || raw;
        } catch (err) {
          Zotero.debug(`[fetch] ${fetchLabel} arrayBuffer fallback error: ${err && err.message}`);
        }
      }
      const fallback = {
        ok: !!response.ok,
        status: typeof response.status === 'number' ? response.status : 0,
        raw,
        contentType: response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('content-type')
          : null
      };
      const fallbackExpectJSON = expectJSONFromContentType(fallback.contentType);
      const fallbackParsed = fallbackExpectJSON ? safeJSONParse(fallback.raw) : fallback.raw;
      defaultViewCached = buildResult(fallback.status || 0, fallback.raw, fallbackParsed, fallbackExpectJSON, fallback.contentType);
      return defaultViewCached;
    } catch (e) {
      Zotero.debug(`${fetchLabel} error: ${e && e.message}`);
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
    const seededJSON = payload.jsonCandidate !== undefined
      ? payload.jsonCandidate
      : (expectJSON ? safeJSONParse(raw) : undefined);
    const ok = status >= 200 && status < 300;
    if (expectJSON) {
      if (seededJSON && typeof seededJSON === 'object') {
        return { ok, status, data: seededJSON, raw, contentType };
      }
      if (typeof seededJSON === 'string' && seededJSON.length) {
        return { ok, status, data: seededJSON, raw, contentType };
      }
      return { ok, status, data: seededJSON, raw, contentType };
    }
    return { ok, status, data: raw, raw, contentType };
  };

  const runTransport = async (transportName, transportLabel, runner) => {
    try {
      const payload = await runner();
      const result = finalizePayload(payload);
      if (!result) return null;
      const expectJSON = expectJSONFromContentType(result.contentType);
      const promoted = await promoteResult(result, expectJSON);
      return promoted;
    } catch (e) {
      const msg = `${transportLabel} error: ${e && e.message}`;
      if (transportName === 'pageXHR') {
        Zotero.debug(`[scaffoldFetch-xhr-error] ${target}: ${e && e.message}`);
      } else {
        Zotero.debug(msg);
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
        const resp = await ZU.request(url, params);
        return {
          status: readStatus(resp),
          raw: readBody(resp),
          contentType: readContentType(resp),
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
        const xhr = await Zotero.HTTP.request(method, url, httpOpts);
        return {
          status: readStatus(xhr),
          raw: readBody(xhr),
          contentType: readContentType(xhr)
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
        xhr.open(method, url, true);
        const useCredentials = opts.credentials !== 'omit';
        if ('withCredentials' in xhr) {
          xhr.withCredentials = useCredentials;
        }
        for (const [key, value] of Object.entries(headers)) {
          if (value != null) {
            xhr.setRequestHeader(key, value);
          }
        }
        const response = await new Promise((resolve, reject) => {
          xhr.onload = () => resolve(xhr);
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.onabort = () => reject(new Error('Request aborted'));
          const payload = allowBody && body != null ? body : null;
          try {
            xhr.send(payload);
          } catch (err) {
            reject(err);
          }
        });
        return {
          status: readStatus(response),
          raw: readBody(response),
          contentType: readContentType(response)
        };
      }
    }
  ];

  for (const transport of transports) {
    const promoted = await runTransport(transport.name, transport.label, transport.runner);
    if (promoted) {
      return promoted;
    }
  }

  return { ok: false, status: 0, data: null, raw: '', contentType: null };
}
