import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

function readText(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? new TextDecoder().decode(contents) : '';
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.error(`Muote could not read ${path}: ${error.message}`);
        return '';
    }
}

function readJson(path, fallback) {
    const raw = readText(path).replace(/^hash:.*$/m, '').trim();
    if (!raw)
        return fallback;
    try {
        return JSON.parse(raw);
    } catch (error) {
        console.error(`Muote could not parse ${path}: ${error.message}`);
        return fallback;
    }
}

function writeText(path, contents) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, contents);
}

function weightedChoice(items) {
    const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    if (total <= 0)
        return null;
    let choice = Math.random() * total;
    for (const item of items) {
        choice -= Math.max(0, item.weight);
        if (choice < 0)
            return item;
    }
    return items.at(-1) ?? null;
}

function parseCurrent(raw) {
    const separator = raw.lastIndexOf(' — ');
    if (separator < 0)
        return {quote: raw.trim().replace(/^"|"$/g, ''), author: ''};
    return {
        quote: raw.slice(0, separator).trim().replace(/^"|"$/g, ''),
        author: raw.slice(separator + 3).trim(),
    };
}

function parseCustomQuotes(path) {
    const quotes = [];
    for (const rawLine of readText(path).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const fields = line.split('+-').map(field => field.trim());
        const weight = fields.length === 3 ? Number.parseInt(fields[2], 10) : 1;
        if (fields.length >= 2 && fields.length <= 3 && fields[0] && fields[1] &&
            Number.isInteger(weight) && weight >= 0) {
            quotes.push({quote: fields[0], author: fields[1], weight});
        }
    }
    return quotes;
}

function poolPath(configDir, author) {
    const key = [...author].map(character =>
        /[a-z0-9_-]/i.test(character) ? character : '_').join('');
    return GLib.build_filenamev([configDir, 'pools', `${key}.json`]);
}

function apiUrl(base, parameters) {
    const query = Object.entries(parameters)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    return `${base}?${query}`;
}

