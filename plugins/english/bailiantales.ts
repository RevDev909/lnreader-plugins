import { load as loadCheerio, CheerioAPI } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

type TocPageResponse = {
  success?: boolean;
  data?: {
    html?: string;
  };
};

type HttpError = Error & { status?: number };

class BaiLianTales implements Plugin.PluginBase {
  id = 'bailiantales';
  name = 'BaiLianTales';
  icon = 'src/en/bailiantales/icon.png';
  site = 'https://bailiantales.com/';
  version = '2.2.5';

  private baseUrl = 'https://bailiantales.com';

  private async fetchHtml(url: string): Promise<string> {
    const res = await fetchApi(url);
    if (!res.ok) {
      const err: HttpError = new Error(`Could not reach site (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  }

  private async fetchListHtml(url: string, pageNo: number): Promise<string> {
    const res = await fetchApi(url);
    if (!res.ok) {
      // Past the last listing page the site answers 404; that is the
      // end of the list, not an error.
      if (pageNo > 1) return '';
      const err: HttpError = new Error(`Could not reach site (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Covers ship with a srcset of several sizes; take the smallest width
  // variant so list and novel pages load fast on slow connections. The
  // grid shows covers at roughly the smallest size anyway.
  private smallestCover(
    srcset: string | undefined,
    src: string | undefined,
    dataSrc: string | undefined,
  ): string {
    let best = '';
    let bestWidth = Infinity;
    for (const part of (srcset || '').split(',')) {
      const tokens = part.trim().split(/\s+/);
      if (tokens.length < 2 || !tokens[0] || !/w$/.test(tokens[1])) continue;
      const w = parseInt(tokens[1], 10);
      if (w && w < bestWidth) {
        bestWidth = w;
        best = tokens[0];
      }
    }
    if (best) {
      try {
        return new URL(best, this.site).href;
      } catch {
        return best;
      }
    }
    return src || dataSrc || defaultCover;
  }

  private parseList($: CheerioAPI): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();
    const novelPattern = /^https?:\/\/[^/]+\/novel\/[^/]+\/$/;

    // Archive cards and search results use different article markup, but
    // both put the novel title in an h3 link. The cover link must not be
    // used for the title: on archive cards it wraps the status badge,
    // so its text is "Ongoing", not the novel name.
    $('article').each((_, el) => {
      const $el = $(el);
      const link = $el.find('h3 a').first();
      const href = link.attr('href') || '';
      if (!novelPattern.test(href)) return;
      const title = link.text().trim() || link.attr('title')?.trim() || '';
      if (!title) return;
      let path: string;
      try {
        path = new URL(href, this.site).pathname;
      } catch {
        return;
      }
      if (seen.has(path)) return;
      seen.add(path);
      const img = $el.find('img').first();
      const cover = this.smallestCover(
        img.attr('srcset') || img.attr('data-srcset'),
        img.attr('src'),
        img.attr('data-src'),
      );
      novels.push({ name: title, path, cover });
    });

    return novels;
  }

  async popularNovels(pageNo: number): Promise<Plugin.NovelItem[]> {
    const url =
      pageNo <= 1
        ? `${this.baseUrl}/novel/`
        : `${this.baseUrl}/novel/page/${pageNo}/`;
    const html = await this.fetchListHtml(url, pageNo);
    if (!html) return [];
    return this.parseList(loadCheerio(html));
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const query = `?s=${encodeURIComponent(searchTerm)}&post_type=webnovel`;
    const url =
      pageNo <= 1
        ? `${this.baseUrl}/${query}`
        : `${this.baseUrl}/page/${pageNo}/${query}`;
    const html = await this.fetchListHtml(url, pageNo);
    if (!html) return [];
    return this.parseList(loadCheerio(html));
  }

  private collectTocChapters(
    $: CheerioAPI,
    chapters: Plugin.ChapterItem[],
    seen: Set<number>,
  ): void {
    $('.chapter-item-improved').each((_, el) => {
      const $el = $(el);
      const href = $el.find('a').first().attr('href') || '';
      const match = href.match(/\/chapter-(\d+)\//);
      const num = match ? parseInt(match[1], 10) : 0;
      if (!num || seen.has(num)) return;
      seen.add(num);
      const locked = ($el.attr('class') || '').includes('has-row-unlock');
      const title = $el
        .find('.jt-toc-title')
        .text()
        .trim()
        .replace(/\s+/g, ' ');
      let path: string;
      try {
        path = new URL(href, this.site).pathname;
      } catch {
        return;
      }
      chapters.push({
        name: (locked ? '🔒 ' : '') + (title || `Chapter ${num}`),
        path,
        chapterNumber: num,
        releaseTime: '',
      });
    });
  }

  // The theme's AJAX table-of-contents endpoint, kept as the backup for
  // the plain ?toc_page=N fetch. Retried a few times: one dropped
  // request is common on slow connections.
  private async fetchTocPageHtmlViaPost(
    novelId: string,
    nonce: string,
    page: number,
  ): Promise<string> {
    let pageHtml = '';
    for (let attempt = 0; attempt < 3 && !pageHtml; attempt++) {
      if (attempt > 0) await this.delay(500);
      try {
        const body = new URLSearchParams();
        body.append('action', 'jormuntl_toc_page');
        body.append('nonce', nonce);
        body.append('novel_id', novelId);
        // Same fields the site's own table-of-contents script sends.
        body.append('order', 'ASC');
        body.append('access', '');
        body.append('page', String(page));
        const res = await fetchApi(`${this.baseUrl}/wp-admin/admin-ajax.php`, {
          method: 'POST',
          body,
        });
        if (!res.ok) continue;
        const data = (await res
          .json()
          .catch(() => null)) as TocPageResponse | null;
        pageHtml = data && data.success ? data.data?.html || '' : '';
      } catch {
        // Transient failure: retry, then give up on this page.
      }
    }
    return pageHtml;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const html = await this.fetchHtml(this.site + novelPath.replace(/^\//, ''));
    const $ = loadCheerio(html);

    const title = $('h1').first().text().trim();
    const coverImg = $('img.wp-post-image').first();
    const cover = this.smallestCover(
      coverImg.attr('srcset') || coverImg.attr('data-srcset'),
      coverImg.attr('src'),
      coverImg.attr('data-src'),
    );

    const statusText = $('span.status-badge')
      .first()
      .text()
      .trim()
      .toLowerCase();
    const status = statusText.includes('ongoing')
      ? NovelStatus.Ongoing
      : statusText.includes('complete')
        ? NovelStatus.Completed
        : statusText.includes('hiatus')
          ? NovelStatus.OnHiatus
          : NovelStatus.Unknown;

    const genres: string[] = [];
    $('span.jt-field-label').each((_, el) => {
      if ($(el).text().trim() !== 'Genres') return;
      $(el)
        .parent()
        .find('a')
        .each((_, a) => {
          const g = $(a).text().trim();
          if (g) genres.push(g);
        });
    });

    const summary = $('.jt-hero-synopsis').text().trim();

    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<number>();
    this.collectTocChapters($, chapters, seen);

    // The table of contents renders one page (50 chapters); the rest are
    // also plain addresses (?toc_page=N, the ones the site's own page
    // selector links to), and a plain page fetch is the transport that
    // works everywhere the novel page itself loads. Fetch each further
    // page that way first, with the AJAX endpoint as backup.
    const toc = $('#novel-toc');
    const novelId = toc.attr('data-novel-id') || '';
    const total = parseInt(toc.attr('data-total') || '0', 10);
    const nonceMatch = html.match(
      /jormuntl_ajax\s*=\s*\{[^}]*"nonce":"([^"]+)"/,
    );
    const nonce = nonceMatch ? nonceMatch[1] : '';
    const tocPageUrl = (pageNo: number): string => {
      const base = this.site + novelPath.replace(/^\//, '');
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}toc_page=${pageNo}`;
    };
    let page = 2;
    while ((Number.isNaN(total) || chapters.length < total) && page <= 200) {
      // A failed table-of-contents page must never kill the novel: the
      // chapters already collected stay listed instead.
      let added = false;
      try {
        const getHtml = await this.fetchHtml(tocPageUrl(page));
        const before = chapters.length;
        this.collectTocChapters(loadCheerio(getHtml), chapters, seen);
        added = chapters.length > before;
      } catch {
        added = false;
      }
      if (!added && novelId && nonce) {
        const postHtml = await this.fetchTocPageHtmlViaPost(
          novelId,
          nonce,
          page,
        );
        if (!postHtml) break;
        const before = chapters.length;
        this.collectTocChapters(loadCheerio(postHtml), chapters, seen);
        if (chapters.length === before) break;
      } else if (!added) {
        break;
      }
      page++;
    }

    chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
    if (chapters.length === 0) {
      throw new Error('No chapters found for this novel.');
    }

    return {
      path: novelPath,
      name: title,
      cover,
      author: 'Unknown',
      genres: genres.join(', '),
      summary,
      status,
      chapters,
    };
  }

  private sanitizeChapterHtml(html: string): string {
    const $ = loadCheerio(html);
    const allowedTags = new Set([
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'blockquote',
      'ul',
      'ol',
      'li',
      'img',
      'a',
      'span',
      'div',
      'sub',
      'sup',
      'pre',
      'code',
    ]);
    const removeTags = new Set([
      'script',
      'style',
      'noscript',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'select',
      'textarea',
      'link',
      'meta',
      'title',
    ]);

    const elements = $('*').toArray();
    for (const el of elements) {
      const $el = $(el);
      const tag = (($el.get(0) as unknown as { tagName?: string }).tagName ||
        '') as string;
      const tagName = tag.toLowerCase();
      // The document wrapper itself is not content; leave it alone so
      // the sanitized body can be read back out below.
      if (tagName === 'html' || tagName === 'head' || tagName === 'body') {
        continue;
      }
      if (!allowedTags.has(tagName)) {
        if (removeTags.has(tagName)) {
          $el.remove();
        } else {
          $el.replaceWith($el.html() || '');
        }
        continue;
      }
      const attribs =
        ($el.get(0) as unknown as { attribs?: Record<string, string> })
          .attribs || {};
      for (const name of Object.keys(attribs)) {
        const value = attribs[name];
        if (name === 'href' || name === 'src') {
          if (/^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
            $el.removeAttr(name);
          } else if (/^(https?:)?\/\//i.test(value)) {
            $el.attr(name, value.startsWith('//') ? 'https:' + value : value);
          } else {
            try {
              $el.attr(name, new URL(value, this.site).href);
            } catch {
              $el.removeAttr(name);
            }
          }
        } else if (name !== 'alt') {
          $el.removeAttr(name);
        }
      }
    }

    return $('body').html() || '';
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const html = await this.fetchHtml(
      this.site + chapterPath.replace(/^\//, ''),
    );
    const $ = loadCheerio(html);
    const content = $('div.chapter-content').html();
    if (!content || !content.trim()) {
      throw new Error(
        'Chapter content not available. This chapter may be locked; try unlocking it on the site.',
      );
    }
    return this.sanitizeChapterHtml(content);
  }

  // The app opens a novel already saved in its database but with no
  // stored chapters through parsePage, not parseNovel — and it throws
  // when the plugin has none. This plugin has no server-side chapter
  // paging (the app pages the full list itself), so every page is the
  // whole list.
  async parsePage(novelPath: string, page: string): Promise<Plugin.SourcePage> {
    void page;
    const novel = await this.parseNovel(novelPath);
    return { chapters: novel.chapters };
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (path.startsWith('//')) return 'https:' + path;
    return this.site + path.replace(/^\//, '');
  }
}

export default new BaiLianTales();
