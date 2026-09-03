/**
 * Catalog lookups for Recommend Me.
 *
 * This is the one file in the project that touches the network, and it is worth
 * being loud about why. A 1.5B model asked to name films will confidently invent
 * them - plausible title, plausible year, plausible director, does not exist.
 * Recall is the thing small models are worst at, and no amount of prompting
 * fixes it.
 *
 * So the model is never asked to remember a title. It is asked to turn a mood
 * into search terms (a rewriting job, which it is good at), and then to rank and
 * explain titles that came back from a real catalog (a reading job, which it is
 * also good at). Everything in between is somebody else's database.
 *
 * Three sources, chosen because none of them needs an API key and all three send
 * `Access-Control-Allow-Origin: *`, so this stays a static site with no backend
 * and no secret to leak:
 *
 *   films   iTunes Search    plain search, filtered to feature films client-side
 *   shows   TVMaze           genres, summary, rating
 *   books   Open Library     subjects, author, year, ratings
 *   films+  OMDb             enrichment only - rating, genre, plot for a known title
 *
 * OMDb is used for enrichment rather than discovery, and that split is forced
 * by what it can actually do: its `s=` search matches title substrings only, so
 * "horror comedy" returns films with those words in the name rather than films
 * of that genre. Its `t=` lookup, on the other hand, returns an IMDb rating, a
 * real genre list and a plot - exactly the material the ranking agent lacks
 * when iTunes hands back a title and nothing else.
 *
 * Every request is recorded in `networkLog` so the UI can show exactly what left
 * the machine. The honest claim for this app is not "nothing leaves your tab" -
 * it is "your taste never leaves your tab; only the search words do."
 */

/**
 * OMDb key.
 *
 * This is a free-tier key in a public static site, so it is readable by anyone
 * who opens the page - there is nowhere to hide a secret in a folder of files
 * served straight from a CDN. Two things keep that from mattering much: the
 * free tier is 1,000 requests a day and this only fires for the handful of
 * films that reach the shortlist, and every lookup is cached locally so a
 * repeated title costs nothing. If it is ever exhausted or revoked, enrichment
 * degrades to nothing and the app keeps working on iTunes metadata alone.
 */
const OMDB_KEY = "15b3d9e0";

/** Every outbound request this session, newest last. The UI renders it verbatim. */
export const networkLog = [];

const record = (entry) => {
  networkLog.push({ at: Date.now(), ...entry });
  return entry.url;
};

export const clearNetworkLog = () => networkLog.splice(0, networkLog.length);

/**
 * These are free, unauthenticated endpoints and they rate-limit accordingly -
 * iTunes at roughly twenty calls a minute, TVMaze at twenty per ten seconds. A
 * mood that fans out to three queries across two catalogues trips both, and the
 * first version fired them as fast as the loop could issue them.
 *
 * So requests are queued behind a minimum gap. This is slower on paper and
 * faster in practice, because a 429 costs a whole round trip and returns nothing.
 */
const MIN_GAP_MS = 320;
let lastRequestAt = 0;

async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); },
      { once: true });
  });

/**
 * One request, with a single retry.
 *
 * Rate limits are transient by definition, so the first failure is worth one
 * more attempt after a pause. A second failure is real and gets reported with
 * the actual status - the previous version logged "(film search failed)" with
 * the message thrown away, which made a rate limit indistinguishable from a
 * bug for as long as it took to notice.
 */
async function getJson(url, note, signal) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      if (attempt === 2) throw new Error(`${hostOf(url)} could not be reached`);
      await sleep(600, signal);
      continue;
    }

    if (res.ok) {
      record({ url, note });
      return res.json();
    }

    const rateLimited = res.status === 429 || res.status === 403;
    if (attempt === 2 || !rateLimited) {
      throw new Error(
        rateLimited
          ? `${hostOf(url)} is rate-limiting — it allows only a few searches a minute`
          : `${hostOf(url)} returned ${res.status}`
      );
    }
    await sleep(1200, signal);
  }
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return "the catalogue"; } };