function decodeHtmlEntities(text) {
    const named = {
        amp: '&', apos: "'", gt: '>', hellip: '…', laquo: '«', ldquo: '“',
        lsquo: '‘', lt: '<', mdash: '—', nbsp: ' ', ndash: '–', quot: '"',
        raquo: '»', rdquo: '”', rsquo: '’',
    };
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_match, value) =>
            String.fromCodePoint(Number.parseInt(value, 16)))
        .replace(/&#(\d+);/g, (_match, value) =>
            String.fromCodePoint(Number.parseInt(value, 10)))
        .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function cleanHtmlText(html) {
    return decodeHtmlEntities(html
        .replace(/<(sup|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["“”«»]+|["“”«»]+$/g, '')
        .trim();
}

function isAttribution(text) {
    const lower = text.toLowerCase();
    return [
        'as quoted in', 'letter from', 'letter to', 'quoted in', 'source:',
        'variant:', 'see also', 'compare:', 'attributed', 'paraphrase',
        'often misquoted', 'sometimes attributed', 'this is often',
    ].some(prefix => lower.startsWith(prefix));
}

function extractQuotesFromHtml(html) {
    const quotes = [];
    for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        const quote = cleanHtmlText(match[1].replace(
            /<(ul|dl)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
        if ([...quote].length >= 20 && !isAttribution(quote))
            quotes.push(quote);
    }
    return [...new Set(quotes)];
}

function fetchCandidates(enabledAuthors, configDir, current, maxChars) {
    return enabledAuthors.map(author => {
        const path = poolPath(configDir, author.name);
        const pool = readJson(path, {key: author.name, quotes: []});
        let quotes = (pool.quotes ?? []).filter(quote =>
            typeof quote === 'string' && [...quote].length <= maxChars);
        const alternatives = quotes.filter(quote =>
            quote !== current.quote || author.name !== current.author);
        if (alternatives.length)
            quotes = alternatives;
        return {...author, path, pool, quotes};
    }).filter(author => author.quotes.length);
}

export class QuoteService {
    constructor() {
        this._session = new Soup.Session({
            user_agent: 'Muote GNOME extension ' +
                '(https://github.com/efebaykaraa/muote-gnome-extension)',
        });
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    _requestJson(url) {
        if (!this._session)
            return Promise.reject(new Error('Muote network service is not available'));

        const session = this._session;
        const message = Soup.Message.new('GET', url);
        return new Promise((resolve, reject) => {
            session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null, (source, result) => {
                try {
                    const bytes = source.send_and_read_finish(result);
                    const contents = new TextDecoder().decode(bytes.get_data());
                    if (message.status_code < 200 || message.status_code >= 300) {
                        reject(new Error(
                            `Request failed (${message.status_code}): ` +
                            contents.slice(0, 160)));
                        return;
                    }
                    resolve(JSON.parse(contents));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    async fetchWikiquote(author) {
        const endpoint = 'https://en.wikiquote.org/w/api.php';
        const data = await this._requestJson(apiUrl(endpoint, {
            action: 'parse', page: author, format: 'json', prop: 'text', origin: '*',
        }));
        const html = data.parse?.text?.['*'];
        if (typeof html !== 'string')
            throw new Error(`Wikiquote has no readable page for ${author}`);
        return extractQuotesFromHtml(html).slice(0, 200);
    }

    async translateQuote(quote, targetLanguage) {
        const language = String(targetLanguage).trim().toLowerCase().replaceAll('_', '-');
        if (language === 'original' || language === 'auto')
            return quote;
        const data = await this._requestJson(apiUrl(
            'https://translate.googleapis.com/translate_a/single', {
                client: 'gtx', sl: 'auto', tl: language, dt: 't', q: quote,
            }));
        const translated = Array.isArray(data?.[0])
            ? data[0].map(sentence => sentence?.[0] ?? '').join('').trim()
            : '';
        if (!translated)
            throw new Error('Google Translate returned no translated text');
        return translated;
    }

    async skipQuote() {
        const configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'muote']);
        const cachePath = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'muote', 'current_quote.txt',
        ]);
        const authors = readJson(GLib.build_filenamev([configDir, 'authors.json']), {
            authors: [],
            quote_mode: 'fetch',
        });
        const settings = readJson(GLib.build_filenamev([configDir, 'settings.json']), {
            appearance: {max_quote_chars: 581},
        });
        const maxChars = Math.max(
            1, Number(settings.appearance?.max_quote_chars) || 581);
        const current = parseCurrent(readText(cachePath));

        let chosen = null;
        if (authors.quote_mode === 'custom') {
            let quotes = parseCustomQuotes(
                GLib.build_filenamev([configDir, 'custom-quotes.muote']))
                .filter(quote => quote.weight > 0 &&
                    [...quote.quote].length <= maxChars);
            const alternatives = quotes.filter(quote =>
                quote.quote !== current.quote || quote.author !== current.author);
            if (alternatives.length)
                quotes = alternatives;
            chosen = weightedChoice(quotes);
        } else {
            const enabledAuthors = (authors.authors ?? []).filter(author =>
                String(author.name ?? '').trim() && Number(author.weight) > 0);
            if (!enabledAuthors.length)
                throw new Error('No enabled authors are configured');
            let candidates = fetchCandidates(
                enabledAuthors, configDir, current, maxChars);
            if (!candidates.length) {
                const author = weightedChoice(enabledAuthors);
                const quotes = await this.fetchWikiquote(author.name);
                writeText(poolPath(configDir, author.name), JSON.stringify({
                    key: author.name,
                    quotes,
                }, null, 2));
                candidates = fetchCandidates(
                    enabledAuthors, configDir, current, maxChars);
            }
            const selectedAuthor = weightedChoice(candidates);
            if (!selectedAuthor)
                throw new Error('Wikiquote did not return a usable quote');

            const index = Math.floor(Math.random() * selectedAuthor.quotes.length);
            chosen = {
                quote: selectedAuthor.quotes[index],
                author: selectedAuthor.name,
            };
            chosen.poolQuote = chosen.quote;
            chosen.pool = selectedAuthor.pool;
            chosen.poolPath = selectedAuthor.path;
        }

        if (!chosen)
            throw new Error('No enabled quote fits the current display');
        const language = String(settings.appearance?.language ?? 'ORIGINAL')
            .trim().toUpperCase();
        if (language !== 'ORIGINAL' && language !== 'AUTO')
            chosen.quote = await this.translateQuote(chosen.quote, language);
        if (chosen.pool) {
            chosen.pool.quotes = (chosen.pool.quotes ?? [])
                .filter(quote => quote !== chosen.poolQuote);
            writeText(chosen.poolPath, JSON.stringify(chosen.pool, null, 2));
            delete chosen.pool;
            delete chosen.poolPath;
            delete chosen.poolQuote;
        }
        writeText(cachePath, `"${chosen.quote}" — ${chosen.author}`);
        return chosen;
    }
}
