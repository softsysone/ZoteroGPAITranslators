{
	"translatorID": "6a86b35c-f06f-4c3a-a014-f7c1117c4ede",
	"label": "Gemini Chat",
	"creator": "Jacob J. Walker",
	"target": "^https?://gemini\\.google\\.com/(?:app(?:/c)?|share)/[A-Za-z0-9_-]",
	"minVersion": "5.0",
	"maxVersion": "",
	"priority": 100,
	"inRepository": true,
	"translatorType": 4,
	"browserSupport": "gcsibv",
	"lastUpdated": "2025-09-25 17:15:46"
}

/* Gemini Chat translator — v0.1.14
 * Based on the robust ChatGPT translator by Jacob J. Walker
 * Detect: URL (app/c/, share/) → instantMessage
 * Author: XPath (corporate), platform-first
 * Date: Targeted deep scan of embedded JSON for creation timestamp via conv ID
 * Attachment: snapshot
 * URL: prefer public /share/ link if found on page
 */

function detectWeb(doc, url) {
    // The regex now targets gemini.google.com for /app/c/, /app/, or /share/ paths followed by an ID
    const urlMatch = /https?:\/\/gemini\.google\.com\/(?:app(?:\/c)?|share)\/[A-Za-z0-9_-]+/i.test(url);
    return urlMatch ? "instantMessage" : false;
}

function doWeb(doc, url) {
    Zotero.debug("Gemini Chat doWeb v0.1.14");

    const item = new Zotero.Item("instantMessage");
    item.title = doc?.title || "Gemini Chat Conversation";

    const humanName = getHumanNameViaXPath(doc) || "User";
    item.creators = [
        { lastName: "Google Gemini", fieldMode: 1, creatorType: "author" },
        { lastName: humanName, fieldMode: 1, creatorType: "author" }
    ];

    // UPDATED: Use the new targeted deep scan function
    item.date = getConversationDate(doc, url) || new Date().toISOString().slice(0, 10);

    const shareURL = findShareURL(doc, url);
    if (shareURL && shareURL !== url) {
        item.url = shareURL;
        item.seeAlso = [url]; // keep the original private link for provenance
    } else {
        item.url = url;
    }

    item.libraryCatalog = "Google";

    item.attachments = [{ title: "Gemini Chat Conversation Snapshot", document: doc }];

    item.complete();
}

/* ------------------------------ Date Logic ------------------------------ */

function getConversationDate(doc, url) {
    Zotero.debug("[date] Attempting targeted deep JSON scan for creation timestamp...");
    try {
        const convIdMatch = url.match(/(?:app(?:\/c)?|share)\/([a-z0-9]+)/i);
        if (!convIdMatch || !convIdMatch[1]) {
            Zotero.debug("[date] Could not extract conversation ID from URL.");
            return null;
        }
        const convId = convIdMatch[1];
        Zotero.debug(`[date] Searching for anchor conversation ID: ${convId}`);

        const scripts = doc.querySelectorAll('script');
        for (const script of scripts) {
            // Find the specific script tag containing the main data model
            if (script.textContent && script.textContent.includes('__WIZ_global_data')) {
                const match = /__WIZ_global_data\s*=\s*({.*});/.exec(script.textContent);
                if (match && match[1]) {
                    const data = JSON.parse(match[1]);
                    // Recursively search the entire data object to find where the convId is located
                    const idLocation = findValueRecursive(data, convId);
                    
                    if (idLocation && idLocation.parent) {
                        // We found the ID. Now search its parent object for the timestamp.
                        Zotero.debug(`[date] Found conversation ID anchor at path: ${idLocation.path.join('.')}`);
                        // Google often stores creation timestamps in a [seconds, nanoseconds] array.
                        const timestampLocation = findTimestampInObject(idLocation.parent);
                        
                        if (timestampLocation) {
                            const timestamp = timestampLocation.value[0]; // Get seconds
                            const d = new Date(timestamp * 1000);
                            if (!isNaN(d)) {
                                Zotero.debug(`[date] Found and parsed Unix timestamp via targeted search: ${d.toISOString()}`);
                                return d.toISOString().slice(0, 10);
                            }
                        }
                    }
                }
            }
        }
    } catch (e) {
        Zotero.debug(`[date] Error during targeted deep JSON scan: ${e && e.message}`);
    }
    Zotero.debug(`[date] No valid date found, will fall back to current date.`);
    return null;
}

// Helper to find a specific value and return its context (parent object and path)
function findValueRecursive(obj, value, path = []) {
    if (obj === value) {
        return { value: obj, parent: null, path };
    }
    if (obj === null || typeof obj !== 'object') {
        return null;
    }

    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const currentPath = [...path, key];
            if (obj[key] === value) {
                return { value: obj[key], parent: obj, path: currentPath };
            }
            const result = findValueRecursive(obj[key], value, currentPath);
            if (result) return result;
        }
    }
    return null;
}

