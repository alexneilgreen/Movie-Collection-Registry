// ══════════════════════════════════════════════
//  CONSTANTS & LOOKUPS
// ══════════════════════════════════════════════
const FORMAT_MAP = {
	"4k":     { class: "badge-4k",     label: "4K UHD"  },
	"bluray": { class: "badge-bluray", label: "Blu-ray" },
	"dvd":    { class: "badge-dvd",    label: "DVD"     }
};

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
let data = loadState();
let editingEntry  = null;
let isBoxSet      = false;
let isDigitized   = false;
let isOwned       = true;
let subfilmCount  = 0;

// ══════════════════════════════════════════════
//  DATA UTILITIES
// ══════════════════════════════════════════════
function sortKey(title) {
	return title.replace(/^(The|A|An)\s+/i, "").toLowerCase();
}

function sortData(d) {
	d.categories.sort((a, b) => a.name.localeCompare(b.name));
	d.categories.forEach((cat) => {
		cat.entries.sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)));
	});
	return d;
}

function cleanEmptyCategories() {
	data.categories = data.categories.filter((cat) => cat.entries && cat.entries.length > 0);
}

function migrateEntries(d) {
	d.categories.forEach((cat) => {
		cat.entries.forEach((entry) => {
			if (!entry.format)                   entry.format     = "4k";
			if (entry.digitized === undefined)   entry.digitized  = false;
			if (entry.owned     === undefined)   entry.owned      = true;
			if (entry.fileSizeGb === undefined)  entry.fileSizeGb = null;
		});
	});
	return d;
}

// Strip in-memory wikiData cache before any serialization —
// only the wikiUrl link is kept (inside entry.wikiData.wikiUrl / film.wikiData.wikiUrl)
function stripWikiData(d) {
	return {
		...d,
		categories: d.categories.map(cat => ({
			...cat,
			entries: cat.entries.map(entry => {
				const { wikiData, ...rest } = entry;
				return {
					...rest,
					...(entry.films ? {
						films: entry.films.map(f => {
							const { wikiData: fw, ...frest } = f;
							return frest;
						})
					} : {})
				};
			})
		}))
	};
}

// ══════════════════════════════════════════════
//  PERSISTENCE
// ══════════════════════════════════════════════
function loadState() {
	try {
		const saved = localStorage.getItem("4k-collection");
		if (saved) {
			const parsed = JSON.parse(saved);
			if (parsed && parsed.categories && parsed.categories.length > 0) {
				return sortData(migrateEntries(parsed));
			}
		}
	} catch (e) {}
	return sortData(migrateEntries(JSON.parse(JSON.stringify(movieData))));
}

function saveState() {
	cleanEmptyCategories();
	sortData(data);
	localStorage.setItem("4k-collection", JSON.stringify(stripWikiData(data)));
	render();
	showToast("Collection saved to local storage");
}

function exportJS() {
	cleanEmptyCategories();
	sortData(data);
	render();

	const content = `// 4K UHD Blu-ray Collection Data\n// Auto-exported from collection manager\n\nconst movieData = ${JSON.stringify(stripWikiData(data), null, 2)};\n\nif (typeof module !== 'undefined') module.exports = movieData;\n`;
	const blob = new Blob([content], { type: "application/javascript" });
	const a    = document.createElement("a");
	a.href     = URL.createObjectURL(blob);
	a.download = "movies.js";
	a.click();
	URL.revokeObjectURL(a.href);
	showToast("movies.js downloaded");
}

// ══════════════════════════════════════════════
//  WIKIPEDIA — LRU CACHE
// ══════════════════════════════════════════════
const _wikiLRUOrder = [];

function wikiLRUTouch(subject, capSize) {
	const idx = _wikiLRUOrder.indexOf(subject);
	if (idx !== -1) _wikiLRUOrder.splice(idx, 1);
	_wikiLRUOrder.push(subject);

	while (_wikiLRUOrder.length > capSize) {
		const evicted = _wikiLRUOrder.shift();
		evicted.wikiData = undefined;
	}
}

// ══════════════════════════════════════════════
//  WIKIPEDIA — FETCH
// ══════════════════════════════════════════════
async function fetchWikiData(title, year, savedWikiUrl = null) {

	async function attemptSearch(queryTitle) {
		const htmlUrl    = `https://en.wikipedia.org/w/api.php?action=parse&prop=text&format=json&origin=*&redirects=1&page=${encodeURIComponent(queryTitle)}`;
		const summaryUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&origin=*&redirects=1&titles=${encodeURIComponent(queryTitle)}`;

		try {
			const [htmlRes, summaryRes] = await Promise.all([
				fetch(htmlUrl).then(r => r.json()),
				fetch(summaryUrl).then(r => r.json())
			]);

			if (htmlRes.error || !htmlRes.parse?.text?.["*"]) return null;

			const pages  = summaryRes.query?.pages;
			const pageId = pages ? Object.keys(pages)[0] : "-1";
			if (pageId === "-1") return null;
			const extract = pages[pageId].extract;
			if (!extract) return null;

			const parser  = new DOMParser();
			const doc     = parser.parseFromString(htmlRes.parse.text["*"], "text/html");
			const infobox = doc.querySelector(".infobox");

			let poster = null, director = null, release = null, runtime = null;
			let starring = null, cinematography = null, music = null;

			if (infobox) {
				// Score every infobox image and pick the best poster candidate
				const imgs = Array.from(infobox.querySelectorAll("img"));
				let bestScore = -1;
				for (const img of imgs) {
					let src = img.getAttribute("src") || "";
					if (!src) continue;
					const sizeMatch = src.match(/\/(\d+)px-/);
					const renderedW = sizeMatch ? parseInt(sizeMatch[1]) : 0;
					if (renderedW > 0 && renderedW < 60) continue;
					if (/flag|logo|icon|signature|seal|symbol|map|ribbon|commons/i.test(src)) continue;

					let score = 0;
					if (renderedW >= 200) score += 3;
					else if (renderedW >= 100) score += 1;
					if (imgs.indexOf(img) === 0) score += 2;
					if (/film|poster|cover|movie|sheet/i.test(src)) score += 2;

					if (score > bestScore) {
						bestScore = score;
						src = src.replace(/\/thumb(\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+)\/[^/]+$/, "$1");
						src = src.replace(/\/\d+px-[^/]+$/, "");
						poster = src.startsWith("//") ? "https:" + src : src;
					}
				}

				infobox.querySelectorAll("tr").forEach(row => {
					const th = row.querySelector("th[scope='row']") || row.querySelector("th");
					const td = row.querySelector("td");
					if (!th || !td) return;

					const header    = th.textContent.replace(/\s+/g, " ").trim().toLowerCase();
					const listItems = td.querySelectorAll("li");
					const cleanText = listItems.length
						? Array.from(listItems).map(li => li.textContent.replace(/\[\d+\]/g, "").trim()).join(", ")
						: td.textContent.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();

					if (header.includes("directed by") || header === "director") {
						director = cleanText;
					} else if (header.includes("release")) {
						const dateMatch = cleanText.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}|\b\d{4}\b/);
						release = dateMatch ? dateMatch[0] : cleanText.split(/\s{2,}/)[0];
					} else if (header.includes("running time") || header.includes("runtime")) {
						runtime = cleanText;
					} else if (header.includes("starring")) {
						starring = cleanText;
					} else if (header.includes("cinematography") || header.includes("director of photography")) {
						cinematography = cleanText;
					} else if (header.includes("music by") || header === "music") {
						music = cleanText;
					}
				});
			}

			const resolvedTitle = htmlRes.parse?.title || queryTitle;
			const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(resolvedTitle.replace(/ /g, "_"))}`;
			return { synopsis: extract || "No synopsis available.", poster, director, release, runtime, starring, cinematography, music, wikiUrl };
		} catch (err) {
			console.warn(`Wiki fetch failed for: ${queryTitle}`, err);
			return null;
		}
	}

	// If a saved URL exists, fetch from that page directly
	if (savedWikiUrl) {
		const match = savedWikiUrl.match(/wikipedia\.org\/wiki\/(.+)$/);
		if (match) {
			const pageTitle = decodeURIComponent(match[1]);
			const result    = await attemptSearch(pageTitle);
			if (result) return { ...result, wikiUrl: savedWikiUrl };
		}
	}

	// Fall back to title/year search
	const queriesToTry = [];
	if (year) queriesToTry.push(`${title} (${year} film)`);
	queriesToTry.push(`${title} (film)`);
	queriesToTry.push(title);

	for (const query of queriesToTry) {
		const result = await attemptSearch(query);
		if (result) return result;
	}
	return null;
}

