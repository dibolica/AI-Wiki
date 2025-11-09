import { useEffect, useRef, useState } from "react";

/* ============== History helpers (outside component is OK) ============== */
function getQueryFromURL() {
  const u = new URL(window.location.href);
  return (u.searchParams.get("q") || "").trim();
}
function pushView(view: "home" | "results", q: string) {
  const url = view === "results" && q ? `?q=${encodeURIComponent(q)}` : "/";
  const state = { view, q };
  window.history.pushState(state, "", url);
}
function replaceView(view: "home" | "results", q: string) {
  const url = view === "results" && q ? `?q=${encodeURIComponent(q)}` : "/";
  const state = { view, q };
  window.history.replaceState(state, "", url);
}

/* ===================== Config ===================== */
const MAX_Q = 20;      // number of question cards
const MAX_MEDIA = 12;  // images/videos to fetch per modal

/* ===================== Types ===================== */
type QA = {
  question: string;
  answer?: string;       // lazy-loaded in modal
  sourceUrl?: string;
  titleGuess?: string;   // canonical title for Wikipedia
};
type MediaResult = {
  images: { url: string; thumb?: string; title?: string }[];
  videos: { url: string; poster?: string; title?: string }[];
};

/* ===================== Data helpers (no keys needed) ===================== */
/** Search enwiki for best title, then return its summary + url + title + thumb. */
async function fetchWikipediaSummaryBySearch(
  query: string
): Promise<{ text: string; url?: string; title?: string; thumb?: string } | null> {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query
  )}&format=json&origin=*`;
  const rs = await fetch(searchUrl);
  if (!rs.ok) return null;
  const j = await rs.json();
  const best = j?.query?.search?.[0];
  if (!best?.title) return null;

  const t = encodeURIComponent(best.title.replace(/\s+/g, "_"));
  const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${t}`;
  const r2 = await fetch(sumUrl, { headers: { accept: "application/json" } });
  if (!r2.ok) return null;
  const d2 = await r2.json();
  const extract = (d2.extract || "").trim();
  const url =
    typeof d2.content_urls?.desktop?.page === "string"
      ? d2.content_urls.desktop.page
      : undefined;
  const thumb =
    typeof d2.thumbnail?.source === "string" ? d2.thumbnail.source : undefined;
  return extract ? { text: extract, url, title: best.title, thumb } : null;
}

/** Try Simple English Wikipedia first for ELI5 fallback. */
async function fetchSimpleSummaryBySearch(query: string): Promise<string | null> {
  try {
    const searchUrl = `https://simple.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query
    )}&format=json&origin=*`;
    const rs = await fetch(searchUrl);
    if (!rs.ok) return null;
    const j = await rs.json();
    const best = j?.query?.search?.[0];
    if (!best?.title) return null;

    const t = encodeURIComponent(best.title.replace(/\s+/g, "_"));
    const sumUrl = `https://simple.wikipedia.org/api/rest_v1/page/summary/${t}`;
    const r2 = await fetch(sumUrl, { headers: { accept: "application/json" } });
    if (!r2.ok) return null;
    const d2 = await r2.json();
    const extract = (d2.extract || "").trim();
    return extract || null;
  } catch {
    return null;
  }
}

/** Tiny offline simplifier fallback for ELI5. */
function localEli5(text: string): string {
  const easy: Array<[RegExp, string]> = [
    [/approximately/gi, "about"],
    [/utilize/gi, "use"],
    [/utilizes/gi, "uses"],
    [/numerous/gi, "many"],
    [/subsequently/gi, "then"],
    [/however/gi, "but"],
    [/therefore|thus/gi, "so"],
    [/individuals/gi, "people"],
    [/objective/gi, "goal"],
    [/complex/gi, "hard"],
    [/significant/gi, "big"],
    [/initiated/gi, "started"],
    [/terminate/gi, "end"],
  ];
  let out = text
    .replace(/\(([^)]+)\)/g, "")
    .replace(/;|—|–/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, rep] of easy) out = out.replace(re, rep);
  const parts = out
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.length > 180 ? s.slice(0, 170).trim() + "..." : s));
  return (parts.slice(0, 5).join(". ") + ".").replace(/\.\.+/g, ".");
}

