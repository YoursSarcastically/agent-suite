/**
 * Catalogue lookups for Recommend Me.
 *
 * This is the one file in the project that touches the network, and it is worth
 * being loud about why. A 3B model asked to name films will confidently invent
 * them - plausible title, plausible year, does not exist. Recall is the thing
 * small models are worst at, and no amount of prompting fixes it.
 *
 * So the model is never asked to remember a title. It turns a mood into search
 * terms (a rewriting job, which it is good at) and then ranks and explains
 * titles a real catalogue returned (a reading job, also good). Everything in
 * between is somebody else's database.
 *
 * TMDB does the film and television work, and it is here because the keyless
 * alternatives could not do the job. iTunes and TVMaze are title-search engines:
 * asked for "workplace comedy" they return zero results, and asked for "comedy"
 * they return shows with the word comedy in the name. Both measured. TMDB has
 * the two endpoints this app actually needs - `/recommendations`, which answers
 * "something like Ted Lasso" directly, and `/discover`, which is real genre
 * search. Books stay on Open Library, which does fine.
 *
 * The key below is readable by anyone who opens the page. There is nowhere to
 * hide a secret in a folder of static files, so it is a free-tier key doing
 * read-only lookups of public catalogue data, and the app degrades rather than
 * breaks if it is revoked.
 */

const TMDB_KEY = "feac11b253351ecefab36f7e950e2014";
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w342";

/** Every outbound request this session, newest last. The UI renders it verbatim. */
export const networkLog = [];

const record = (entry) => {
  networkLog.push({ at: Date.now(), ...entry });
  return entry.url;
};

export const clearNetworkLog = () => networkLog.splice(0, networkLog.length);

/* ------------------------------------------------------------------ *
 * transport
 * ------------------------------------------------------------------ */

const MIN_GAP_MS = 120;
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

/** One request, with a single retry. Rate limits are transient by definition. */
async function getJson(url, note, signal) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      if (attempt === 2) throw new Error(`${hostOf(url)} could not be reached`);
      await sleep(500, signal);
      continue;
    }

    if (res.ok) {
      record({ url: redact(url), note });
      return res.json();
    }

    const limited = res.status === 429;
    if (attempt === 2 || !limited) {
      throw new Error(limited ? `${hostOf(url)} is rate-limiting` : `${hostOf(url)} returned ${res.status}`);
    }
    await sleep(1000, signal);
  }
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return "the catalogue"; } };

/** The log is shown to the user; the key adds nothing and invites a shoulder-surf. */
const redact = (url) => url.replace(/api_key=[^&]+/, "api_key=...");

const tmdb = (path, params = {}, signal, note) => {
  const q = new URLSearchParams({ api_key: TMDB_KEY, ...params });
  return getJson(`${TMDB}${path}?${q}`, note, signal);
};

/* ------------------------------------------------------------------ *
 * shaping
 * ------------------------------------------------------------------ */

const fromMovie = (r) => ({
  kind: "film",
  id: r.id,
  title: r.title,
  year: (r.release_date ?? "").slice(0, 4),
  blurb: r.overview ?? "",
  rating: r.vote_average ? Number(r.vote_average.toFixed(1)) : null,
  votes: r.vote_count ?? 0,
  poster: r.poster_path ? IMG + r.poster_path : "",
  genreIds: r.genre_ids ?? [],
  link: `https://www.themoviedb.org/movie/${r.id}`,
});

const fromShow = (r) => ({
  kind: "show",
  id: r.id,
  title: r.name,
  year: (r.first_air_date ?? "").slice(0, 4),
  blurb: r.overview ?? "",
  rating: r.vote_average ? Number(r.vote_average.toFixed(1)) : null,
  votes: r.vote_count ?? 0,
  poster: r.poster_path ? IMG + r.poster_path : "",
  genreIds: r.genre_ids ?? [],
  link: `https://www.themoviedb.org/tv/${r.id}`,
});

/** Obscure entries with three votes are noise, not discoveries. */
const worthShowing = (it) => Boolean(it.title) && (it.votes >= 20 || it.rating >= 6);

/* ------------------------------------------------------------------ *
 * search
 * ------------------------------------------------------------------ */

export async function searchFilms(term, { limit = 8, signal } = {}) {
  const d = await tmdb("/search/movie", { query: term, include_adult: "false" }, signal, `films: ${term}`);
  return (d.results ?? []).map(fromMovie).filter(worthShowing).slice(0, limit);
}

export async function searchShows(term, { limit = 8, signal } = {}) {
  const d = await tmdb("/search/tv", { query: term, include_adult: "false" }, signal, `shows: ${term}`);
  return (d.results ?? []).map(fromShow).filter(worthShowing).slice(0, limit);
}

