const MODULE_ID = 'torbox-torznab';
const TORBOX_API_BASE = 'https://api.torbox.app/v1/api';
const AUDIO_EXTENSIONS = ['flac', 'wav', 'aiff', 'alac', 'ape', 'm4a', 'aac', 'mp3', 'ogg', 'opus'];

let runtimeConfig = {
  torboxApiKey: '',
  prowlarrTorznabUrl: '',
  prowlarrApiKey: '',
  jackettTorznabUrl: '',
  jackettApiKey: '',
  musicCategories: '3000',
  searchLimit: 20,
  torboxTimeoutMs: 90000,
  torboxPollIntervalMs: 2500,
  maxExistingTorrentScan: 250
};

function getConfig() {
  const globalConfig =
    (typeof globalThis !== 'undefined' &&
      globalThis.__EIGHTSPINE_MODULE_CONFIG__ &&
      globalThis.__EIGHTSPINE_MODULE_CONFIG__[MODULE_ID]) ||
    {};
  return { ...runtimeConfig, ...globalConfig };
}

function setConfig(nextConfig) {
  runtimeConfig = { ...runtimeConfig, ...(nextConfig || {}) };
  return runtimeConfig;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[_./]+/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function ensureTorboxApiKey() {
  var apiKey =
    getConfig().torboxApiKey ||
    (typeof globalThis !== 'undefined' ? globalThis.TORBOX_API_KEY : '');
  if (!apiKey) throw new Error('TorBox API key is missing.');
  return apiKey;
}

function ensureTorznabSourceConfig(source) {
  var config = getConfig();
  var url = config[source + 'TorznabUrl'];
  var apiKey = config[source + 'ApiKey'];
  if (!url) throw new Error(source + ' Torznab URL is missing.');
  return { url: url, apiKey: apiKey };
}

async function torboxFetch(path, options) {
  var apiKey = ensureTorboxApiKey();
  var opts = options || {};
  var response = await fetch(TORBOX_API_BASE + path, {
    method: opts.method || 'GET',
    body: opts.body || undefined,
    headers: Object.assign({ Authorization: 'Bearer ' + apiKey }, opts.headers || {})
  });
  var payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(payload.detail || payload.error || 'TorBox request failed.');
  }
  return payload.data;
}

async function torboxCreateTorrent(magnet, name) {
  var body = new FormData();
  body.append('magnet', magnet);
  body.append('name', name || '8spine request');
  body.append('seed', '3');
  body.append('allow_zip', 'false');
  body.append('as_queued', 'false');
  body.append('add_only_if_cached', 'false');
  return torboxFetch('/torrents/createtorrent', { method: 'POST', body: body });
}

function appendParams(baseUrl, params) {
  var url = new URL(baseUrl);
  Object.entries(params).forEach(function (entry) {
    if (entry[1] !== undefined && entry[1] !== null && entry[1] !== '') {
      url.searchParams.set(entry[0], String(entry[1]));
    }
  });
  return url.toString();
}