type DDGRelated = { Text: string; FirstURL?: string; Icon?: { URL?: string } };
type DDGResponse = { RelatedTopics?: DDGRelated[] };

function splitTitleAndSnippet(text: string) {
  const sep = text.includes(" — ")
    ? " — "
    : text.includes(" – ")
    ? " – "
    : text.includes(" - ")
    ? " - "
    : text.includes(": ")
    ? ": "
    : null;
  if (!sep) return { title: text.trim(), snippet: "" };
  const [title, ...rest] = text.split(sep);
  return { title: title.trim(), snippet: rest.join(sep).trim() };
}

/** Build up to MAX_Q questions from DuckDuckGo related topics. */
async function fetchQuestionsFromDuckDuckGo(topic: string): Promise<QA[]> {
  const q = encodeURIComponent(topic);
  const url = `https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`DuckDuckGo error: ${r.status}`);
  const data = (await r.json()) as DDGResponse;

  const raw = (data.RelatedTopics || [])
    .flatMap((item: any) => (Array.isArray(item?.Topics) ? item.Topics : [item]))
    .filter(Boolean) as DDGRelated[];

  const qas: QA[] = raw
    .map((t) => {
      const text = (t.Text || "").trim();
      if (!text) return null;
      const { title } = splitTitleAndSnippet(text);
      const sourceUrl = t.FirstURL;
      let titleGuess: string | undefined;
      if (sourceUrl && /wikipedia\.org\/wiki\//i.test(sourceUrl)) {
        const m = sourceUrl.match(/wiki\/([^#?]+)/i);
        if (m) titleGuess = decodeURIComponent(m[1]).replace(/_/g, " ");
      } else {
        titleGuess = title;
      }
      return {
        question: title.endsWith("?") ? title : `What is ${title}?`,
        sourceUrl,
        titleGuess,
      } as QA;
    })
    .filter(Boolean) as QA[];

  const seen = new Set<string>();
  const unique = qas.filter((x) => {
    const k = x.question.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return unique.slice(0, MAX_Q);
}

/** Wikipedia suggestions (prefix + full-text). */
async function fetchWikiSuggestions(term: string, max = 30): Promise<string[]> {
  const prefixUrl = `https://en.wikipedia.org/w/api.php?action=query&list=prefixsearch&pssearch=${encodeURIComponent(
    term
  )}&pslimit=${max}&format=json&origin=*`;
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    term
  )}&srlimit=${max}&format=json&origin=*`;

  const [pRes, sRes] = await Promise.all([fetch(prefixUrl), fetch(searchUrl)]);
  const pJson = pRes.ok ? await pRes.json() : null;
  const sJson = sRes.ok ? await sRes.json() : null;

  const pTitles: string[] = (pJson?.query?.prefixsearch || []).map((x: any) => x.title);
  const sTitles: string[] = (sJson?.query?.search || []).map((x: any) => x.title);

  const all = [...pTitles, ...sTitles].map((t) => t.trim()).filter(Boolean);
  const seen = new Set<string>();
  const unique = all.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.slice(0, max);
}

