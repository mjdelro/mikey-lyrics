import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const USER_AGENT = 'mikey-lyrics-gnome/1.1.2 (https://github.com/mjdelro/mikey-lyrics)';

/**
 * Parse LRC formatted text into a sorted array of { time, text } objects.
 * Supports [mm:ss.xx], [mm:ss.xxx], [mm:ss], and multiple timestamps per line.
 */
export function parseLRC(lrcText) {
    if (!lrcText || typeof lrcText !== 'string')
        return [];

    const lines = [];
    const rawLines = lrcText.split(/\r?\n/);
    const tagRegex = /^\[(\d+):(\d+)(?:\.(\d+))?\](.*)$/;

    for (const rawLine of rawLines) {
        const timestamps = [];
        let rest = rawLine;

        while (true) {
            const match = rest.match(tagRegex);
            if (!match)
                break;

            const mins = Number(match[1]);
            const secs = Number(match[2]);
            const frac = match[3] ? Number(`0.${match[3]}`) : 0;
            timestamps.push(mins * 60 + secs + frac);
            rest = match[4];
        }

        if (timestamps.length > 0) {
            const text = rest.trim();
            for (const time of timestamps)
                lines.push({time, text});
        }
    }

    lines.sort((a, b) => a.time - b.time);
    return lines;
}

/**
 * Binary search for the active lyric line index (last line with time <= posSec).
 * Returns -1 if playback is before the first timestamp.
 */
export function findActiveLineIndex(lines, posSec) {
    let lo = 0;
    let hi = lines.length - 1;
    let result = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= posSec) {
            result = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    return result;
}

const VARIANT_KEYWORDS = [
    'live',
    'acoustic',
    'remix',
    'karaoke',
    'sped up',
    'slowed',
    'nightcore',
    'instrumental',
    'demo',
    'radio edit',
];

function normalizeText(str) {
    return (str || '')
        .toLowerCase()
        .replace(/[\u2018\u2019'`]/g, "'")
        .replace(/[^a-z0-9\s']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function cleanTrackTitle(title) {
    if (!title)
        return '';
    return title
        .replace(/\s*[\(\[](?:remaster(?:ed)?|official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|explicit|clean|album\s*version|single\s*version|deluxe(?:\s*edition)?|feat\.?[^\)\]]*|ft\.?[^\)\]]*|\d{4}\s*remaster(?:ed)?)[\)\]]/gi, '')
        .replace(/\s*-\s*(?:remaster(?:ed)?(?:\s*\d{4})?|single|explicit|clean)\s*$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Choose the best matching LRCLIB record from /api/search results.
 */
export function pickBestSearchResult(results, targetDuration, targetTitle = '', targetArtist = '') {
    if (!Array.isArray(results) || results.length === 0)
        return null;

    const normTargetTitle = normalizeText(targetTitle);
    const normCleanTitle = normalizeText(cleanTrackTitle(targetTitle));
    const normTargetArtist = normalizeText(targetArtist);

    let bestItem = null;
    let bestScore = -1e9;

    for (let i = 0; i < results.length; i++) {
        const item = results[i];
        if (!item || typeof item !== 'object')
            continue;

        let score = 0;
        const hasSync = typeof item.syncedLyrics === 'string' && item.syncedLyrics.length > 0;
        const hasPlain = typeof item.plainLyrics === 'string' && item.plainLyrics.length > 0;

        if (hasSync)
            score += 1000;
        else if (hasPlain)
            score += 500;
        else if (item.instrumental)
            score += 100;

        // Duration accuracy is critical for synced lyrics alignment
        if (targetDuration > 0 && typeof item.duration === 'number' && item.duration > 0) {
            const diff = Math.abs(item.duration - targetDuration);
            if (diff <= 1.5)
                score += 550 - diff * 20;
            else if (diff <= 3.0)
                score += 380 - diff * 25;
            else if (diff <= 6.0)
                score += 180 - diff * 20;
            else if (diff <= 12.0)
                score += 40 - diff * 10;
            else
                score -= 100 + diff * 4;
        }

        // Track & artist text similarity
        const itemTitle = normalizeText(item.trackName || item.name || '');
        const itemArtist = normalizeText(item.artistName || '');
        if (normTargetTitle && itemTitle) {
            if (itemTitle === normTargetTitle || itemTitle === normCleanTitle)
                score += 350;
            else if (itemTitle.includes(normCleanTitle) || normCleanTitle.includes(itemTitle))
                score += 150;
        }
        if (normTargetArtist && itemArtist) {
            if (itemArtist === normTargetArtist)
                score += 250;
            else if (itemArtist.includes(normTargetArtist) || normTargetArtist.includes(itemArtist))
                score += 120;
        }

        // Penalize unintended live/remix/acoustic/karaoke variants
        for (const kw of VARIANT_KEYWORDS) {
            const wantedInQuery = normTargetTitle.includes(kw);
            const presentInCandidate = itemTitle.includes(kw);
            if (presentInCandidate && !wantedInQuery)
                score -= 260;
        }

        score -= i * 0.1;

        if (score > bestScore) {
            bestScore = score;
            bestItem = item;
        }
    }

    return bestItem;
}

export function normalizeRecord(record) {
    if (!record || typeof record !== 'object') {
        return {
            found: false,
            hasSynced: false,
            syncedLines: [],
            plainLyrics: '',
            isInstrumental: false,
        };
    }

    if (record.instrumental === true && !record.syncedLyrics && !record.plainLyrics) {
        return {
            found: true,
            hasSynced: false,
            syncedLines: [],
            plainLyrics: '',
            isInstrumental: true,
        };
    }

    const syncedLines = typeof record.syncedLyrics === 'string' && record.syncedLyrics.length > 0
        ? parseLRC(record.syncedLyrics)
        : [];
    const hasSynced = syncedLines.length > 0;

    let plainLyrics = '';
    if (typeof record.plainLyrics === 'string' && record.plainLyrics.length > 0)
        plainLyrics = record.plainLyrics.replace(/\r\n/g, '\n');
    else if (hasSynced)
        plainLyrics = syncedLines.map(l => l.text).join('\n');

    return {
        found: hasSynced || plainLyrics.length > 0,
        hasSynced,
        syncedLines,
        plainLyrics,
        isInstrumental: false,
    };
}

export function formatTime(seconds) {
    const clamped = Math.max(0, Math.floor(seconds || 0));
    const mins = Math.floor(clamped / 60);
    const secs = clamped % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function fetchJSON(session, url, cancellable) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', USER_AGENT);
        message.request_headers.append('Accept', 'application/json');

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                const status = message.get_status();
                if (status !== Soup.Status.OK || !bytes) {
                    resolve(null);
                    return;
                }
                const text = new TextDecoder('utf-8').decode(bytes.get_data());
                resolve(JSON.parse(text));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    reject(e);
                else
                    resolve(null);
            }
        });
    });
}

