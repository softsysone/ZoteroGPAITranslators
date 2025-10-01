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
			ZU.processDocuments(Object.keys(items), scrape);
		});
	}
	else {
		scrape(doc, url);
	}
}

// scrape handles data extraction for a single item page.
function scrape(doc, url) {
	// Create the new Zotero item with the appropriate type (e.g., "journalArticle").
	let item = new Zotero.Item('journalArticle');

	// TODO: Populate fields such as title, abstractNote, date, language, publicationTitle, etc.
	// Use ZU utilities (e.g., ZU.xpathText, ZU.trimInternal, ZU.strToISO) for consistency.
	item.title = ZU.trimInternal(text(doc, 'CSS SELECTOR FOR TITLE'));

	// Add creators using ZU.cleanAuthor for proper parsing.
	// Example: item.creators.push(ZU.cleanAuthor('Author Name', 'author'));

	// Attachments commonly include snapshots and PDFs.
	item.attachments.push({
		title: 'Snapshot',
		mimeType: 'text/html',
		document: doc
	});
	// Example PDF attachment:
	// item.attachments.push({
	// 	title: 'Full Text PDF',
	// 	url: 'https://example.com/article.pdf',
	// 	mimeType: 'application/pdf'
	// });

	// Optional: Collect tags, notes, or seeAlso references.

	item.complete();
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
