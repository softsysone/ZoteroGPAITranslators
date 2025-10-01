{
	"translatorID": "00000000-0000-0000-0000-000000000000",
	"label": "Translator Name",
	"creator": "Your Name",
	"target": "^https?://example\.com/",
	"minVersion": "5.0",
	"maxVersion": "",
	"priority": 100,
	"inRepository": false,
	"translatorType": 4,
	"browserSupport": "gcsibv",
	"lastUpdated": "1970-01-01 00:00:00"
}

/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © YEAR Your Name

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

// NOTE: This pattern covers the most common structure of web translators.
// Update placeholder values above and fill in the functions below when creating a new translator.

// detectWeb identifies what type of item the current page represents.
// Return "multiple" for search result pages, item types (e.g., "journalArticle") for single records, or false if unsupported.
function detectWeb(doc, url) {
	// TODO: Inspect the document (DOM, URL, meta tags, etc.) to determine the Zotero item type.
	// Example checks: doc.querySelector selectors, regex tests on the URL, or metadata flags.
	return false;
}

// Helper to collect candidate items on search or listing pages.
function getSearchResults(doc, checkOnly) {
	var items = {};
	var found = false;
	// TODO: Select relevant link elements representing individual records.
	var rows = doc.querySelectorAll('CSS SELECTOR FOR LINKS');
	for (let row of rows) {
		let href = row.href;
		let title = ZU.trimInternal(row.textContent);
		if (!href || !title) continue;
		if (checkOnly) return true;
		found = true;
		items[href] = title;
	}
	return found ? items : false;
}

// doWeb orchestrates saving based on the result of detectWeb.
function doWeb(doc, url) {
	if (detectWeb(doc, url) == 'multiple') {
		Zotero.selectItems(getSearchResults(doc, false), function (items) {
			if (!items) return;
			ZU.processDocuments(Object.keys(items), getItem);
		});
	}
	else {
		getItem(doc, url);
	}
}

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

	// TODO: Populate additional fields such as abstractNote, language,
	// publicationTitle, etc. Use ZU utilities (e.g., ZU.xpathText,
	// ZU.trimInternal, ZU.strToISO) for consistency.

	// Attachments commonly include snapshots and PDFs.
	for (let attachment of getAttachments(doc, url)) {
		item.attachments.push(attachment);
	}

	// Optional: Collect tags, notes, or seeAlso references.

	item.complete();
}

function getType(doc, url) {
	// TODO: Inspect the document or URL to determine the correct Zotero item type.
	return 'journalArticle';
}

function getTitle(doc, url) {
	// TODO: Replace with a selector or extraction logic that returns the item title.
	return ZU.trimInternal(text(doc, 'CSS SELECTOR FOR TITLE'));
}

function getAuthors(doc, url) {
	// TODO: Extract author information and return an array of creator objects.
	// Example implementation:
	// return [ZU.cleanAuthor('Author Name', 'author')];
	return [];
}

function getDate(doc, url) {
	// TODO: Return an ISO-formatted date string when available.
	return '';
}

function getURL(doc, url) {
	// TODO: Return the canonical URL for the item.
	return url;
}

function getExtra(doc, url) {
	// TODO: Populate the extra field as needed.
	return '';
}

function getAttachments(doc, url) {
	// TODO: Return an array of attachment objects. For example:
	return [{
		title: 'Snapshot',
		mimeType: 'text/html',
		document: doc
	}];
	// Example PDF attachment:
	// return [{
	// 	title: 'Full Text PDF',
	// 	url: 'https://example.com/article.pdf',
	// 	mimeType: 'application/pdf'
	// }];
}

/** BEGIN TEST CASES **/
var testCases = [
	{
		"type": "web",
		"url": "https://example.com/path/to/item",
		"items": [
			{
				"itemType": "journalArticle",
				"title": "Example Title",
				"creators": [
					{
						"firstName": "First",
						"lastName": "Author",
						"creatorType": "author"
					}
				],
				"date": "2024-01-01",
				"abstractNote": "",
				"language": "en",
				"libraryCatalog": "example.com",
				"shortTitle": "",
				"url": "https://example.com/path/to/item",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [],
				"notes": [],
				"seeAlso": []
			}
		]
	}
];