/* ------------------------------------------------------------------ *
 * films - iTunes Search
 * ------------------------------------------------------------------ */

/**
 * The documented `media=movie` filter returns zero results in practice, so the
 * plain term search is used and the results are filtered on `kind` here. Worth
 * knowing before someone "fixes" this by adding the parameter back.
 */
export async function searchFilms(term, { limit = 8, signal } = {}) {
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&country=US&limit=40`;
  const data = await getJson(url, `films matching "${term}"`, signal);

  return (data.results ?? [])
    .filter((r) => r.kind === "feature-movie")
    .slice(0, limit)
    .map((r) => ({
      kind: "film",
      title: r.trackName,
      year: (r.releaseDate ?? "").slice(0, 4),
      genre: r.primaryGenreName ?? "",
      blurb: strip(r.longDescription || r.shortDescription || ""),
      by: r.artistName ?? "",
      link: r.trackViewUrl ?? "",
    }));
}

/* ------------------------------------------------------------------ *
 * shows - TVMaze
 * ------------------------------------------------------------------ */

export async function searchShows(term, { limit = 8, signal } = {}) {
  const url = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(term)}`;
  const data = await getJson(url, `shows matching "${term}"`, signal);

  return (data ?? []).slice(0, limit).map(({ show }) => ({
    kind: "show",
    title: show.name,
    year: (show.premiered ?? "").slice(0, 4),
    genre: (show.genres ?? []).join(", "),
    blurb: strip(show.summary ?? ""),
    by: show.network?.name ?? show.webChannel?.name ?? "",
    rating: show.rating?.average ?? null,
    link: show.url ?? "",
  }));
}

/* ------------------------------------------------------------------ *
 * books - Open Library
 * ------------------------------------------------------------------ */

export async function searchBooks(term, { limit = 8, signal } = {}) {
  const url =
    `https://openlibrary.org/search.json?q=${encodeURIComponent(term)}` +
    `&limit=${limit}&fields=title,author_name,first_publish_year,subject,ratings_average,key`;
  const data = await getJson(url, `books matching "${term}"`, signal);

  return (data.docs ?? []).map((b) => ({
    kind: "book",
    title: b.title,
    year: b.first_publish_year ? String(b.first_publish_year) : "",
    // Open Library subject lists run to hundreds of entries; a few are enough
    // context for the model to rank on and short enough to fit the prompt.
    genre: (b.subject ?? []).slice(0, 4).join(", "),
    blurb: "",
    by: (b.author_name ?? [])[0] ?? "",
    rating: b.ratings_average ? Number(b.ratings_average.toFixed(1)) : null,
    link: b.key ? `https://openlibrary.org${b.key}` : "",
  }));
}

/* ------------------------------------------------------------------ *
 * article fetching
 * ------------------------------------------------------------------ */

/**
 * Fetch the readable text of a web page.
 *
 * A browser cannot fetch an arbitrary site directly - almost nothing sends
 * `Access-Control-Allow-Origin`, so the request is blocked before it starts.
 * That is a genuine wall, not an oversight, and it is why "paste a link" needs
 * something in the middle.
 *
 * r.jina.ai is a reader service that strips a page to its text and does send
 * CORS headers, needs no API key, and so keeps this a static site. Being honest
 * about the cost: the URL goes to them. Nothing else does - not the article, not
 * what you do with it - but the address of what you are reading leaves the
 * machine, so the caller is expected to say so before using this.
 */