/** Pull up to MAX_MEDIA media files (images + videos) for a Wikipedia page title. */
async function fetchWikipediaMedia(title: string, max = MAX_MEDIA): Promise<MediaResult> {
  const imagesListUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=images&titles=${encodeURIComponent(
    title
  )}&imlimit=${max}&format=json&origin=*`;
  const lRes = await fetch(imagesListUrl);
  if (!lRes.ok) return { images: [], videos: [] };
  const lJson = await lRes.json();
  const pages = lJson?.query?.pages || {};
  const firstPage = pages[Object.keys(pages)[0]];
  const fileTitles: string[] = (firstPage?.images || [])
    .map((x: any) => x?.title)
    .filter((t: string) => typeof t === "string");

  if (fileTitles.length === 0) return { images: [], videos: [] };

  // batch queries to commons for file URLs/thumbs
  const chunk = (arr: string[], n: number) =>
    Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  const chunks = chunk(fileTitles.slice(0, max), 10);
  const imageInfos: any[] = [];
  for (const part of chunks) {
    const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(
      part.join("|")
    )}&prop=imageinfo&iiprop=url|mime|thumbmime&iiurlwidth=800&format=json&origin=*`;
    const infoRes = await fetch(infoUrl);
    if (!infoRes.ok) continue;
    const infoJson = await infoRes.json();
    const pgs = infoJson?.query?.pages || {};
    for (const k of Object.keys(pgs)) imageInfos.push(pgs[k]);
  }

  const images: MediaResult["images"] = [];
  const videos: MediaResult["videos"] = [];

  const isImg = (mime?: string, url?: string) =>
    (mime && mime.startsWith("image/")) || /\.(jpg|jpeg|png|gif)$/i.test(url || "");

  const isVid = (mime?: string, url?: string) =>
    (mime && mime.startsWith("video/")) || /\.(webm|ogv|ogg)$/i.test(url || "");

  for (const f of imageInfos) {
    const t = f?.title as string | undefined;
    const ii = Array.isArray(f?.imageinfo) ? f.imageinfo[0] : null;
    if (!t || !ii) continue;
    const url: string | undefined = ii.url;
    const thumb: string | undefined = ii?.thumburl || ii?.url;
    const mime: string | undefined = ii.mime;

    if (!url) continue;
    if (isImg(mime, url)) {
      images.push({ url, thumb, title: t });
    } else if (isVid(mime, url)) {
      videos.push({ url, poster: thumb, title: t });
    }
  }

  return {
    images: images.slice(0, max),
    videos: videos.slice(0, Math.max(2, Math.floor(max / 6))), // few videos
  };
}

