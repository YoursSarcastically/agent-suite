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
 *
 * Every request is recorded in `networkLog` so the UI can show exactly what left
 * the machine. The honest claim for this app is not "nothing leaves your tab" -
 * it is "your taste never leaves your tab; only the search words do."
 */

/** Every outbound request this session, newest last. The UI renders it verbatim. */
export const networkLog = [];

const record = (url, note) => {
  networkLog.push({ url, note, at: Date.now() });
  return url;
};

export const clearNetworkLog = () => networkLog.splice(0, networkLog.length);

async function getJson(url, note, signal) {
  const res = await fetch(record(url, note), { signal });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  return res.json();
}

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
    networkLog.push({ url: `(${media} search failed)`, note: err.message, at: Date.now() });
    return [];
  }
}

/** Compact rendering for a model prompt - full records blow the context window. */
export const forPrompt = (items) =>
  items
    .map(
      (it, i) =>
        `${i + 1}. [${it.kind}] ${it.title}${it.year ? ` (${it.year})` : ""}` +
        `${it.by ? ` — ${it.by}` : ""}${it.genre ? ` · ${it.genre}` : ""}` +
        `${it.blurb ? `\n   ${it.blurb.slice(0, 200)}` : ""}`
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