export async function fetchArticle(url, { signal } = {}) {
  const clean = url.trim().replace(/^https?:\/\//, "");
  const endpoint = `https://r.jina.ai/https://${clean}`;
  await throttle();
  const res = await fetch(record({ url: endpoint, note: "reading the page" }), { signal });
  if (!res.ok) throw new Error(`Could not read that page (${res.status})`);

  const body = await res.text();

  // The reader puts its own headers on the front; the title is the useful one.
  const title = body.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const start = body.indexOf("Markdown Content:");
  const content = start !== -1 ? body.slice(start + "Markdown Content:".length) : body;

  return { title, text: content.trim(), url };
}

/** Does this look like something to fetch rather than text to file? */
export const looksLikeUrl = (s) => {
  const t = (s ?? "").trim();
  if (/\s/.test(t)) return false;
  return /^https?:\/\/\S+$/i.test(t) || /^[\w-]+(\.[\w-]+)+\/\S*$/.test(t) ||
         /^[\w-]+(\.[\w-]+){1,}$/.test(t);
};

/* ------------------------------------------------------------------ *
 * enrichment - OMDb
 * ------------------------------------------------------------------ */

/** Lookups persist across sessions; the same films come back for similar moods. */
const OMDB_CACHE = "agent-suite:omdb";

const loadCache = () => {
  try { return JSON.parse(localStorage.getItem(OMDB_CACHE) ?? "{}"); } catch { return {}; }
};
const saveCache = (cache) => {
  try { localStorage.setItem(OMDB_CACHE, JSON.stringify(cache)); } catch { /* full or denied */ }
};

/**
 * Add IMDb rating, genre and plot to films that already came back from iTunes.
 *
 * Failures are deliberately silent. Enrichment is an upgrade, not a dependency:
 * a dead key or an exhausted quota should cost you the ratings, not the results.
 */
export async function enrichFilms(items, { signal, max = 8 } = {}) {
  const cache = loadCache();
  let hits = 0;
  let dirty = false;

  for (const item of items) {
    if (item.kind !== "film" || hits >= max) continue;
    const key = `${item.title}|${item.year}`;

    let found = cache[key];
    if (found === undefined) {
      hits++;
      const url =
        `https://www.omdbapi.com/?t=${encodeURIComponent(item.title)}` +
        `${item.year ? `&y=${item.year}` : ""}&apikey=${OMDB_KEY}`;
      try {
        const data = await getJson(url, `details for "${item.title}"`, signal);
        found = data.Response === "True"
          ? { genre: data.Genre, plot: data.Plot, rating: data.imdbRating, runtime: data.Runtime }
          : null;
      } catch (err) {
        if (err.name === "AbortError") throw err;
        record({ url: `details for "${item.title}"`, note: err.message, failed: true });
        found = null;
      }
      cache[key] = found;
      dirty = true;
    }

    if (!found) continue;
    if (found.genre && found.genre !== "N/A") item.genre = found.genre;
    if (found.plot && found.plot !== "N/A") item.blurb = found.plot;
    if (found.rating && found.rating !== "N/A") item.rating = Number(found.rating);
    if (found.runtime && found.runtime !== "N/A") item.runtime = found.runtime;
  }

  if (dirty) saveCache(cache);
  return items;
}

/* ------------------------------------------------------------------ *
 * dispatch
 * ------------------------------------------------------------------ */

export const MEDIA = ["film", "show", "book"];

const SEARCHERS = { film: searchFilms, show: searchShows, book: searchBooks };

/** Search one medium. Failures return an empty list - one dead API should not kill the run. */
export async function search(media, term, opts = {}) {
  const fn = SEARCHERS[media];
  if (!fn) return [];
  try {
    return await fn(term, opts);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    record({ url: `${media} search for "${term}"`, note: err.message, failed: true });
    return [];
  }
}

/**
 * Compact rendering for a model prompt.
 *
 * Deliberately mean with characters. Twenty results with a two-hundred-character
 * synopsis each is three thousand tokens of prompt before the model has written
 * anything, and the generation then hits max_tokens mid-array and comes back
 * unparseable. One line per title is enough to rank on.
 */
export const forPrompt = (items, { blurb = 110 } = {}) =>
  items
    .map(
      (it, i) =>
        `${i + 1}. [${it.kind}] ${it.title}${it.year ? ` (${it.year})` : ""}` +
        `${it.by ? ` — ${it.by}` : ""}${it.genre ? ` · ${it.genre.slice(0, 60)}` : ""}` +
        `${it.blurb && blurb ? `\n   ${it.blurb.slice(0, blurb)}` : ""}`
    )
    .join("\n");

/** Open Library summaries and TVMaze descriptions both arrive as HTML. */
function strip(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