/* ===================== App ===================== */
export default function App() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"home" | "results">("home");

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<string>("");
  const [overviewTitle, setOverviewTitle] = useState<string | undefined>(undefined);

  // Overview simplify controls
  const [overviewShowEli5, setOverviewShowEli5] = useState(false);
  const [overviewEli5Loading, setOverviewEli5Loading] = useState(false);
  const [overviewEli5Text, setOverviewEli5Text] = useState<string | null>(null);

  const [questions, setQuestions] = useState<QA[]>([]);
  const [selectedQA, setSelectedQA] = useState<QA | null>(null);

  // Modal state
  const [isModalLoading, setIsModalLoading] = useState(false);
  const [isEli5Loading, setIsEli5Loading] = useState(false);
  const [eli5Text, setEli5Text] = useState<string | null>(null);
  const [showEli5, setShowEli5] = useState(false);
  const [modalImages, setModalImages] = useState<MediaResult["images"]>([]);
  const [modalVideos, setModalVideos] = useState<MediaResult["videos"]>([]);

  // Not found + suggestions
  const [notFound, setNotFound] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // Inputs refs
  const homeInputRef = useRef<HTMLInputElement | null>(null);
  const headerInputRef = useRef<HTMLInputElement | null>(null);
  const focusSearch = () => (headerInputRef.current ?? homeInputRef.current)?.focus();

  // === History: initialize & handle Back/Forward ===
  useEffect(() => {
    const initialQ = getQueryFromURL();
    if (initialQ) {
      setQuery(initialQ);
      setView("results");
      fetchOverviewAndQuestions(initialQ);
      replaceView("results", initialQ); // baseline so Back stays within app
    } else {
      replaceView("home", "");
    }

    const onPop = (e: PopStateEvent) => {
      const s = (e.state as any) || {};
      if (s.modal && selectedQA) {
        // Close modal first when going back from modal state
        setSelectedQA(null);
        return;
      }

      const nextView: "home" | "results" = s.view ?? (getQueryFromURL() ? "results" : "home");
      const nextQ: string = s.q ?? getQueryFromURL();

      setView(nextView);
      setQuery(nextQ);

      if (nextView === "results" && nextQ) {
        fetchOverviewAndQuestions(nextQ);
      } else {
        setSelectedQA(null);
      }
    };

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedQA]);

  // '/' to focus, 'Esc' to close/clear
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
      if (!typing && e.key === "/") {
        e.preventDefault();
        focusSearch();
      }
      if (e.key === "Escape") {
        if (selectedQA) setSelectedQA(null);
        else setQuery("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedQA]);

  // lock scroll when modal open
  useEffect(() => {
    if (!selectedQA) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [selectedQA]);

  // Call your Ollama server for ELI5 (with fallbacks)
  async function eli5ViaServer(text: string): Promise<string> {
    const r = await fetch("http://localhost:3001/api/eli5", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error("ELI5 server error");
    const j = await r.json();
    return (j.eli5 || "").trim();
  }

  // ELI5 for Overview
  const makeOverviewEli5 = async () => {
    setOverviewEli5Loading(true);
    try {
      const base = overviewTitle || query.trim();
      let simplified = "";
      try {
        simplified = await eli5ViaServer(overview);
      } catch {
        const simple = await fetchSimpleSummaryBySearch(base);
        simplified = simple ?? localEli5(overview);
      }
      setOverviewEli5Text(simplified || "Not enough info to simplify.");
      setOverviewShowEli5(true);
    } finally {
      setOverviewEli5Loading(false);
    }
  };

  // ELI5 for Modal
  const makeEli5 = async () => {
    if (!selectedQA) return;
    setIsEli5Loading(true);
    try {
      const text = selectedQA.answer || "";
      let simplified = "";
      try {
        simplified = await eli5ViaServer(text);
      } catch {
        const baseTitle =
          selectedQA.titleGuess || selectedQA.question.replace(/^What is\s+|\?$/gi, "");
        const simple =
          (baseTitle && (await fetchSimpleSummaryBySearch(baseTitle))) ||
          (await fetchSimpleSummaryBySearch(selectedQA.question));
        simplified = simple ?? localEli5(text);
      }
      setEli5Text(simplified || "Not enough info to simplify.");
      setShowEli5(true);
    } finally {
      setIsEli5Loading(false);
    }
  };

  /** Fetch overview + up to 20 question shells; backfill from Wikipedia if needed. */
  async function fetchOverviewAndQuestions(topic: string) {
    setIsLoading(true);
    setError(null);
    setOverview("");
    setQuestions([]);
    setNotFound(false);
    setSuggestions([]);

    // reset overview simplify UI
    setOverviewTitle(undefined);
    setOverviewEli5Text(null);
    setOverviewShowEli5(false);
    setOverviewEli5Loading(false);

    let cancelled = false;
    const cancel = () => { cancelled = true; };

    try {
      const [ov, ddgQas] = await Promise.all([
        fetchWikipediaSummaryBySearch(topic), // {text,url,title,thumb} | null
        fetchQuestionsFromDuckDuckGo(topic), // array of QA (no answers yet)
      ]);
      if (cancelled) return;

      const ovText = ov?.text?.trim() || "";
      setOverview(ovText || `No overview found for “${topic}”.`);
      setOverviewTitle(ov?.title);

      let qas = ddgQas;

      // If fewer than MAX_Q, backfill from Wikipedia suggestions
      if (qas.length < MAX_Q) {
        const extraTitles = (await fetchWikiSuggestions(topic, MAX_Q * 2))
          .filter((t) => !qas.some((q) => (q.titleGuess || "").toLowerCase() === t.toLowerCase()))
          .slice(0, MAX_Q - qas.length);

        const backfill: QA[] = extraTitles.map((title) => ({
          question: title.endsWith("?") ? title : `What is ${title}?`,
          titleGuess: title,
        }));
        qas = [...qas, ...backfill];
      }

      setQuestions(qas.slice(0, MAX_Q));

      // Not-found banner if still empty + no overview
      if (!ovText && qas.length === 0) {
        setNotFound(true);
        setSuggestions(await fetchWikiSuggestions(topic, 8));
      } else {
        setNotFound(false);
        setSuggestions([]);
      }
    } catch (e: any) {
      if (!cancelled) setError(e?.message || "Failed to fetch results.");
    } finally {
      if (!cancelled) setIsLoading(false);
    }

    return cancel;
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || isLoading) return;
    setView("results");
    pushView("results", q);          // create a history entry
    await fetchOverviewAndQuestions(q);
  };

  // When a suggestion chip is clicked, push history too
  const searchFromSuggestion = async (s: string) => {
    setQuery(s);
    setView("results");
    pushView("results", s);
    await fetchOverviewAndQuestions(s);
  };

  // When a card opens, push a modal state and fetch the answer + media
  const openQA = async (qa: QA) => {
    // push transient modal state so Back closes modal first
    window.history.pushState({ modal: true, view: "results", q: query }, "", window.location.href);

    setShowEli5(false);
    setEli5Text(null);
    setModalImages([]);
    setModalVideos([]);
    setSelectedQA({ ...qa, answer: "" });
    setIsModalLoading(true);
    try {
      const key = qa.titleGuess || qa.question.replace(/^What is\s+|\?$/gi, "");
      const enriched =
        (key && (await fetchWikipediaSummaryBySearch(key))) ||
        (await fetchWikipediaSummaryBySearch(qa.question));

      const mediaTitle = enriched?.title || key || qa.question;
      const media = await fetchWikipediaMedia(mediaTitle, MAX_MEDIA);

      setModalImages(media.images);
      setModalVideos(media.videos);

      setSelectedQA((prev) =>
        prev
          ? {
              ...prev,
              answer: enriched?.text || "No concise summary found.",
              sourceUrl: enriched?.url,
              titleGuess: prev.titleGuess ?? enriched?.title,
            }
          : prev
      );
    } finally {
      setIsModalLoading(false);
    }
  };

  /* ===================== UI ===================== */
  return (
    <div className="min-h-screen bg-black text-white antialiased selection:bg-white/10">
      {/* Top bar */}
      <header className="fixed top-0 left-0 right-0 z-50">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3">
          <button
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20"
            onClick={() => alert("Hook up auth later")}
            aria-label="Open profile menu"
          >
            <div className="h-6 w-6 shrink-0 rounded-full bg-gradient-to-br from-white/60 to-white/20" />
            <span className="hidden sm:inline">Profile</span>
          </button>

          <div className="flex-1" />

          {view === "results" && (
            <form onSubmit={onSubmit} className="w-full max-w-md" aria-label="Search form">
              <div className="relative flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.05] p-2">
                <svg
                  aria-hidden
                  className="ml-2 h-5 w-5 text-white/60"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-3.5-3.5" />
                </svg>
                <input
                  ref={headerInputRef}
                  type="text"
                  inputMode="search"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Search anything…"
                  aria-label="Search"
                  className="w-full bg-transparent px-2 py-2 text-sm outline-none placeholder:text-white/40"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={isLoading}
                  className="rounded-lg bg-white text-black px-3 py-2 text-xs font-medium hover:bg-white/90 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isLoading ? "Searching…" : "Search"}
                </button>
              </div>
            </form>
          )}
        </div>
      </header>

      {/* Home view */}
      {view === "home" && (
        <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-4">
          <div className="w-full">
            <div className="mb-6 text-center">
              <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight">AI-Wiki</h1>
              <p className="mt-2 text-sm text-white/60">Search AI knowledge, tools, and concepts</p>
            </div>
            <form onSubmit={onSubmit} className="group relative" aria-label="Search form">
              <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-r from-white/10 via-white/5 to-white/10 blur-2xl opacity-0 transition-opacity duration-300 group-focus-within:opacity-100" />
              <div className="relative flex items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.03] p-2 backdrop-blur-sm shadow-[0_0_0_1px_rgba(255,255,255,0.06)] hover:border-white/25 focus-within:border-white/30">
                <svg
                  aria-hidden
                  className="ml-2 h-5 w-5 text-white/60"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-3.5-3.5" />
                </svg>
                <input
                  ref={homeInputRef}
                  type="text"
                  inputMode="search"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Search anything…"
                  aria-label="Search"
                  className="w-full bg-transparent px-2 py-3 text-base outline-none placeholder:text-white/40"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd className="mr-2 hidden rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[10px] text-white/60 sm:inline-block">
                  /
                </kbd>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="rounded-xl bg-white text-black px-3 py-2 text-sm font-medium hover:bg-white/90 focus:outline-none focus:ring-2 focus:ring-white/30 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isLoading ? "Searching…" : "Search"}
                </button>
              </div>
            </form>
            <div className="mt-6 text-center text-xs text-white/50">
              Tip: press <span className="rounded border border-white/20 px-1">/</span> to focus search
            </div>
          </div>
        </main>
      )}

      {/* Results view */}
      {view === "results" && (
        <main className="mx-auto max-w-6xl px-4 pt-24 pb-20">
          {/* Not found */}
          {notFound && (
            <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="text-sm font-semibold">Not found</div>
              <p className="mt-1 text-xs text-white/70">
                We couldn’t find results for “{query}”. Perhaps you meant:
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {suggestions.length > 0 ? (
                  suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => searchFromSuggestion(s)}
                      className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs hover:bg-white/[0.12]"
                    >
                      {s}
                    </button>
                  ))
                ) : (
                  <div className="text-xs text-white/50">No close matches.</div>
                )}
              </div>
            </div>
          )}

          {/* AI Overview with Simplify toggle */}
          <section
            className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-5 min-h-[25svh]"
            style={{ minHeight: "25vh" }}
          >
            {isLoading ? (
              <div className="animate-pulse space-y-3">
                <div className="h-4 w-1/3 rounded bg-white/10" />
                <div className="h-3 w-4/5 rounded bg-white/5" />
                <div className="h-3 w-3/5 rounded bg-white/5" />
              </div>
            ) : error ? (
              <div className="text-sm text-red-400">{error}</div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">AI Overview</h2>
                  <div className="flex items-center gap-2">
                    {overviewShowEli5 ? (
                      <button
                        onClick={() => setOverviewShowEli5(false)}
                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                      >
                        Original
                      </button>
                    ) : (
                      <button
                        onClick={makeOverviewEli5}
                        disabled={overviewEli5Loading}
                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {overviewEli5Loading ? "Simplifying…" : "Simplify"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-2 text-sm text-white/70 leading-6">
                  {overviewShowEli5 ? (
                    overviewEli5Loading ? (
                      <div className="animate-pulse space-y-2">
                        <div className="h-3 w-4/5 rounded bg-white/10" />
                        <div className="h-3 w-3/4 rounded bg-white/5" />
                        <div className="h-3 w-2/3 rounded bg-white/5" />
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{overviewEli5Text}</p>
                    )
                  ) : (
                    <p className="whitespace-pre-wrap">{overview}</p>
                  )}
                </div>

                {!notFound && (
                  <p className="mt-3 text-xs text-white/50">
                    Top questions about <span className="font-medium text-white/80">{query}</span> are listed below.
                  </p>
                )}
              </>
            )}
          </section>

          {/* 20 cards — questions only */}
          {!notFound && (
            <section className="mt-6 flex flex-wrap gap-3">
              {isLoading &&
                Array.from({ length: MAX_Q }).map((_, i) => (
                  <div
                    key={i}
                    className="animate-pulse rounded-xl border border-white/10 bg-white/[0.03] p-4
                               basis-full sm:basis-[calc(50%-0.375rem)] lg:basis-[calc(25%-0.5625rem)]
                               xl:basis-[calc(20%-0.6rem)]"
                  >
                    <div className="h-4 w-5/6 rounded bg-white/10" />
                  </div>
                ))}

              {!isLoading &&
                questions.slice(0, MAX_Q).map((item, i) => (
                  <button
                    key={i}
                    onClick={() => openQA(item)}
                    className="text-left rounded-xl border border-white/10 bg-white/[0.03] p-4 hover:bg-white/[0.06]
                               focus:outline-none focus:ring-2 focus:ring-white/20
                               basis-full sm:basis-[calc(50%-0.375rem)] lg:basis-[calc(25%-0.5625rem)]
                               xl:basis-[calc(20%-0.6rem)]"
                    aria-label={`Open answer for: ${item.question}`}
                  >
                    <div className="text-sm font-semibold line-clamp-2">{item.question}</div>
                  </button>
                ))}
            </section>
          )}
        </main>
      )}

      {/* Modal */}
      {selectedQA && (
        <Modal
          onClose={() => {
            // Prefer Back to pop the modal state we pushed
            if ((window.history.state as any)?.modal) window.history.back();
            else setSelectedQA(null);
          }}
          title={selectedQA.question}
        >
          {/* Body */}
          {isModalLoading ? (
            <div className="animate-pulse space-y-2">
              <div className="h-4 w-2/3 rounded bg-white/10" />
              <div className="h-3 w-4/5 rounded bg-white/5" />
              <div className="h-3 w-3/5 rounded bg-white/5" />
            </div>
          ) : (
            <>
              <p className="whitespace-pre-wrap">
                {showEli5 && eli5Text ? eli5Text : selectedQA.answer}
              </p>

              {/* Media gallery */}
              {(modalImages.length > 0 || modalVideos.length > 0) && (
                <div className="mt-5 space-y-4">
                  {modalImages.length > 0 && (
                    <div>
                      <div className="mb-2 text-xs font-semibold text-white/70">Images</div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {modalImages.map((img, i) => (
                          <a
                            key={i}
                            href={img.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
                            title={img.title || "Open image"}
                          >
                            <img
                              src={img.thumb || img.url}
                              alt={img.title || "related image"}
                              loading="lazy"
                              className="h-32 w-full object-cover"
                            />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {modalVideos.length > 0 && (
                    <div>
                      <div className="mb-2 text-xs font-semibold text-white/70">Videos</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {modalVideos.map((v, i) => (
                          <div
                            key={i}
                            className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]"
                            title={v.title || "Video"}
                          >
                            <video
                              controls
                              preload="metadata"
                              poster={v.poster}
                              className="w-full h-48 object-contain bg-black/50"
                            >
                              <source src={v.url} />
                              Your browser does not support the video tag.
                            </video>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Footer row: View source (left) — ELI5 (right) */}
              <div className="mt-4 flex items-center justify-between">
                {selectedQA.sourceUrl && !isModalLoading ? (
                  <a
                    href={selectedQA.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-xs text-white/70 hover:text-white/90 underline"
                  >
                    View source
                  </a>
                ) : (
                  <span />
                )}

                <div className="flex items-center gap-2">
                  {showEli5 ? (
                    <button
                      onClick={() => setShowEli5(false)}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                    >
                      Original
                    </button>
                  ) : (
                    <button
                      onClick={makeEli5}
                      disabled={isEli5Loading || isModalLoading}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {isEli5Loading ? "ELI5…" : "ELI5"}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* Vignette */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-1/3 h-[60vh] w-[60vw] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.08),rgba(0,0,0,0))]" />
      </div>
    </div>
  );
}

/* ===================== Modal ===================== */
function Modal({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeBtnRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const isShift = (e as KeyboardEvent).shiftKey;
        if (!isShift && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (isShift && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      aria-hidden={true}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="aiwiki-modal-title"
        ref={dialogRef}
        className="absolute left-1/2 top-1/2 w-[min(92vw,820px)] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 id="aiwiki-modal-title" className="text-base sm:text-lg font-semibold pr-6">
            {title}
          </h3>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
            aria-label="Close dialog"
          >
            Close
          </button>
        </div>

        <div className="mt-3 text-sm text-white/80 leading-6 overflow-y-auto max-h-[70vh]">
          {children}
        </div>
      </div>
    </div>
  );
}