// ══════════════════════════════════════════════
//  DROPDOWNS
// ══════════════════════════════════════════════
function buildDropdown(selectId, optionsArray, clearFirst = false, defaultVal = null) {
	const sel = document.getElementById(selectId);
	if (!sel) return;
	if (!clearFirst && sel.options.length > 0) return;
	if (clearFirst) sel.innerHTML = "";

	optionsArray.forEach(([val, text]) => {
		const opt       = document.createElement("option");
		opt.value       = val;
		opt.textContent = text;
		sel.appendChild(opt);
	});

	if (defaultVal !== null) sel.value = defaultVal;
}

function initStaticDropdowns() {
	buildDropdown("filter-sort",   [["alpha", "Alphabetical"], ["chrono", "Chronological"]]);
	buildDropdown("filter-digi",   [["all", "All"], ["yes", "On Drive"], ["no", "Not on Drive"]]);
	buildDropdown("filter-format", [["all", "All Formats"], ["4k", "4K UHD"], ["bluray", "Blu-ray"], ["dvd", "DVD"]]);
	buildDropdown("filter-owned",  [["all", "All"], ["yes", "Owned"], ["no", "Wishlist"]]);
}

function populateCategoryFilter() {
	const current = document.getElementById("filter-cat").value;
	const options = [["", "All Categories"], ...data.categories.map(cat => [cat.id, cat.name])];
	buildDropdown("filter-cat", options, true, current);
	if (!current) document.getElementById("filter-cat").value = "";
}

function populateModalCategorySelect(selectedId) {
	const options = [...data.categories.map(cat => [cat.id, cat.name]), ["__new__", "+ New category…"]];
	buildDropdown("f-category", options, true, selectedId);
}

// ══════════════════════════════════════════════
//  MODAL INFRASTRUCTURE
// ══════════════════════════════════════════════
function openModal(modalId) {
	document.getElementById(modalId).classList.add("open");
}

function closeModal(modalId) {
	document.getElementById(modalId).classList.remove("open");
}

function initModalControllers() {
	document.querySelectorAll(".modal-overlay, .suggest-overlay").forEach(overlay => {
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) overlay.classList.remove("open");
		});
	});

	document.querySelectorAll(".modal-close, [id$='-cancel']").forEach(btn => {
		btn.addEventListener("click", (e) => {
			const modal = e.target.closest(".modal-overlay, .suggest-overlay");
			if (modal) modal.classList.remove("open");
		});
	});
}

// ══════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════
function render() {
	const search      = document.getElementById("search").value.toLowerCase().trim();
	const filterCat   = document.getElementById("filter-cat").value;
	const filterDigi  = document.getElementById("filter-digi").value;
	const filterFormat= document.getElementById("filter-format").value;
	const filterOwned = document.getElementById("filter-owned").value;
	const sortMode    = document.getElementById("filter-sort").value;

	populateCategoryFilter();

	const collectionEl = document.getElementById("collection");
	collectionEl.innerHTML = "";

	let totalEntries = 0, totalFilms = 0, totalSets = 0;
	let entryNum  = 1;
	let anyVisible = false;

	data.categories.forEach((cat) => {
		if (filterCat && cat.id !== filterCat) return;

		let entries = cat.entries.filter((entry) => {
			if (filterDigi   === "yes" && !entry.digitized) return false;
			if (filterDigi   === "no"  && entry.digitized)  return false;
			if (filterFormat !== "all" && entry.format !== filterFormat) return false;
			if (filterOwned  === "yes" && !entry.owned) return false;
			if (filterOwned  === "no"  && entry.owned)  return false;
			if (!search) return true;
			if (entry.title.toLowerCase().includes(search)) return true;
			if (entry.films) return entry.films.some((f) => f.title.toLowerCase().includes(search));
			return false;
		});

		if (entries.length === 0) return;

		if (sortMode === "chrono") {
			entries = [...entries].sort((a, b) => {
				if (a.year == null && b.year == null) return 0;
				if (a.year == null) return 1;
				if (b.year == null) return -1;
				return a.year - b.year;
			});
		}

		anyVisible = true;
		totalEntries += entries.length;
		entries.forEach((e) => {
			if (e.isBoxSet && e.films) totalFilms += e.films.length;
			else totalFilms++;
			if (e.isBoxSet) totalSets++;
		});

		const catEl = document.createElement("div");
		catEl.className    = "category";
		catEl.dataset.catId = cat.id;
		catEl.innerHTML = `
			<div class="category-header flex-between">
				<span class="category-name">${cat.name}</span>
				<span class="category-count">${entries.length} ${entries.length === 1 ? "entry" : "entries"}</span>
			</div>
			<div class="entries-grid"></div>
		`;

		const grid = catEl.querySelector(".entries-grid");
		entries.forEach((entry) => {
			grid.appendChild(buildEntryCard(entry, cat.id, entryNum));
			entryNum++;
		});

		collectionEl.appendChild(catEl);
	});

	if (!anyVisible) {
		collectionEl.innerHTML = `<div class="no-results"><strong>◎</strong>No results found</div>`;
	}

	document.getElementById("stats").innerHTML = `
		<span><strong>${totalEntries}</strong> entries</span>
		<span><strong>${totalFilms}</strong> individual films</span>
		<span><strong>${totalSets}</strong> box sets</span>
		<span><strong>${data.categories.length}</strong> categories</span>
	`;
}