export async function searchBooks(term, { limit = 8, signal } = {}) {
  const url =
    `https://openlibrary.org/search.json?q=${encodeURIComponent(term)}` +
    `&limit=${limit}&fields=title,author_name,first_publish_year,subject,ratings_average,key,cover_i`;
  const d = await getJson(url, `books: ${term}`, signal);

  return (d.docs ?? []).map((b) => ({
    kind: "book",
    title: b.title,
    year: b.first_publish_year ? String(b.first_publish_year) : "",
    genre: (b.subject ?? []).slice(0, 4).join(", "),
    blurb: "",
    by: (b.author_name ?? [])[0] ?? "",
    rating: b.ratings_average ? Number(b.ratings_average.toFixed(1)) : null,
    poster: b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` : "",
    link: b.key ? `https://openlibrary.org${b.key}` : "",
  }));
}

/* ------------------------------------------------------------------ *
 * the two things only TMDB can do
 * ------------------------------------------------------------------ */

/**
 * "Something like X."
 *
 * The reason this app has a key at all. TMDB answers it from its own similarity
 * graph, so nothing depends on a small model knowing what X is - which it does
 * not. Asked about Ted Lasso it returns Ballers, The League and Brassic; the
 * keyless catalogues returned a Spanish drama called "Drama".
 */
export async function similarTo(ref, { limit = 12, signal } = {}) {
  if (!ref?.id) return [];
  const path = ref.kind === "film" ? `/movie/${ref.id}/recommendations` : `/tv/${ref.id}/recommendations`;
  const d = await tmdb(path, {}, signal, `things like ${ref.title}`);
  const shape = ref.kind === "film" ? fromMovie : fromShow;
  return (d.results ?? []).map(shape).filter(worthShowing).slice(0, limit);
}

/** Genre ids, fetched once. Names differ between film and television. */
const genreCache = {};

async function genreMap(kind, signal) {
  if (genreCache[kind]) return genreCache[kind];
  const d = await tmdb(kind === "film" ? "/genre/movie/list" : "/genre/tv/list", {}, signal, `${kind} genres`);
  genreCache[kind] = new Map((d.genres ?? []).map((g) => [g.name.toLowerCase(), g.id]));
  return genreCache[kind];
}

/**
 * Real genre discovery, the other thing a title-search API cannot do. Terms
 * that do not name a genre are ignored rather than guessed at.
 */
export async function discoverByGenre(terms, kind, { limit = 10, signal } = {}) {
  if (kind === "book") return [];
  const map = await genreMap(kind, signal);
  const ids = [...new Set(terms.map((t) => map.get(String(t).toLowerCase())).filter(Boolean))];
  if (!ids.length) return [];

  const d = await tmdb(
    kind === "film" ? "/discover/movie" : "/discover/tv",
    {
      with_genres: ids.join(","),
      sort_by: "vote_average.desc",
      "vote_count.gte": "300",
      include_adult: "false",
    },
    signal,
    `${kind}s in ${terms.join(" + ")}`
  );
  const shape = kind === "film" ? fromMovie : fromShow;
  return (d.results ?? []).map(shape).slice(0, limit);
}

/**
 * Look up a work someone named, so a reference is resolved by lookup rather
 * than by the model's memory.
 */
export async function resolveReference(title, media, { signal } = {}) {
  if (!title?.trim()) return null;

  const order = media?.length ? [...new Set(media)] : ["show", "film"];
  for (const kind of order) {
    if (kind === "book") continue;
    const hits = kind === "film"
      ? await searchFilms(title, { limit: 5, signal })
      : await searchShows(title, { limit: 5, signal });
    // Require a close title match; a fuzzy one sends the search somewhere worse
    // than where it started.
    const hit = hits.find((h) => similar(h.title, title));
    if (hit) return hit;
  }
  return null;
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const similar = (a, b) => {
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
};

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
 * dispatch
 * ------------------------------------------------------------------ */

export const MEDIA = ["film", "show", "book"];

const SEARCHERS = { film: searchFilms, show: searchShows, book: searchBooks };

/** Search one medium. One dead API should not kill the run. */
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

/** Compact rendering for a model prompt - full records blow the context window. */
export const forPrompt = (items, { blurb = 110 } = {}) =>
  items
    .map(
      (it, i) =>
        `${i + 1}. [${it.kind}] ${it.title}${it.year ? ` (${it.year})` : ""}` +
        `${it.by ? ` - ${it.by}` : ""}${it.rating ? ` *${it.rating}` : ""}` +
        `${it.blurb && blurb ? `\n   ${it.blurb.slice(0, blurb)}` : ""}`
    )
    .join("\n");
