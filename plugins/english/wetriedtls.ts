import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';

const API = 'https://api.wetriedtls.com';
const SITE = 'https://wetriedtls.com';

type NovelCard = {
  slug: string;
  title: string;
  cover: string;
};

type NovelDetails = {
  id: number;
  name: string;
  author: string;
  genres: string[];
  status: string;
  cover: string;
  summary: string;
};

type ChapterInfo = {
  slug: string;
  name: string;
  number: number;
  publishedAt: string;
  /** True for chapters behind the site's paywall (from the /paid endpoint). */
  locked: boolean;
};

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Decode a handful of HTML entities; the site uses a small set. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/** Strip tags, collapse whitespace. */
function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\xa0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Next.js app-router pages embed their data in
 *   self.__next_f.push([1,"<escaped payload>"])</script>
 * scripts. Decode every payload into one searchable text blob.
 * The closing tag match tolerates an optional semicolon / whitespace
 * (some Next.js versions emit `);</script>`), so chunks are never
 * silently skipped due to formatting.
 */
function extractFlightText(html: string): string {
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)\s*;?\s*<\/script>/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out += JSON.parse('"' + m[1] + '"');
    } catch {
      /* skip malformed chunk */
    }
  }
  return out;
}

/**
 * Slice a JS string by UTF-8 byte offsets (the flight protocol's `T<hex>`
 * length prefix counts UTF-8 bytes of the row payload, not UTF-16 chars).
 */
function sliceUtf8Bytes(s: string, start: number, byteLen: number): string {
  let bytes = 0;
  let i = start;
  while (i < s.length && bytes < byteLen) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        bytes += 4;
        continue;
      }
    }
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    i++;
  }
  return s.slice(start, i);
}

/** Inner text of one <p>...</p> block, tags stripped. */
function paragraphText(p: string): string {
  return decodeEntities(p.replace(/<[^>]+>/g, '')).trim();
}

function isTitleRepeat(p: string): boolean {
  // A paragraph that is nothing but bold text, e.g. the repeated
  // series / chapter title the site prepends to every chapter body.
  const inner = p
    .replace(/^<p[^>]*>/i, '')
    .replace(/<\/p>$/i, '')
    .trim();
  return /^<strong>[\s\S]*<\/strong>$/.test(inner);
}

function isPromoParagraph(p: string): boolean {
  // A block that carries an illustration is content, never promo — even
  // when it has no text of its own (e.g. <p><div><img></div></p>).
  if (/<img[\s>]/i.test(p)) return false;
  const t = paragraphText(p).toLowerCase();
  if (!t || t === '= = =') return true;
  if (t.indexOf('we tried translations') !== -1) return true;
  if (t.indexOf('dsc.gg') !== -1 || t.indexOf('join our discord') !== -1)
    return true;
  return false;
}

/** Parse the /query API response (catalog + search share the shape). */
function parseQueryResults(jsonText: string): {
  items: NovelCard[];
  lastPage: number;
} {
  const root = safeJson(jsonText);
  const items: NovelCard[] = [];
  let lastPage = 1;
  if (isRecord(root)) {
    const meta = root.meta;
    if (isRecord(meta) && typeof meta.last_page === 'number')
      lastPage = meta.last_page;
    const data = Array.isArray(root.data) ? root.data : [];
    for (const it of data) {
      if (!isRecord(it)) continue;
      if (it.series_type && it.series_type !== 'Novel') continue;
      const slug = str(it.series_slug).trim();
      const title = str(it.title).trim();
      if (!slug || !title) continue;
      items.push({
        slug,
        title: decodeEntities(title),
        cover: str(it.thumbnail),
      });
    }
  }
  return { items, lastPage };
}

/** Parse the /series/{slug} API response. */
function parseSeriesDetail(jsonText: string): NovelDetails | null {
  const s = safeJson(jsonText);
  if (!isRecord(s) || typeof s.id !== 'number') return null;
  const tags = Array.isArray(s.tags) ? s.tags : [];
  return {
    id: s.id,
    name: decodeEntities(str(s.title)),
    author: decodeEntities(str(s.author)),
    genres: tags
      .map(t => (isRecord(t) ? decodeEntities(str(t.name)) : ''))
      .filter(g => g.length > 0),
    status: str(s.status),
    cover: str(s.thumbnail),
    summary: stripHtml(str(s.description)),
  };
}

/**
 * Parse one page of the /chapters/{seriesId} API response.
 * Pass locked=true for pages from the /paid endpoint.
 */
function parseChapterList(
  jsonText: string,
  locked = false,
): { items: ChapterInfo[]; lastPage: number } {
  const root = safeJson(jsonText);
  const items: ChapterInfo[] = [];
  let lastPage = 1;
  if (isRecord(root)) {
    const meta = root.meta;
    if (isRecord(meta) && typeof meta.last_page === 'number')
      lastPage = meta.last_page;
    const data = Array.isArray(root.data) ? root.data : [];
    for (const c of data) {
      if (!isRecord(c)) continue;
      const slug = str(c.chapter_slug).trim();
      const name = str(c.chapter_name).trim();
      if (!slug || !name) continue;
      const title = str(c.chapter_title).trim();
      const idx = parseFloat(str(c.index));
      items.push({
        slug,
        name: title ? name + ': ' + decodeEntities(title) : name,
        number: isNaN(idx) ? 0 : idx,
        publishedAt: str(c.created_at),
        locked,
      });
    }
  }
  return { items, lastPage };
}