function buildEntryCard(entry, catId, num) {
	const template = document.getElementById("tmpl-entry-card");
	const clone    = template.content.cloneNode(true);
	const card     = clone.querySelector(".entry-card");

	card.dataset.entryId = entry.id;
	card.dataset.catId   = catId;
	if (entry.isBoxSet) card.classList.add("is-boxset");

	clone.querySelector(".entry-title").textContent = entry.title;

	const yearStr     = entry.year ? `<span>${entry.year}</span>` : "";
	const boxBadge    = entry.isBoxSet ? `<span class="badge-boxset">Set</span>` : "";
	const fmt         = FORMAT_MAP[entry.format || "4k"] || FORMAT_MAP["4k"];
	const formatBadge = `<span class="badge-format ${fmt.class}">${fmt.label}</span>`;
	const sizeBadge   = entry.fileSizeGb != null
		? `<span style="font-size:10px;font-family:'DM Mono',monospace;color:var(--text3);margin-left:auto;">${entry.fileSizeGb} GB</span>`
		: "";

	clone.querySelector(".entry-meta").innerHTML = `${yearStr}${formatBadge}${boxBadge}<span style="flex:1;"></span>${sizeBadge}`;

	// No poster displayed on card
	clone.querySelector(".entry-poster-wrap").style.display = "none";

	// Wire up action buttons
	clone.querySelectorAll(".entry-select-check, .btn-info, .btn-edit, .btn-delete").forEach(el => {
		el.dataset.entryId = entry.id;
		el.dataset.catId   = catId;
	});

	// Subfilms list
	if (entry.isBoxSet && entry.films && entry.films.length) {
		const subfilmsHTML = entry.films.map(f =>
			`<div class="subfilm flex-row"><span style="flex:1">${f.title}</span><span class="subfilm-year">${f.year || ""}</span></div>`
		).join("");
		card.insertAdjacentHTML("beforeend", `<div class="subfilms">${subfilmsHTML}</div>`);
	}

	// Card footer
	const owned = entry.owned !== false;
	const digi  = !!entry.digitized;
	let linksHTML = "";
	if (entry.links?.amazon || entry.links?.bestbuy) {
		linksHTML += `<div style="display:flex;gap:6px;margin-left:auto;">`;
		if (entry.links.amazon)  linksHTML += `<a class="link-btn link-amazon"  href="${entry.links.amazon}"  target="_blank" rel="noopener">Amazon</a>`;
		if (entry.links.bestbuy) linksHTML += `<a class="link-btn link-bestbuy" href="${entry.links.bestbuy}" target="_blank" rel="noopener">Best Buy</a>`;
		linksHTML += `</div>`;
	}

	card.insertAdjacentHTML("beforeend", `
		<div class="card-footer flex-between">
			<button class="digitized-btn owned-toggle ${owned ? "yes" : "no"}" data-entry-id="${entry.id}" data-cat-id="${catId}" title="${owned ? "Mark as not owned" : "Mark as owned"}">
				<span class="digitized-dot"></span>${owned ? "Owned" : "Wishlist"}
			</button>
			<button class="digitized-btn digi-toggle ${digi ? "yes" : "no"}" data-entry-id="${entry.id}" data-cat-id="${catId}" title="${digi ? "Mark as not copied" : "Mark as copied to drive"}">
				<span class="digitized-dot"></span>${digi ? "On Drive" : "Not on Drive"}
			</button>
			${linksHTML}
		</div>
	`);

	return card;
}

// ══════════════════════════════════════════════
//  MODAL — ADD / EDIT FILM
// ══════════════════════════════════════════════

// Rebuild the box set wiki-link inputs at the bottom of the modal.
// Called whenever the subfilm list changes (add row, remove row, toggle boxset).
function syncBoxSetWikiLinks(films = []) {
	const list = document.getElementById("f-wiki-boxset-list");
	list.innerHTML = "";

	films.forEach((film, i) => {
		const row      = document.createElement("div");
		row.className  = "wiki-link-row";
		row.dataset.filmIndex = i;

		const label      = document.createElement("span");
		label.className  = "wiki-link-label";
		label.textContent = film.title || `Film ${i + 1}`;

		const input         = document.createElement("input");
		input.className     = "form-input";
		input.dataset.wikiIndex = i;
		input.placeholder   = "https://en.wikipedia.org/wiki/…";
		input.value         = film.wikiUrl || "";

		row.appendChild(label);
		row.appendChild(input);
		list.appendChild(row);
	});
}

// Read current subfilm titles/years from the builder and refresh the wiki-link list,
// preserving any URLs the user has already typed.
function refreshBoxSetWikiLinks() {
	const list       = document.getElementById("f-wiki-boxset-list");
	const existingUrls = {};
	list.querySelectorAll("input[data-wiki-index]").forEach(inp => {
		existingUrls[inp.dataset.wikiIndex] = inp.value.trim();
	});

	const rows = document.querySelectorAll("#subfilms-builder .subfilm-row");
	const films = [];
	rows.forEach((row, i) => {
		films.push({
			title:   row.querySelector(".sf-title").value.trim() || `Film ${i + 1}`,
			wikiUrl: existingUrls[i] || ""
		});
	});

	syncBoxSetWikiLinks(films);
}

function openAddModal() {
	editingEntry = null;
	isBoxSet     = false;
	isDigitized  = false;
	isOwned      = true;
	subfilmCount = 0;

	document.getElementById("modal-entry-title").textContent  = "Add Film";
	document.getElementById("modal-entry-save").textContent   = "Save Film";
	document.querySelector("#modal-entry .modal").classList.remove("boxset-wide");

	document.getElementById("f-title").value          = "";
	document.getElementById("f-year").value           = "";
	document.getElementById("f-amazon").value         = "";
	document.getElementById("f-bestbuy").value        = "";
	document.getElementById("f-format").value         = "4k";
	document.getElementById("f-filesize").value       = "";
	document.getElementById("f-filesize-single").value = "";
	document.getElementById("f-wiki").value           = "";

	document.getElementById("f-owned-toggle").classList.add("on");
	document.getElementById("f-owned-label").textContent      = "Yes";
	document.getElementById("f-digitized-toggle").classList.remove("on");
	document.getElementById("f-digitized-label").textContent  = "No";
	document.getElementById("f-boxset-toggle").classList.remove("on");
	document.getElementById("f-boxset-label").textContent     = "No";

	document.getElementById("subfilms-builder").innerHTML = "";
	document.getElementById("f-wiki-boxset-list").innerHTML  = "";

	document.getElementById("f-subfilms-wrap").classList.add("d-none");
	document.getElementById("f-singlesize-wrap").classList.remove("d-none");
	document.getElementById("f-wiki-single-wrap").classList.remove("d-none");
	document.getElementById("f-wiki-boxset-wrap").classList.add("d-none");

	populateModalCategorySelect(data.categories[0]?.id);
	openModal("modal-entry");
	document.getElementById("f-title").focus();
}