/**
 * Fetch lyrics from LRCLIB (/api/get with automatic /api/search fallback).
 */
export async function fetchLyrics(session, track, cancellable) {
    const title = (track.title || '').trim();
    const artist = (track.artist || '').trim();
    const album = (track.album || '').trim();
    const duration = Math.round(track.duration || 0);

    if (!title)
        return normalizeRecord(null);

    const exactParams = [
        `track_name=${encodeURIComponent(title)}`,
        `artist_name=${encodeURIComponent(artist)}`,
    ];
    if (album)
        exactParams.push(`album_name=${encodeURIComponent(album)}`);
    if (duration > 0)
        exactParams.push(`duration=${duration}`);

    const exactUrl = `https://lrclib.net/api/get?${exactParams.join('&')}`;
    const exactData = await fetchJSON(session, exactUrl, cancellable);
    if (exactData && (exactData.syncedLyrics || exactData.plainLyrics || exactData.instrumental))
        return normalizeRecord(exactData);

    const searchParams = [
        `track_name=${encodeURIComponent(title)}`,
        `artist_name=${encodeURIComponent(artist)}`,
    ];
    const searchUrl = `https://lrclib.net/api/search?${searchParams.join('&')}`;
    let searchData = await fetchJSON(session, searchUrl, cancellable);
    let best = pickBestSearchResult(searchData, duration, title, artist);

    // Retry with cleaned title if noisy tags (Remastered, Official Video, etc.) missed
    const cleaned = cleanTrackTitle(title);
    if (!best && cleaned && cleaned.toLowerCase() !== title.toLowerCase()) {
        const cleanParams = [
            `track_name=${encodeURIComponent(cleaned)}`,
            `artist_name=${encodeURIComponent(artist)}`,
        ];
        const cleanUrl = `https://lrclib.net/api/search?${cleanParams.join('&')}`;
        searchData = await fetchJSON(session, cleanUrl, cancellable);
        best = pickBestSearchResult(searchData, duration, cleaned, artist);
    }

    return normalizeRecord(best);
}