/**
 * The display name for a chapter in the app. Locked (paywalled) chapters
 * get a lock prefix so readers can see which ones are premium before
 * tapping them. LNReader sorts by chapterNumber, so the prefix never
 * affects chapter order.
 */
function chapterDisplayName(c: ChapterInfo): string {
  return c.locked ? '🔒 ' + c.name : c.name;
}

function proxiedImageUrl(url: string, width: number): string {
  const bare = url.replace(/^https?:\/\//i, '');
  return (
    'https://images.weserv.nl/?url=' +
    encodeURIComponent(bare) +
    '&w=' +
    width +
    '&q=80&output=webp'
  );
}

function shrinkIllustrations(html: string): string {
  return html.replace(
    /<img\b([^>]*?)\bsrc="(https?:\/\/media\.reaperscans\.net\/[^"]+)"([^>]*?)>/gi,
    (_m, pre, src, post) =>
      '<img' + pre + ' src="' + proxiedImageUrl(src, 800) + '"' + post + '>',
  );
}

/**
 * Route a cover through a fast image proxy at a list-friendly size.
 * The site's own covers are up to ~1 MB (they load painfully slowly in
 * the app's novel list) and the CDN offers no smaller variant, so we
 * request a 400px-wide webp instead. Non-URL values pass through.
 */
function coverUrl(thumbnail: string): string {
  const t = (thumbnail || '').trim();
  if (!/^https?:\/\//i.test(t)) return t;
  return proxiedImageUrl(t, 400);
}

type ChapterContentResult =
  | { status: 'ok'; html: string }
  | { status: 'premium' | 'notfound' | 'empty' };

/**
 * Extract the chapter body from a chapter page's HTML.
 *
 * The page is a Next.js app-router page: the chapter record carries
 * `"chapter_content":"$<rowId>"` and the body HTML lives in the flight
 * row `<rowId>:T<hex>,` that follows, where <hex> is the exact UTF-8 byte
 * length of the payload. Slicing by that byte count is required — a
 * "next row" lookahead overshoots into flight metadata and corrupts the
 * HTML. Returns the cleaned HTML, or a non-ok status for locked /
 * missing / unparseable chapters.
 */
function parseChapterContent(html: string): ChapterContentResult {
  if (/this chapter is premium!/i.test(html)) return { status: 'premium' };
  // Only the real <title> element counts for the 404 check: Next.js flight
  // data always embeds a notFound template containing similar wording.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title && /^\s*404/i.test(title[1])) return { status: 'notfound' };

  const flight = extractFlightText(html);
  // chapter_content is either a flight-row reference ("$<rowId>") or the
  // chapter HTML inline (gallery/illustration chapters). The value is a
  // JSON string, so internal quotes arrive escaped.
  const contentM = /"chapter_content":"((?:[^"\\]|\\.)*)"/.exec(flight);
  if (!contentM) return { status: 'empty' };
  let raw: string;
  try {
    raw = JSON.parse('"' + contentM[1] + '"');
  } catch {
    return { status: 'empty' };
  }

  let payload: string;
  const rowRef = /^\$([0-9a-z]{1,4})$/.exec(raw);
  if (rowRef) {
    // The row looks like `<rowId>:T<hex>,<payload>` where <hex> is the exact
    // UTF-8 byte length of the payload. Respecting it is the only reliable
    // end boundary: flight metadata follows the payload on the same line,
    // so a "next row" lookahead overshoots.
    const rowRe = new RegExp(
      '\\n' +
        rowRef[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        ':T([0-9a-f]+),',
    );
    const row = rowRe.exec(flight);
    if (!row) return { status: 'empty' };
    const byteLen = parseInt(row[1], 16);
    if (!(byteLen > 0)) return { status: 'empty' };
    const payloadStart = row.index + row[0].length;
    payload = sliceUtf8Bytes(flight, payloadStart, byteLen);
  } else if (/^\s*</.test(raw)) {
    payload = raw;
  } else {
    return { status: 'empty' };
  }
  if (!payload) return { status: 'empty' };

  // Paragraph breaks inside the payload are literal \r\n / \n sequences.
  const body = payload
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .trim();
  if (!body) return { status: 'empty' };

  // Split into top-level blocks — paragraphs, headings, figures and
  // standalone images, in document order — and trim the site's promo
  // header / footer (banner, series/chapter title repeats, discord plug).
  const blocks = body.match(
    /<p[\s\S]*?<\/p>|<h[1-6][\s\S]*?<\/h[1-6]>|<figure[\s\S]*?<\/figure>|<img[^>]*>/gi,
  ) || [body];
  let start = 0;
  let end = blocks.length;
  const isEdgeJunk = (p: string) => isPromoParagraph(p) || isTitleRepeat(p);
  while (start < end && isEdgeJunk(blocks[start])) start++;
  while (end > start && isEdgeJunk(blocks[end - 1])) end--;
  const cleaned = blocks.slice(start, end).join('\n');
  if (!paragraphText(cleaned)) return { status: 'empty' };
  return { status: 'ok', html: shrinkIllustrations(cleaned) };
}