function openEditModal(catId, entryId) {
	const cat   = data.categories.find((c) => c.id === catId);
	const entry = cat?.entries.find((e) => e.id === entryId);
	if (!entry) return;

	editingEntry = { catId, entryId };
	isBoxSet     = !!entry.isBoxSet;
	isDigitized  = !!entry.digitized;
	isOwned      = entry.owned !== false;
	subfilmCount = 0;

	document.getElementById("modal-entry-title").textContent  = "Edit Film";
	document.getElementById("modal-entry-save").textContent   = "Update Film";
	document.querySelector("#modal-entry .modal").classList.toggle("boxset-wide", isBoxSet);

	document.getElementById("f-title").value   = entry.title;
	document.getElementById("f-year").value    = entry.year || "";
	document.getElementById("f-amazon").value  = entry.links?.amazon  || "";
	document.getElementById("f-bestbuy").value = entry.links?.bestbuy || "";
	document.getElementById("f-format").value  = entry.format || "4k";

	document.getElementById("f-owned-toggle").classList.toggle("on", isOwned);
	document.getElementById("f-owned-label").textContent     = isOwned    ? "Yes" : "No";
	document.getElementById("f-digitized-toggle").classList.toggle("on", isDigitized);
	document.getElementById("f-digitized-label").textContent = isDigitized ? "Yes" : "No";
	document.getElementById("f-boxset-toggle").classList.toggle("on", isBoxSet);
	document.getElementById("f-boxset-label").textContent    = isBoxSet   ? "Yes" : "No";

	document.getElementById("subfilms-builder").innerHTML = "";

	if (isBoxSet) {
		document.getElementById("f-subfilms-wrap").classList.remove("d-none");
		document.getElementById("f-singlesize-wrap").classList.add("d-none");
		document.getElementById("f-wiki-single-wrap").classList.add("d-none");
		document.getElementById("f-wiki-boxset-wrap").classList.remove("d-none");
		document.getElementById("f-filesize").value = entry.fileSizeGb != null ? entry.fileSizeGb : "";

		(entry.films || []).forEach((f) => addSubfilmRow(f.title, f.year, f.fileSizeGb || ""));

		// Populate per-film wiki URLs from saved data
		const wikiFilms = (entry.films || []).map(f => ({
			title:   f.title,
			wikiUrl: f.wikiData?.wikiUrl || ""
		}));
		syncBoxSetWikiLinks(wikiFilms);
	} else {
		document.getElementById("f-subfilms-wrap").classList.add("d-none");
		document.getElementById("f-singlesize-wrap").classList.remove("d-none");
		document.getElementById("f-wiki-single-wrap").classList.remove("d-none");
		document.getElementById("f-wiki-boxset-wrap").classList.add("d-none");
		document.getElementById("f-filesize-single").value = entry.fileSizeGb != null ? entry.fileSizeGb : "";
		document.getElementById("f-wiki").value            = entry.wikiData?.wikiUrl || "";
	}

	populateModalCategorySelect(catId);
	openModal("modal-entry");
	document.getElementById("f-title").focus();
}

function recalcSetSize() {
	let sum = 0;
	document.querySelectorAll("#subfilms-builder .subfilm-row .sf-size").forEach((inp) => {
		const v = parseFloat(inp.value);
		if (!isNaN(v)) sum += v;
	});
	document.getElementById("f-filesize").value = sum > 0 ? sum.toFixed(2) : "";
}

function addSubfilmRow(titleVal = "", yearVal = "", sizeVal = "") {
	const id = ++subfilmCount;

	const template = document.getElementById("tmpl-subfilm-row");
	const clone    = template.content.cloneNode(true);
	const row      = clone.querySelector(".subfilm-row");

	row.dataset.subId = id;
	row.querySelector(".sf-title").value = titleVal;
	row.querySelector(".sf-year").value  = yearVal;
	row.querySelector(".sf-size").value  = sizeVal;

	row.querySelector(".remove-subfilm").addEventListener("click", () => {
		row.remove();
		recalcSetSize();
		refreshBoxSetWikiLinks();
	});
	row.querySelector(".sf-size").addEventListener("input", recalcSetSize);
	// Refresh wiki-link labels when title changes
	row.querySelector(".sf-title").addEventListener("input", refreshBoxSetWikiLinks);

	document.getElementById("subfilms-builder").appendChild(clone);
}

function saveEntryModal() {
	const title = document.getElementById("f-title").value.trim();
	if (!title) return showToast("Please enter a title", "⚠");

	const catId = document.getElementById("f-category").value;
	if (catId === "__new__") return showToast("Please select or create a category", "⚠");

	const year    = parseInt(document.getElementById("f-year").value) || null;
	const amazon  = document.getElementById("f-amazon").value.trim();
	const bestbuy = document.getElementById("f-bestbuy").value.trim();
	const format  = document.getElementById("f-format").value;

	// Retrieve old entry for wikiData cache preservation
	let oldEntry = null;
	if (editingEntry) {
		const oldCatData = data.categories.find((c) => c.id === editingEntry.catId);
		oldEntry = oldCatData?.entries.find((e) => e.id === editingEntry.entryId) || null;
	}

	let films      = null;
	let fileSizeGb = null;

	if (isBoxSet) {
		// Collect wiki URLs from the bottom links section (indexed by film position)
		const wikiInputs = {};
		document.querySelectorAll("#f-wiki-boxset-list input[data-wiki-index]").forEach(inp => {
			wikiInputs[parseInt(inp.dataset.wikiIndex)] = inp.value.trim() || null;
		});

		films = [];
		document.querySelectorAll("#subfilms-builder .subfilm-row").forEach((row, i) => {
			const t = row.querySelector(".sf-title").value.trim();
			const y = parseInt(row.querySelector(".sf-year").value) || null;
			const s = parseFloat(row.querySelector(".sf-size").value) || null;
			const w = wikiInputs[i] || null;

			if (t) {
				const oldFilm          = oldEntry?.films?.[i] || null;
				const existingWikiData = oldFilm?.wikiData    || null;
				const urlChanged       = w && w !== existingWikiData?.wikiUrl;
				const mergedWikiData   = w
					? (urlChanged ? { wikiUrl: w } : { ...(existingWikiData || {}), wikiUrl: w })
					: existingWikiData;

				films.push({
					title: t, year: y, fileSizeGb: s,
					...(mergedWikiData ? { wikiData: mergedWikiData } : {})
				});
			}
		});

		fileSizeGb = parseFloat(document.getElementById("f-filesize").value) || null;
	} else {
		fileSizeGb = parseFloat(document.getElementById("f-filesize-single").value) || null;
	}

	// Standalone wiki URL
	const wikiUrl          = isBoxSet ? null : (document.getElementById("f-wiki").value.trim() || null);
	const existingWikiData = oldEntry?.wikiData || null;
	const urlChanged       = wikiUrl && wikiUrl !== existingWikiData?.wikiUrl;
	const mergedWikiData   = wikiUrl
		? (urlChanged ? { wikiUrl } : { ...(existingWikiData || {}), wikiUrl })
		: existingWikiData;

	const entry = {
		id: editingEntry ? editingEntry.entryId : `e_${Date.now()}`,
		title, year, format, fileSizeGb,
		owned: isOwned, digitized: isDigitized, isBoxSet,
		...(films ? { films } : {}),
		...(mergedWikiData ? { wikiData: mergedWikiData } : {}),
		links: { amazon, bestbuy }
	};

	if (editingEntry) {
		const oldCat = data.categories.find((c) => c.id === editingEntry.catId);
		const newCat = data.categories.find((c) => c.id === catId);
		oldCat.entries = oldCat.entries.filter((e) => e.id !== editingEntry.entryId);
		newCat.entries.push(entry);
		showToast(`"${title}" updated`);
	} else {
		data.categories.find((c) => c.id === catId).entries.push(entry);
		showToast(`"${title}" added`);
	}

	closeModal("modal-entry");
	sortData(data);
	saveState();
	render();
}