// Helper to find the first plausible timestamp structure within a given object
function findTimestampInObject(obj) {
    if (obj === null || typeof obj !== 'object') return null;

    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const value = obj[key];
            // Look for the specific [seconds, nanoseconds] array structure
            if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && String(value[0]).length === 10) {
                return { key, value, parent: obj };
            }
            if (typeof value === 'object') {
                const result = findTimestampInObject(value);
                if (result) return result;
            }
        }
    }
    return null;
}


/* ---------------------------- Author (XPath) ---------------------------- */

function getHumanNameViaXPath(doc) {
    // Using the user-provided, more specific XPath first,
    // with the generic one as a fallback.
    const xpaths = [
        '//*[@id="gb"]/div/div[1]/div[2]/div/a', // User-provided specific path
        '//*[@aria-label and starts-with(@aria-label, "Google Account:")]' // Generic fallback
    ];
    const rawValue = textByXPaths(doc, xpaths, true); // Get attribute value

    if (rawValue) {
        // The aria-label is "Google Account: Jacob J. Walker (email@...)". We need to extract the name.
        const match = rawValue.match(/Google Account:\s*([^(\n]+)/);
        if (match && match[1]) {
            const extractedName = match[1].trim();
            Zotero.debug(`[author:xpath] Extracted "${extractedName}"`);
            return extractedName;
        }
    }
    return null;
}

/* ---------------------------- Share URL logic --------------------------- */

// This entire section is kept from your original code, with only the URL-matching regex updated.
// The logic of checking anchors, data attributes, and scripts is excellent and universal.

function findShareURL(doc, currentURL) {
    try {
        if (/\/share\//i.test(currentURL)) return currentURL;

        const a = Array.from(doc.querySelectorAll('a[href*="/share/"]'))
            .map(el => el.getAttribute('href')).filter(Boolean);
        const aAbs = a.map(href => absolutize(doc, href)).filter(isShareURL);
        if (aAbs.length) {
            Zotero.debug(`[share] anchor found: ${aAbs[0]}`);
            return aAbs[0];
        }

        const clipboardCandidates = [];
        doc.querySelectorAll('[data-clipboard-text],[data-share-url],[value]').forEach(el => {
            const v1 = el.getAttribute('data-clipboard-text');
            const v2 = el.getAttribute('data-share-url');
            const v3 = el.getAttribute('value');
            [v1, v2, v3].forEach(v => { if (v) clipboardCandidates.push(v); });
        });
        const clipAbs = clipboardCandidates.map(s => absolutize(doc, s)).filter(isShareURL);
        if (clipAbs.length) {
            Zotero.debug(`[share] clipboard/data attr found: ${clipAbs[0]}`);
            return clipAbs[0];
        }

        const scripts = Array.from(doc.querySelectorAll('script'))
            .map(s => (s.textContent || '').slice(0, 400000)).join('\n');
        // ADAPTED: Regex for Gemini share links
        const re = /\bhttps?:\/\/gemini\.google\.com\/share\/[A-Za-z0-9_-]+/g;
        const hits = scripts.match(re) || [];
        if (hits.length) {
            Zotero.debug(`[share] script match: ${hits[0]}`);
            return hits[0];
        }
    } catch (e) {
        Zotero.debug(`[share] error: ${e && e.message}`);
    }
    return null;
}

function isShareURL(u) {
    // ADAPTED: Regex for Gemini share links
    return typeof u === 'string' &&
        /^https?:\/\/gemini\.google\.com\/share\/[A-Za-z0-9_-]+/i.test(u);
}

function absolutize(doc, href) {
    try {
        if (!href) return null;
        const u = new URL(href, doc.location?.href || undefined);
        return u.toString();
    } catch (_) {
        return null;
    }
}

/* ------------------------------ Utilities ------------------------------ */

function textByXPaths(root, xps, getAttribute) {
    for (const xp of xps) {
        try {
            const res = (root.ownerDocument || root).evaluate(
                xp, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            );
            const node = res.singleNodeValue;
            if (node) {
                if (getAttribute) {
                    const attr = node.getAttribute('aria-label');
                    if (attr) return attr.trim();
                } else {
                    const t = (node.textContent || '').trim();
                    if (t) return t;
                }
            }
        } catch (e) {
            Zotero.debug(`[xpath] error for ${xp}: ${e && e.message}`);
        }
    }
    return null;
}

/** BEGIN TEST CASES **/
var testCases = [
]
/** END TEST CASES **/