function mapStatus(s: string): string {
  if (s === 'Ongoing') return NovelStatus.Ongoing;
  if (s === 'Completed') return NovelStatus.Completed;
  if (s === 'Hiatus' || s === 'On Hiatus') return NovelStatus.OnHiatus;
  if (s === 'Cancelled' || s === 'Dropped') return NovelStatus.Cancelled;
  return NovelStatus.Unknown;
}

class WeTriedTLS implements Plugin.PluginBase {
  id = 'wetriedtls';
  name = 'We Tried TLS';
  icon = 'src/en/wetriedtls/icon.png';
  site = SITE;
  version = '1.0.3';

  async popularNovels(
    pageNo: number,
    _options: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    const page = parseQueryResults(
      await fetchText(API + '/query?adult=true&query_string=&page=' + pageNo),
    );
    if (pageNo > page.lastPage) return [];
    return page.items.map(n => ({
      name: n.title,
      path: n.slug,
      cover: coverUrl(n.cover),
    }));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = novelPath.split('/').filter(Boolean).pop() || '';
    const detail = parseSeriesDetail(await fetchText(API + '/series/' + slug));
    if (!detail) throw new Error('Could not load novel details');

    // The chapter list is paginated (500 per page keeps it to ~2
    // requests even for the longest series). Free chapters come from
    // /chapters/{id} and paywalled chapters from /chapters/{id}/paid;
    // the two are merged so locked chapters show up with a lock prefix.
    // Opening a locked chapter shows a notice: it needs a paid
    // subscription on the website and cannot be read here.
    const all: ChapterInfo[] = [];
    let pageNo = 1;
    let lastPage = 1;
    do {
      const page = parseChapterList(
        await fetchText(
          API +
            '/chapters/' +
            detail.id +
            '?page=' +
            pageNo +
            '&perPage=500&order=asc',
        ),
      );
      lastPage = page.lastPage;
      for (const c of page.items) all.push(c);
      pageNo++;
    } while (pageNo <= lastPage);

    // Paid chapters are a bonus, not a requirement: if this endpoint
    // ever fails, the novel still loads with its free chapters.
    try {
      let paidPageNo = 1;
      let paidLastPage = 1;
      do {
        const page = parseChapterList(
          await fetchText(
            API +
              '/chapters/' +
              detail.id +
              '/paid?query=&page=' +
              paidPageNo +
              '&perPage=1000&order=asc',
          ),
          true,
        );
        paidLastPage = page.lastPage;
        for (const c of page.items) all.push(c);
        paidPageNo++;
      } while (paidPageNo <= paidLastPage);
    } catch {
      // ignore: free chapters are already collected above
    }

    const seen: Record<string, boolean> = {};
    const chapters: Plugin.ChapterItem[] = [];
    all
      .filter(c => {
        if (!c.slug || seen[c.slug]) return false;
        seen[c.slug] = true;
        return true;
      })
      .sort((a, b) => a.number - b.number)
      .forEach(c => {
        chapters.push({
          name: chapterDisplayName(c),
          path: slug + '/' + c.slug,
          releaseTime: c.publishedAt,
          chapterNumber: c.number,
        });
      });

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: detail.name,
      status: mapStatus(detail.status),
    };
    if (detail.cover) novel.cover = coverUrl(detail.cover);
    if (detail.author) novel.author = detail.author;
    if (detail.genres.length) novel.genres = detail.genres.join(', ');
    if (detail.summary) novel.summary = detail.summary;
    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const result = parseChapterContent(
      await fetchText(SITE + '/series/' + chapterPath),
    );
    if (result.status === 'ok') return result.html;
    if (result.status === 'premium') {
      return (
        '<p><strong>This chapter is premium on We Tried TLS.</strong></p>' +
        '<p>It requires a paid subscription on the website and cannot be read here. ' +
        'Free chapters of this novel still work.</p>'
      );
    }
    if (result.status === 'notfound') {
      return (
        '<p><strong>This chapter is no longer available on We Tried TLS.</strong></p>' +
        '<p>It may have been removed or moved. Refresh the novel to update the chapter list.</p>'
      );
    }
    return (
      '<p><strong>Could not load this chapter.</strong></p>' +
      '<p>It may be temporarily unavailable on We Tried TLS.</p>'
    );
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const page = parseQueryResults(
      await fetchText(
        API +
          '/query?adult=true&query_string=' +
          encodeURIComponent(searchTerm) +
          '&page=' +
          pageNo,
      ),
    );
    if (pageNo > page.lastPage) return [];
    return page.items.map(n => ({
      name: n.title,
      path: n.slug,
      cover: coverUrl(n.cover),
    }));
  }

  resolveUrl = (path: string, _isNovel?: boolean): string =>
    SITE + '/series/' + path;
}

export default new WeTriedTLS();