function deleteEntry(catId, entryId) {
	const cat   = data.categories.find((c) => c.id === catId);
	const entry = cat?.entries.find((e) => e.id === entryId);
	if (!cat || !entry) return;
	if (!confirm(`Delete "${entry.title}"?`)) return;

	cat.entries = cat.entries.filter((e) => e.id !== entryId);
	sortData(data);
	saveState();
	render();
	showToast(`"${entry.title}" removed`);
}

function toggleState(catId, entryId, prop) {
	const cat   = data.categories.find((c) => c.id === catId);
	const entry = cat?.entries.find((e) => e.id === entryId);
	if (!entry) return;
	entry[prop] = !entry[prop];
	saveState();
	render();
}

// ══════════════════════════════════════════════
//  MODAL — NEW CATEGORY
// ══════════════════════════════════════════════
function openNewCatModal() {
	document.getElementById("newcat-name").value = "";
	openModal("modal-newcat");
	setTimeout(() => document.getElementById("newcat-name").focus(), 50);
}

function saveNewCategory() {
	const name = document.getElementById("newcat-name").value.trim();
	if (!name) return showToast("Enter a category name", "⚠");

	const id = "cat_" + name.toLowerCase().replace(/[^a-z0-9]/g, "_") + "_" + Date.now();
	data.categories.push({ id, name, entries: [] });

	sortData(data);
	closeModal("modal-newcat");
	populateModalCategorySelect(id);
	showToast(`Category "${name}" created`);
}

// ══════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════
let toastTimer;
function showToast(msg, icon = "✓") {
	const t = document.getElementById("toast");
	document.getElementById("toast-msg").textContent = msg;
	t.querySelector(".toast-icon").textContent = icon;
	t.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}

// ══════════════════════════════════════════════
//  SELECT MODE
// ══════════════════════════════════════════════
let selectModeActive = false;

function enterSelectMode() {
	selectModeActive = true;
	document.getElementById("collection").classList.add("select-mode");

	document.getElementById("btn-select").classList.add("d-none");
	document.getElementById("btn-save").classList.add("d-none");
	document.getElementById("btn-add").classList.add("d-none");
	document.getElementById("btn-export").classList.add("d-none");

	document.getElementById("btn-select-all").classList.remove("d-none");
	document.getElementById("btn-delete-selected").classList.remove("d-none");
	document.getElementById("btn-cancel-select").classList.remove("d-none");
	updateSelectedCount();
}

function exitSelectMode() {
	selectModeActive = false;
	document.getElementById("collection").classList.remove("select-mode");

	document.getElementById("btn-select").classList.remove("d-none");
	document.getElementById("btn-save").classList.remove("d-none");
	document.getElementById("btn-add").classList.remove("d-none");
	document.getElementById("btn-export").classList.remove("d-none");

	document.getElementById("btn-select-all").classList.add("d-none");
	document.getElementById("btn-delete-selected").classList.add("d-none");
	document.getElementById("btn-cancel-select").classList.add("d-none");

	document.querySelectorAll(".entry-select-check").forEach((cb) => (cb.checked = false));
	document.querySelectorAll(".entry-card.selected").forEach((c) => c.classList.remove("selected"));
}

function updateSelectedCount() {
	const n = document.querySelectorAll(".entry-select-check:checked").length;
	document.getElementById("selected-count").textContent = n;
}

// ══════════════════════════════════════════════
//  INFO MODAL
// ══════════════════════════════════════════════
let _infoBoxSetState = null;

function renderInfoModal(entry, catId, filmIndex = null) {
	const isBS    = entry.isBoxSet && entry.films?.length;
	const subject = (isBS && filmIndex !== null) ? entry.films[filmIndex] : entry;
	const w       = subject.wikiData;

	document.getElementById("info-title").textContent = (isBS && filmIndex !== null)
		? `${entry.title} — ${subject.title}`
		: entry.title;

	const posterEl = document.getElementById("info-poster");
	if (w?.poster) {
		posterEl.src          = w.poster;
		posterEl.style.display = "block";
	} else {
		posterEl.style.display = "none";
	}

	const detailRows = [
		["Directed By",    w?.director],
		["Starring",       w?.starring],
		["Cinematography", w?.cinematography],
		["Music By",       w?.music],
		["Release Date",   w?.release],
		["Running Time",   w?.runtime],
	].filter(([, val]) => val && val.trim() !== "");

	document.getElementById("info-detail-table-wrap").innerHTML = detailRows.length ? `
		<table class="info-detail-table"><tbody>
			${detailRows.map(([label, val]) => `<tr><th>${label}</th><td>${val}</td></tr>`).join("")}
		</tbody></table>` : "";

	document.getElementById("info-synopsis").textContent = w
		? (w.synopsis || "No synopsis available.")
		: "Loading…";

	const navWrap  = document.getElementById("info-boxset-nav");
	const prevBtn  = document.getElementById("info-nav-prev");
	const nextBtn  = document.getElementById("info-nav-next");
	const navLabel = document.getElementById("info-nav-label");

	if (isBS && filmIndex !== null) {
		navWrap.style.display   = "flex";
		navLabel.textContent    = `${filmIndex + 1} / ${entry.films.length}`;
		prevBtn.disabled        = filmIndex === 0;
		nextBtn.disabled        = filmIndex === entry.films.length - 1;
	} else {
		navWrap.style.display = "none";
	}

	// Fetch on demand if not yet cached
	if (!subject.wikiData) {
		document.getElementById("info-synopsis").textContent = "Loading…";
		const capSize = (entry.isBoxSet && entry.films?.length) ? entry.films.length : 1;
		fetchWikiData(subject.title, subject.year, subject.wikiData?.wikiUrl ?? null).then(wiki => {
			subject.wikiData = wiki || {
				synopsis: null, poster: null, director: null, release: null,
				runtime: null, starring: null, cinematography: null, music: null
			};
			wikiLRUTouch(subject, capSize);
			if (_infoBoxSetState?.entry.id === entry.id && _infoBoxSetState?.filmIndex === filmIndex) {
				renderInfoModal(entry, catId, filmIndex);
			}
		});
	} else {
		const capSize = (entry.isBoxSet && entry.films?.length) ? entry.films.length : 1;
		wikiLRUTouch(subject, capSize);
	}
}