function getField(xml, tagName) {
  var regex = new RegExp('<' + tagName + '[^>]*>([\\s\\S]*?)<\\/' + tagName + '>', 'i');
  var match = xml.match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

function getAttrValue(xml, attrName) {
  var escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var regex = new RegExp('<(?:torznab:attr|newznab:attr)[^>]*name="' + escaped + '"[^>]*value="([^"]*)"', 'i');
  var match = xml.match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

function getEnclosureUrl(xml) {
  var match = xml.match(/<enclosure[^>]*url="([^"]+)"/i);
  return match ? decodeXml(match[1].trim()) : '';
}

function getExtension(name) {
  var parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function isAudioName(name) {
  return AUDIO_EXTENSIONS.includes(getExtension(name));
}

function parseSearchResultItem(itemXml, source) {
  var title = getField(itemXml, 'title');
  var guid = getField(itemXml, 'guid');
  var link = getField(itemXml, 'link');
  var infoHash = getAttrValue(itemXml, 'infohash').toUpperCase();
  var magnetUrl = getAttrValue(itemXml, 'magneturl');
  var seeders = Number(getAttrValue(itemXml, 'seeders') || 0);
  var size = Number(getAttrValue(itemXml, 'size') || getField(itemXml, 'size') || 0);
  var enclosureUrl = getEnclosureUrl(itemXml);

  var resolvedMagnet =
    magnetUrl ||
    (enclosureUrl.startsWith('magnet:') ? enclosureUrl : '') ||
    (link.startsWith('magnet:') ? link : '') ||
    (infoHash ? 'magnet:?xt=urn:btih:' + encodeURIComponent(infoHash) + '&dn=' + encodeURIComponent(title) : '');

  return { source: source, title: title, guid: guid, link: link, infoHash: infoHash, magnetUrl: resolvedMagnet, seeders: seeders, size: size };
}

function parseTorznabResults(xml, source) {
  var items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return items.map(function (itemXml) { return parseSearchResultItem(itemXml, source); });
}

async function queryTorznabSource(source, query, limit) {
  var cfg = ensureTorznabSourceConfig(source);
  var url = appendParams(cfg.url, {
    apikey: cfg.apiKey || undefined,
    t: 'music',
    q: query,
    cat: getConfig().musicCategories || '3000',
    extended: 1,
    offset: 0,
    limit: limit
  });
  var response = await fetch(url);
  var xml = await response.text();
  if (!response.ok) throw new Error(source + ' search failed with HTTP ' + response.status + '.');
  if (/code="100"|invalid api key|authorization denied|api key/i.test(xml)) throw new Error(source + ' rejected the API request.');
  return parseTorznabResults(xml, source);
}

function parseTitleGuess(rawTitle) {
  var clean = String(rawTitle || '')
    .replace(/\.(flac|wav|aiff|alac|ape|m4a|aac|mp3|ogg|opus)$/i, '')
    .replace(/[._]/g, ' ')
    .trim();
  var artist = 'Unknown Artist';
  var title = clean;
  var album = '';
  var match = clean.match(/^(.*?)\s+-\s+(.*)$/);
  if (match) { artist = match[1].trim() || artist; title = match[2].trim() || title; }
  var albumMatch = title.match(/^(.*?)\s+-\s+(.*?)\s+-\s+(.*)$/);
  if (albumMatch) { artist = albumMatch[1].trim() || artist; album = albumMatch[2].trim(); title = albumMatch[3].trim() || title; }
  return { artist: artist, title: title, album: album };
}

function inferQualityFromTitle(name) {
  var lower = String(name || '').toLowerCase();
  if (lower.includes('flac') || lower.includes('lossless') || lower.includes('24bit') || lower.includes('16bit')) return 'LOSSLESS';
  return 'HIGH';
}

function scoreSearchResult(query, result) {
  var target = normalizeText(result.title);
  var normalizedQuery = normalizeText(query);
  var queryTokens = normalizedQuery.split(' ').filter(Boolean);
  var score = 0;
  if (target.includes(normalizedQuery)) score += 120;
  queryTokens.forEach(function (token) { if (target.includes(token)) score += 12; });
  score += Math.min(result.seeders || 0, 200);
  score += result.size > 0 ? Math.min(Math.floor(result.size / 50000000), 25) : 0;
  score += inferQualityFromTitle(result.title) === 'LOSSLESS' ? 20 : 0;
  score += result.source === 'prowlarr' ? 5 : 0;
  if (!result.magnetUrl) score -= 1000;
  return score;
}

async function searchWithFallbacks(query, limit) {
  var errors = [];
  try {
    var prowlarrResults = await queryTorznabSource('prowlarr', query, limit);
    var filtered = prowlarrResults.filter(function (i) { return i.magnetUrl; });
    if (filtered.length > 0) return filtered;
  } catch (e) { errors.push('Prowlarr: ' + e.message); }
  try {
    var jackettResults = await queryTorznabSource('jackett', query, limit);
    var filtered2 = jackettResults.filter(function (i) { return i.magnetUrl; });
    if (filtered2.length > 0) return filtered2;
  } catch (e) { errors.push('Jackett: ' + e.message); }
  if (errors.length > 0) throw new Error(errors.join(' | '));
  return [];
}

async function findExistingTorrentByHash(infoHash) {
  if (!infoHash) return null;
  var torrents = await torboxFetch('/torrents/mylist?limit=' + encodeURIComponent(getConfig().maxExistingTorrentScan) + '&bypass_cache=true');
  var items = Array.isArray(torrents) ? torrents : (torrents ? [torrents] : []);
  var wantedHash = String(infoHash).toUpperCase();
  for (var i = 0; i < items.length; i++) {
    var torrent = items[i];
    var altHashes = Array.isArray(torrent.alternative_hashes) ? torrent.alternative_hashes : [];
    var candidates = [torrent.hash].concat(altHashes).filter(Boolean).map(function (v) { return String(v).toUpperCase(); });
    if (candidates.includes(wantedHash)) return torrent;
  }
  return null;
}

function chooseBestAudioFile(files) {
  var audioFiles = (Array.isArray(files) ? files : []).filter(function (f) {
    return isAudioName(f.name || f.short_name || '') || String(f.mimetype || '').startsWith('audio/');
  });
  if (audioFiles.length === 0) return null;
  return audioFiles.sort(function (a, b) {
    var qa = inferQualityFromTitle(a.name || a.short_name || '') === 'LOSSLESS' ? 1 : 0;
    var qb = inferQualityFromTitle(b.name || b.short_name || '') === 'LOSSLESS' ? 1 : 0;
    if (qa !== qb) return qb - qa;
    return (b.size || 0) - (a.size || 0);
  })[0];
}

async function waitForTorboxAudio(torrentId) {
  var startedAt = Date.now();
  var timeoutMs = Number(getConfig().torboxTimeoutMs) || 90000;
  var pollMs = Number(getConfig().torboxPollIntervalMs) || 2500;
  while (Date.now() - startedAt < timeoutMs) {
    var torrent = await torboxFetch('/torrents/mylist?id=' + encodeURIComponent(torrentId) + '&bypass_cache=true');
    var audioFile = chooseBestAudioFile(torrent.files);
    if (audioFile && (torrent.download_finished || torrent.cached || torrent.download_present)) {
      return { torrent: torrent, file: audioFile };
    }
    await sleep(pollMs);
  }
  throw new Error('Timed out waiting for TorBox to prepare the audio file.');
}

async function resolveTrackToTorbox(trackPayload) {
  var existing = await findExistingTorrentByHash(trackPayload.infoHash);
  if (existing) {
    var existingFile = chooseBestAudioFile(existing.files);
    if (existingFile) return { torrentId: existing.id, fileId: existingFile.id, fileName: existingFile.name || existingFile.short_name || trackPayload.title };
  }
  var created = await torboxCreateTorrent(trackPayload.magnetUrl, trackPayload.title);
  var ready = await waitForTorboxAudio(created.torrent_id);
  return { torrentId: ready.torrent.id, fileId: ready.file.id, fileName: ready.file.name || ready.file.short_name || trackPayload.title };
}

return {
  id: MODULE_ID,
  name: 'TorBox + Prowlarr/Jackett',
  version: '0.3.0',
  labels: ['TORBOX', 'PROWLARR', 'JACKETT'],

  settings: [
    { key: 'torboxApiKey', type: 'password', label: 'TorBox API Key', placeholder: 'Paste your TorBox API key' },
    { key: 'prowlarrTorznabUrl', type: 'text', label: 'Prowlarr Torznab URL', placeholder: 'http://localhost:9696/1/api' },
    { key: 'prowlarrApiKey', type: 'password', label: 'Prowlarr API Key', placeholder: 'Paste your Prowlarr API key' },
    { key: 'jackettTorznabUrl', type: 'text', label: 'Jackett Torznab URL', placeholder: 'http://localhost:9117/api/v2.0/indexers/all/results/torznab/api' },
    { key: 'jackettApiKey', type: 'password', label: 'Jackett API Key', placeholder: 'Paste your Jackett API key' }
  ],

  setConfig: setConfig,
  configure: setConfig,

  searchTracks: async function (query, limit) {
    var resolvedLimit = Number(limit || getConfig().searchLimit || 20);
    var results = await searchWithFallbacks(query, resolvedLimit);
    var tracks = results
      .map(function (result) {
        var parsed = parseTitleGuess(result.title);
        return {
          id: JSON.stringify({ source: result.source, title: result.title, magnetUrl: result.magnetUrl, infoHash: result.infoHash, seeders: result.seeders, size: result.size }),
          title: parsed.title,
          artist: parsed.artist,
          album: parsed.album || result.source,
          duration: 0,
          albumCover: '',
          _score: scoreSearchResult(query, result)
        };
      })
      .sort(function (a, b) { return b._score - a._score; })
      .slice(0, resolvedLimit)
      .map(function (track) {
        return { id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, albumCover: track.albumCover };
      });
    return { tracks: tracks, total: tracks.length };
  },

  getTrackStreamUrl: async function (trackId, quality) {
    var payload = typeof trackId === 'string' ? JSON.parse(trackId) : trackId;
    var resolved = await resolveTrackToTorbox(payload);
    var apiKey = ensureTorboxApiKey();
    var streamUrl = await torboxFetch(
      '/torrents/requestdl?token=' + encodeURIComponent(apiKey) +
      '&torrent_id=' + encodeURIComponent(resolved.torrentId) +
      '&file_id=' + encodeURIComponent(resolved.fileId) +
      '&redirect=false&append_name=true'
    );
    return {
      streamUrl: streamUrl,
      track: { id: trackId, audioQuality: quality === 'LOSSLESS' ? 'LOSSLESS' : inferQualityFromTitle(resolved.fileName) }
    };
  }
};