function openInfoModal(catId, entryId) {
	const cat   = data.categories.find((c) => c.id === catId);
	const entry = cat?.entries.find((e) => e.id === entryId);
	if (!entry) return;

	const isBS         = entry.isBoxSet && entry.films?.length;
	_infoBoxSetState   = { entry, catId, filmIndex: isBS ? 0 : null };
	renderInfoModal(entry, catId, _infoBoxSetState.filmIndex);
	openModal("modal-info");
}

// ══════════════════════════════════════════════
//  SUGGEST FILM
// ══════════════════════════════════════════════
function getVisibleOwnedEntries() {
	const search      = document.getElementById("search").value.toLowerCase().trim();
	const filterCat   = document.getElementById("filter-cat").value;
	const filterDigi  = document.getElementById("filter-digi").value;
	const filterFormat= document.getElementById("filter-format").value;
	const pool        = [];

	data.categories.forEach((cat) => {
		if (filterCat && cat.id !== filterCat) return;
		cat.entries.forEach((entry) => {
			if (!entry.owned) return;
			if (filterDigi   === "yes" && !entry.digitized)               return;
			if (filterDigi   === "no"  && entry.digitized)                return;
			if (filterFormat !== "all" && entry.format !== filterFormat)   return;

			if (search) {
				const titleMatch = entry.title.toLowerCase().includes(search);
				const filmMatch  = entry.films?.some((f) => f.title.toLowerCase().includes(search));
				if (!titleMatch && !filmMatch) return;
			}

			if (entry.isBoxSet && entry.films?.length) {
				entry.films.forEach((film) => {
					pool.push({
						entry:       { ...film, id: entry.id + "_" + film.title, format: entry.format, owned: entry.owned },
						catName:     cat.name,
						parentTitle: entry.title,
					});
				});
			} else {
				pool.push({ entry, catName: cat.name });
			}
		});
	});
	return pool;
}

let lastSuggestedId = null;
let currentSuggestedMovieRef = null; // Track the active suggestion data structure globally

async function openSuggestModal() {
	const pool = getVisibleOwnedEntries();
	if (pool.length === 0) return showToast("No owned films match the current filters", "◎");

	let candidates = pool.length > 1 ? pool.filter((p) => p.entry.id !== lastSuggestedId) : pool;
	const pick     = candidates[Math.floor(Math.random() * candidates.length)];
	lastSuggestedId = pick.entry.id;

	// Unpack box set references if necessary to find the underlying movie data
	let activeMovieData = pick.entry;
	if (pick.parentTitle) {
		// Find the raw parent entry from master state to keep memory pointers accurate
		const parentEntry = data.categories
			.flatMap(c => c.entries)
			.find(e => e.title === pick.parentTitle);
		if (parentEntry && parentEntry.films) {
			activeMovieData = parentEntry.films.find(f => f.title === pick.entry.title) || pick.entry;
		}
	} else {
		activeMovieData = data.categories
			.flatMap(c => c.entries)
			.find(e => e.id === pick.entry.id) || pick.entry;
	}

	// Stash a reference to the active pick and its matching category ID
	currentSuggestedMovieRef = {
		entry: activeMovieData,
		catId: data.categories.find(c => c.name === pick.catName)?.id || null
	};

	const fmt = FORMAT_MAP[pick.entry.format || "4k"] || FORMAT_MAP["4k"];

	document.getElementById("suggest-film-title").textContent = pick.entry.title;
	document.getElementById("suggest-film-meta").innerHTML    = `
		${pick.entry.year ? `<span>${pick.entry.year}</span>` : ""}
		<span>${fmt.label}</span>
	`;
	document.getElementById("suggest-film-cat").textContent = pick.parentTitle
		? `${pick.catName} — from ${pick.parentTitle}`
		: pick.catName;

	// Target DOM layout elements
	const modalBox  = document.querySelector(".suggest-modal");
	const posterImg = document.getElementById("suggest-poster-img");
	
	// Reset layout states and hide image elements instantly before processing checks
	posterImg.classList.remove("loaded");
	modalBox.classList.remove("no-poster");
	posterImg.src = "";

	// If metadata isn't cached yet, fetch it on the fly from Wikipedia
	if (!activeMovieData.wikiData || activeMovieData.wikiData.poster === undefined) {
		openModal("modal-suggest");
		
		const capSize = (activeMovieData.isBoxSet && activeMovieData.films?.length) ? activeMovieData.films.length : 1;
		const wiki = await fetchWikiData(activeMovieData.title, activeMovieData.year, activeMovieData.wikiData?.wikiUrl ?? null);
		
		activeMovieData.wikiData = wiki || {
			synopsis: null, poster: null, director: null, release: null,
			runtime: null, starring: null, cinematography: null, music: null
		};
		wikiLRUTouch(activeMovieData, capSize);
	} else {
		openModal("modal-suggest");
	}

	// Route image population based on asset presence
	if (activeMovieData.wikiData?.poster) {
		posterImg.src = activeMovieData.wikiData.poster;
		
		// Wait brief moment for layout tracking before drawing image transition
		setTimeout(() => {
			posterImg.classList.add("loaded");
		}, 20);
	} else {
		// Collapse column using layout modifier if no poster exists (or no network connection)
		modalBox.classList.add("no-poster");
	}
}

// ══════════════════════════════════════════════
//  STATS DASHBOARD
// ══════════════════════════════════════════════
function openStatsModal() {
	const allEntries = data.categories.flatMap((cat) => cat.entries.map((e) => ({ ...e, catName: cat.name })));

	const total      = allEntries.length;
	const owned      = allEntries.filter((e) => e.owned !== false).length;
	const wishlist   = total - owned;
	const digitized  = allEntries.filter((e) => e.digitized).length;
	const totalFilms = allEntries.reduce((s, e) => s + (e.isBoxSet && e.films?.length ? e.films.length : 1), 0);
	const boxSets    = allEntries.filter((e) => e.isBoxSet).length;
	const standalone = total - boxSets;

	const fmtCount      = { "4k": 0, bluray: 0, dvd: 0 };
	const fmtOwnedCount = { "4k": 0, bluray: 0, dvd: 0 };
	const fmtDigiCount  = { "4k": 0, bluray: 0, dvd: 0 };
	const fmtSizes      = { "4k": [], bluray: [], dvd: [] };
	const fmtTotalGb    = { "4k": 0, bluray: 0, dvd: 0 };

	allEntries.forEach((e) => {
		const f = e.format || "4k";
		fmtCount[f]      = (fmtCount[f] || 0) + 1;
		if (e.owned !== false) fmtOwnedCount[f] = (fmtOwnedCount[f] || 0) + 1;
		if (e.digitized)       fmtDigiCount[f]  = (fmtDigiCount[f]  || 0) + 1;
		if (e.fileSizeGb != null && fmtSizes[f]) {
			fmtSizes[f].push(e.fileSizeGb);
			fmtTotalGb[f] += e.fileSizeGb;
		}
	});

	const avg          = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
	const totalDigiFmt = fmtDigiCount["4k"] + fmtDigiCount["bluray"] + fmtDigiCount["dvd"] || 1;

	const digiEntries = allEntries.filter((e) => e.digitized && e.fileSizeGb != null);
	const totalDigiGb = digiEntries.reduce((s, e) => s + e.fileSizeGb, 0);
	const totalDigiTb = (totalDigiGb / 1024).toFixed(2);

	const largestEntry  = [...allEntries].filter((e) => e.fileSizeGb).sort((a, b) => b.fileSizeGb - a.fileSizeGb)[0];
	const smallestEntry = [...allEntries].filter((e) => e.fileSizeGb).sort((a, b) => a.fileSizeGb - b.fileSizeGb)[0];

	const catCounts = data.categories.map((c) => ({ name: c.name, count: c.entries.length })).sort((a, b) => b.count - a.count);
	const maxCat    = catCounts[0]?.count || 1;

	const barRow = (label, count, max, colorClass = "", wide = false, display = null) => {
		const pct = max > 0 ? (count / max) * 100 : 0;
		return `<div class="stats-bar-row flex-row">
			<span class="stats-bar-label${wide ? " wide" : ""}">${label}</span>
			<div class="stats-bar-track"><div class="stats-bar-fill ${colorClass}" style="width:${pct}%"></div></div>
			<span class="stats-bar-count">${display ?? count}</span>
		</div>`;
	};

	const fmtSize = (gb) => gb >= 1024 ? `${(gb / 1024).toFixed(2)} TB` : `${gb.toFixed(1)} GB`;

	const fmtBarRow = (label, digiCount, totalDigi, colorClass, avgGb, totalGb) => {
		const pct      = totalDigi > 0 ? (digiCount / totalDigi) * 100 : 0;
		const subParts = [];
		if (avgGb)      subParts.push(`${avgGb} GB avg`);
		if (totalGb > 0) subParts.push(`${fmtSize(totalGb)} total`);
		const subLine = subParts.length ? `<span class="stats-bar-count-sub">${subParts.join(" · ")}</span>` : "";
		return `<div class="stats-bar-row flex-row">
			<span class="stats-bar-label">${label}</span>
			<div class="stats-bar-track"><div class="stats-bar-fill ${colorClass}" style="width:${pct}%"></div></div>
			<span class="stats-bar-count-stack flex-row"><span class="stats-bar-count-main">${digiCount} films${subLine ? " ·" : ""}</span>${subLine}</span>
		</div>`;
	};

	document.getElementById("modal-stats-body").innerHTML = `
		<div class="stats-grid">
			<div class="stats-card">
				<div class="stats-card-label">Total Titles</div>
				<div class="stats-card-value font-display">${total}</div>
				<div class="stats-card-sub">${totalFilms} individual films</div>
			</div>
			<div class="stats-card">
				<div class="stats-card-label">Box Sets</div>
				<div class="stats-card-value font-display">${boxSets}</div>
				<div class="stats-card-sub">${standalone} standalone titles</div>
			</div>
			<div class="stats-card">
				<div class="stats-card-label">Owned</div>
				<div class="stats-card-value font-display">${owned}</div>
				<div class="stats-card-sub">${wishlist} on wishlist</div>
			</div>
			<div class="stats-card">
				<div class="stats-card-label">On Drive</div>
				<div class="stats-card-value font-display">${digitized}</div>
				<div class="stats-card-sub">${owned - digitized} still to copy</div>
			</div>
		</div>

		<div class="stats-section-title">Drive Content Breakdown</div>
		<div>
			${fmtBarRow("4K UHD",  fmtDigiCount["4k"],     totalDigiFmt, "",      avg(fmtSizes["4k"]),     fmtTotalGb["4k"])}
			${fmtBarRow("Blu-ray", fmtDigiCount["bluray"],  totalDigiFmt, "blue",  avg(fmtSizes["bluray"]), fmtTotalGb["bluray"])}
			${fmtBarRow("DVD",     fmtDigiCount["dvd"],     totalDigiFmt, "muted", avg(fmtSizes["dvd"]),    fmtTotalGb["dvd"])}
		</div>

		<div class="stats-section-title">Storage</div>
		<div class="stats-two-col">
			<div>
				<div class="stats-bar-row flex-row"><span class="stats-bar-label wide">Total on Drive</span><span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--accent);font-weight:500;">${totalDigiGb.toFixed(2)} GB</span></div>
				<div class="stats-bar-row flex-row" style="margin-top:2px;"><span class="stats-bar-label wide"></span><span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--text3);">${totalDigiTb} TB</span></div>
			</div>
			<div class="stats-avg-col">
				${largestEntry  ? `<div class="stats-avg-row flex-between"><span class="stats-avg-label">Largest file</span><span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--text2);text-align:right;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${largestEntry.title}">${largestEntry.fileSizeGb} GB</span></div>` : ""}
				${smallestEntry ? `<div class="stats-avg-row flex-between"><span class="stats-avg-label">Smallest file</span><span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--text2);text-align:right;">${smallestEntry.fileSizeGb} GB</span></div>` : ""}
			</div>
		</div>

		<div class="stats-section-title">Digitized Progress</div>
		${barRow("Copied", digitized, owned, "green", false, `${digitized} / ${owned}`)}

		<div class="stats-section-title">By Category</div>
		${catCounts.map((c) => barRow(c.name, c.count, maxCat, "", true)).join("")}
	`;

	openModal("modal-stats");
}

// ══════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════

// Header actions
document.getElementById("btn-add").addEventListener("click", openAddModal);
document.getElementById("btn-save").addEventListener("click", saveState);
document.getElementById("btn-export").addEventListener("click", exportJS);

document.getElementById("btn-sidebar-toggle").addEventListener("click", function () {
	this.classList.toggle("open");
	document.getElementById("sidebar").classList.toggle("collapsed");
});

// Sidebar
document.getElementById("btn-suggest").addEventListener("click", openSuggestModal);
document.getElementById("btn-stats").addEventListener("click", openStatsModal);

// Suggestion Modal header Info action
document.getElementById("suggest-info-btn").addEventListener("click", () => {
	if (!currentSuggestedMovieRef || !currentSuggestedMovieRef.entry) return;
	
	// Close the suggestion layout and map directly into your deep info inspector card
	closeModal("modal-suggest");
	
	// If it's a sub-film from a box set, inspect the parent box set frame
	let targetEntryId = currentSuggestedMovieRef.entry.id;
	let parentEntry = data.categories
		.flatMap(c => c.entries)
		.find(e => e.films && e.films.some(f => f.title === currentSuggestedMovieRef.entry.title));

	if (parentEntry) {
		openInfoModal(currentSuggestedMovieRef.catId, parentEntry.id);
	} else {
		openInfoModal(currentSuggestedMovieRef.catId, targetEntryId);
	}
});

// Filters
document.getElementById("search").addEventListener("input", render);
document.getElementById("filter-cat").addEventListener("change", render);

// Filters
document.getElementById("search").addEventListener("input", render);
document.getElementById("filter-cat").addEventListener("change", render);
document.getElementById("filter-format").addEventListener("change", render);
document.getElementById("filter-owned").addEventListener("change", render);
document.getElementById("filter-digi").addEventListener("change", render);
document.getElementById("filter-sort").addEventListener("change", render);

// Film modal save / new category
document.getElementById("modal-entry-save").addEventListener("click", saveEntryModal);
document.getElementById("modal-newcat-save").addEventListener("click", () => {
	saveNewCategory();
	openModal("modal-entry");
});
document.getElementById("suggest-again-btn").addEventListener("click", openSuggestModal);

// Film modal — toggle controls
document.getElementById("f-boxset-toggle").addEventListener("click", function () {
	isBoxSet = !isBoxSet;
	this.classList.toggle("on", isBoxSet);
	document.getElementById("f-boxset-label").textContent = isBoxSet ? "Yes" : "No";
	document.querySelector("#modal-entry .modal").classList.toggle("boxset-wide", isBoxSet);

	if (isBoxSet) {
		document.getElementById("f-subfilms-wrap").classList.remove("d-none");
		document.getElementById("f-singlesize-wrap").classList.add("d-none");
		document.getElementById("f-wiki-single-wrap").classList.add("d-none");
		document.getElementById("f-wiki-boxset-wrap").classList.remove("d-none");
		if (document.getElementById("subfilms-builder").children.length === 0) {
			addSubfilmRow();
			refreshBoxSetWikiLinks();
		}
	} else {
		document.getElementById("f-subfilms-wrap").classList.add("d-none");
		document.getElementById("f-singlesize-wrap").classList.remove("d-none");
		document.getElementById("f-wiki-single-wrap").classList.remove("d-none");
		document.getElementById("f-wiki-boxset-wrap").classList.add("d-none");
	}
});

document.getElementById("f-owned-toggle").addEventListener("click", function () {
	isOwned = !isOwned;
	this.classList.toggle("on", isOwned);
	document.getElementById("f-owned-label").textContent = isOwned ? "Yes" : "No";
});

document.getElementById("f-digitized-toggle").addEventListener("click", function () {
	isDigitized = !isDigitized;
	this.classList.toggle("on", isDigitized);
	document.getElementById("f-digitized-label").textContent = isDigitized ? "Yes" : "No";
});

document.getElementById("add-subfilm-btn").addEventListener("click", () => {
	addSubfilmRow();
	refreshBoxSetWikiLinks();
});

document.getElementById("f-category").addEventListener("change", function () {
	if (this.value === "__new__") openNewCatModal();
});

// Collection card actions (delegated)
document.getElementById("collection").addEventListener("click", (e) => {
	const infoBtn  = e.target.closest(".btn-info");
	const editBtn  = e.target.closest(".btn-edit");
	const delBtn   = e.target.closest(".btn-delete");
	const ownedBtn = e.target.closest(".owned-toggle");
	const digiBtn  = e.target.closest(".digi-toggle");

	if (infoBtn)  openInfoModal(infoBtn.dataset.catId,   infoBtn.dataset.entryId);
	if (editBtn)  openEditModal(editBtn.dataset.catId,   editBtn.dataset.entryId);
	if (delBtn)   deleteEntry(delBtn.dataset.catId,      delBtn.dataset.entryId);
	if (ownedBtn) toggleState(ownedBtn.dataset.catId,    ownedBtn.dataset.entryId, "owned");
	if (digiBtn)  toggleState(digiBtn.dataset.catId,     digiBtn.dataset.entryId, "digitized");
});

// Select mode
document.getElementById("btn-select").addEventListener("click", enterSelectMode);
document.getElementById("btn-cancel-select").addEventListener("click", exitSelectMode);

document.getElementById("btn-select-all").addEventListener("click", () => {
	const checks    = document.querySelectorAll(".entry-select-check");
	const allChecked = [...checks].every((cb) => cb.checked);
	checks.forEach((cb) => {
		cb.checked = !allChecked;
		cb.closest(".entry-card").classList.toggle("selected", !allChecked);
	});
	updateSelectedCount();
});

document.getElementById("collection").addEventListener("change", (e) => {
	const cb = e.target.closest(".entry-select-check");
	if (!cb) return;
	cb.closest(".entry-card").classList.toggle("selected", cb.checked);
	updateSelectedCount();
});

document.getElementById("collection").addEventListener("click", (e) => {
	if (!selectModeActive) return;
	const card = e.target.closest(".entry-card");
	if (!card) return;
	if (e.target.closest(".entry-select-check")) return;
	const cb = card.querySelector(".entry-select-check");
	if (cb) {
		cb.checked = !cb.checked;
		card.classList.toggle("selected", cb.checked);
		updateSelectedCount();
	}
}, true);

document.getElementById("btn-delete-selected").addEventListener("click", () => {
	const checked = [...document.querySelectorAll(".entry-select-check:checked")];
	if (checked.length === 0) return showToast("No films selected", "⚠");

	if (!confirm(`Permanently delete ${checked.length} film${checked.length > 1 ? "s" : ""}? This cannot be undone.`)) return;

	checked.forEach((cb) => {
		const cat = data.categories.find((c) => c.id === cb.dataset.catId);
		if (cat) cat.entries = cat.entries.filter((e) => e.id !== cb.dataset.entryId);
	});

	sortData(data);
	saveState();
	exitSelectMode();
	render();
	showToast(`${checked.length} film${checked.length > 1 ? "s" : ""} removed`);
});

// Info modal navigation
document.getElementById("info-nav-prev").addEventListener("click", () => {
	if (!_infoBoxSetState || _infoBoxSetState.filmIndex === null) return;
	_infoBoxSetState.filmIndex = Math.max(0, _infoBoxSetState.filmIndex - 1);
	renderInfoModal(_infoBoxSetState.entry, _infoBoxSetState.catId, _infoBoxSetState.filmIndex);
});

document.getElementById("info-nav-next").addEventListener("click", () => {
	if (!_infoBoxSetState || _infoBoxSetState.filmIndex === null) return;
	const max = _infoBoxSetState.entry.films.length - 1;
	_infoBoxSetState.filmIndex = Math.min(max, _infoBoxSetState.filmIndex + 1);
	renderInfoModal(_infoBoxSetState.entry, _infoBoxSetState.catId, _infoBoxSetState.filmIndex);
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		if (selectModeActive) { exitSelectMode(); return; }
		document.querySelectorAll(".modal-overlay.open, .suggest-overlay.open").forEach(m => m.classList.remove("open"));
	}
	if (e.key === "Enter" && document.getElementById("modal-newcat").classList.contains("open")) {
		saveNewCategory();
	}
});

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
initModalControllers();
initStaticDropdowns();
render();