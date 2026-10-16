import { createClient } from '@supabase/supabase-js';
'use strict';

const $ = id => document.getElementById(id);
const AUDIO_API = 'https://api.audius.co/v1';
const MAX_QUEUE = 100;
const MAX_HISTORY = 100;

const firebaseConfig = {
  apiKey: 'AIzaSyDtLdgk-tExdPeycx6yfdvPSADdqYdbeJ0',
  databaseURL: 'https://testwebesp-default-rtdb.firebaseio.com'
};

let db = null, queueRef = null, currentTrackRef = null;
let currentTrack = null, queue = [], recommendations = [];
let history = loadLocalHistory();
let isPlaying = false, isAdvancing = false, recommendationInProgress = false;
let autoMixEnabled = $('autoMixToggle')?.checked ?? true;
let lastHistoryId = null, lastRemoteCommand = 0, toastTimer = null;
let lyrics = [], lyricsForTrack = null;


let ytPlayer = null;
let ytApiReady = false;
let ytPendingVideoId = null;
let ytIsPlaying = false;
let ytProgressTimer = null;

(function loadYouTubeAPI() {
  if (document.querySelector('script[data-youtube-iframe-api]')) return;
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.dataset.youtubeIframeApi = 'true';
  document.head.appendChild(script);
  window.onYouTubeIframeAPIReady = () => {
    ytApiReady = true;
    initYouTubePlayer();
  };
})();

function initYouTubePlayer() {
  if (!ytApiReady || ytPlayer) return;
  ytPlayer = new YT.Player('youtubePlayerFrame', {
    width: '100%',
    height: '100%',
    videoId: ytPendingVideoId || '',
    playerVars: { playsinline: 1, origin: location.origin },
    events: {
      onReady: () => {
        if (ytPendingVideoId) ytPlayer.loadVideoById(ytPendingVideoId);
      },
      onStateChange: event => {
        if (event.data === YT.PlayerState.PLAYING) {
          setTimeout(() => {
            if (currentTrack) updateMediaSession(currentTrack);
          }, 300);
          ytIsPlaying = true;
          isPlaying = true;
          $('playerStatus').textContent = 'Sedang diputar di YouTube';
          playBtn.innerHTML = '<i class="ph-bold ph-pause"></i>';
          playBtn.setAttribute('aria-label', 'Jeda');
          if (currentTrack) addHistory(currentTrack);
          startYouTubeProgress();
        } else if (event.data === YT.PlayerState.PAUSED) {
          ytIsPlaying = false;
          isPlaying = false;
          resetPlayButton();
          $('playerStatus').textContent = 'Dijeda';
          stopYouTubeProgress();
        } else if (event.data === YT.PlayerState.ENDED) {
          ytIsPlaying = false;
          stopYouTubeProgress();
          advanceTrack();
        } else if (event.data === YT.PlayerState.BUFFERING) {
          $('playerStatus').textContent = 'Memuat YouTube…';
        }
      },
      onError: event => {
        ytIsPlaying = false;
        stopYouTubeProgress();
        $('playerStatus').textContent = 'Video tidak dapat diputar';
        showToast('YouTube menolak pemutaran video ini.');
        console.warn('YouTube Player error:', event.data);
      }
    }
  });
}

function startYouTubeProgress() {
  stopYouTubeProgress();
  ytProgressTimer = setInterval(() => {
    if (!ytPlayer || !currentTrack || currentTrack.source !== 'youtube') return;
    let current = 0, duration = 0;
    try {
      current = ytPlayer.getCurrentTime() || 0;
      duration = ytPlayer.getDuration() || 0;
    } catch (_) { return; }
    const percent = duration ? Math.min(100, current / duration * 100) : 0;
    currentTimeEl.textContent = formatTime(current);
    durationEl.textContent = formatTime(duration);
    progressFill.style.width = percent + '%';
    $('progressBar').setAttribute('aria-valuenow', String(Math.round(percent)));
    syncLyrics(current);
  }, 500);
}

function stopYouTubeProgress() {
  if (ytProgressTimer) clearInterval(ytProgressTimer);
  ytProgressTimer = null;
}

function stopYouTube() {
  stopYouTubeProgress();
  ytIsPlaying = false;
  if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
    try { ytPlayer.stopVideo(); } catch (_) {}
  }
  $('youtubePlayerPanel').hidden = true;
}

function playYouTubeVideo(song) {
  $('youtubePlayerPanel').hidden = false;
  ytPendingVideoId = song.id;
  if (!ytApiReady) {
    $('playerStatus').textContent = 'Menyiapkan YouTube…';
    showToast('YouTube sedang disiapkan. Tekan Putar lagi sebentar lagi.');
    return;
  }
  initYouTubePlayer();
  if (!ytPlayer || typeof ytPlayer.loadVideoById !== 'function') return;
  ytPlayer.loadVideoById(song.id);
  if (ytPlayer.playVideo) ytPlayer.playVideo();
  if (song.duration) durationEl.textContent = formatTime(song.duration);
}

const audio = document.createElement('audio');
audio.id = 'audioPlayer';
audio.preload = 'metadata';
audio.style.display = 'none';
document.body.appendChild(audio);

const playerCover = $('playerCover');
const playerTitle = $('playerTitle');
const playerArtist = $('playerArtist');
const playBtn = $('playBtn');
const progressFill = $('progressFill');
const currentTimeEl = $('currentTime');
const durationEl = $('duration');
const resultsSection = $('resultsSection');
const resultsGrid = $('resultsGrid');
const playlistContainer = $('playlistContainer');
const historyContainer = $('historyContainer');
const recommendationGrid = $('recommendationGrid');

function showToast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function normalizeTrack(t) {
  if (!t || t.id == null) return null;
  const id = String(t.id);
  if (!/^[\w-]{1,80}$/.test(id)) return null;

  const secureUrl = value =>
    typeof value === 'string' && /^https:\/\//i.test(value)
      ? value : '';

  return {
    id,
    title: String(t.title || 'Tanpa judul').slice(0, 200),
    artist: String(t.artist || 'Artis tidak diketahui').slice(0, 200),
    cover: secureUrl(t.cover),
    duration: Number(t.duration) || 0,
    source: ['itunes', 'supabase', 'youtube'].includes(t.source)
      ? t.source : 'audius',
    previewUrl: secureUrl(t.previewUrl),
    audioUrl: secureUrl(t.audioUrl)
  };
}
function loadLocalHistory() {
  try {
    const data = JSON.parse(localStorage.getItem('exwann_history') || '[]');
    return Array.isArray(data)
      ? data.map(normalizeTrack).filter(Boolean).slice(0, MAX_HISTORY)
      : [];
  } catch { return []; }
}

function saveLocalHistory() {
  try {
    localStorage.setItem('exwann_history', JSON.stringify(history));
  } catch (e) { console.warn('Riwayat gagal disimpan:', e); }
}

function trackFromAudius(t) {
  const artwork = t.artwork || {};
  return normalizeTrack({
    id: t.id,
    title: t.title,
    artist: t.user?.name || t.artist || 'Artis tidak diketahui',
    cover: artwork['480x480'] || artwork['150x150'] || artwork['1000x1000'] || '',
    duration: t.duration
  });
}

async function audiusSearch(query, limit = 12) {
  const params = new URLSearchParams({ query, limit: String(limit) });
  const response = await fetch(`${AUDIO_API}/tracks/search?${params}`);
  if (!response.ok) throw new Error(`Audius HTTP ${response.status}`);
  const data = await response.json();
  return (data.data || []).filter(t => t.is_available !== false)
    .map(trackFromAudius).filter(Boolean);
}

async function itunesSearch(query, limit = 12) {
  const params = new URLSearchParams({
    term: query, entity: 'song', limit: String(limit)
  });
  const response = await fetch('https://itunes.apple.com/search?' + params);
  if (!response.ok) throw Error('iTunes HTTP ' + response.status);
  const data = await response.json();
  return (data.results || []).map(t => normalizeTrack({
    id: 'itunes-' + t.trackId,
    title: t.trackName,
    artist: t.artistName,
    cover: t.artworkUrl100 || '',
    duration: Math.round((t.trackTimeMillis || 0) / 1000),
    source: 'itunes',
    previewUrl: t.previewUrl || ''
  })).filter(t => t && t.previewUrl);
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

async function supabaseSearch(query, limit = 12) {
  if (!supabase) return [];

  const term = query.replace(/[,%_()]/g, ' ').trim();
  if (!term) return [];

  const { data, error } = await supabase
    .from('songs')
    .select('id,title,artist,cover_url,audio_path,duration')
    .or('title.ilike.%' + term + '%,artist.ilike.%' + term + '%')
    .limit(limit);

  if (error) {
    console.warn('Pencarian katalog Supabase gagal:', error.message);
    return [];
  }

  return (data || []).map(row => {
    const path = String(row.audio_path || '');
    const audioUrl = /^https:\/\//i.test(path)
      ? path
      : supabase.storage.from('audio').getPublicUrl(path).data.publicUrl;

    return normalizeTrack({
      id: 'supabase-' + row.id,
      title: row.title,
      artist: row.artist,
      cover: row.cover_url || '',
      duration: row.duration,
      source: 'supabase',
      audioUrl
    });
  }).filter(track => track && track.audioUrl);
}

async function searchAudius() {
  const input = $('searchInput');
  const query = input.value.trim();
  if (!query) return;

  resultsSection.hidden = false;
  showSearchResultsMessage('Mencari katalog, Audius, dan iTunes…');

  const results = await Promise.allSettled([
    supabaseSearch(query, 12),
    audiusSearch(query, 12),
    itunesSearch(query, 12)
  ]);

  const s = results[0].status === 'fulfilled' ? results[0].value : [];
  const a = results[1].status === 'fulfilled' ? results[1].value : [];
  const i = results[2].status === 'fulfilled' ? results[2].value : [];

  if (results.every(r => r.status === 'rejected')) {
    console.error('Pencarian gagal:', results);
    showSearchResultsMessage('Pencarian gagal. Periksa koneksi internet.');
    return;
  }

  const seen = new Set();
  const tracks = [...s, ...a, ...i].filter(t => {
    const key = (t.title + ' ' + t.artist)
      .toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  renderTrackCards(resultsGrid, tracks, 'Lagu tidak ditemukan.');
  input.value = '';
  if (tracks.length) {
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function showSearchResultsMessage(message) {
  resultsSection.hidden = false;
  const p = document.createElement('p');
  p.className = 'status-message';
  p.textContent = message;
  resultsGrid.replaceChildren(p);
}

async function youtubeSearch(query, limit = 12) {
  try {
    const response = await fetch('/api/search?q=' + encodeURIComponent(query));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Pencarian YouTube gagal');
    return (data.items || []).filter(item => item.id).slice(0, limit).map(item => ({
      id: item.id, title: item.title, artist: item.artist, cover: item.cover, duration: 0, source: 'youtube'
    }));
  } catch (error) {
    console.warn('Pencarian YouTube:', error);
    return [];
  }
}
function renderTrackCards(container, tracks, emptyText) {
  container.replaceChildren();
  if (!tracks.length) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = emptyText;
    container.appendChild(p);
    return;
  }

  tracks.forEach(track => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'music-card';

    const wrap = document.createElement('div');
    wrap.className = 'card-thumb-wrap';

    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = track.cover || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=400&q=80';
    img.alt = 'Sampul lagu';
    img.loading = 'lazy';

    const overlay = document.createElement('div');
    overlay.className = 'play-overlay';
    const circle = document.createElement('div');
    circle.className = 'play-btn-circle';
    circle.innerHTML = '<i class="ph-bold ph-play"></i>';
    overlay.appendChild(circle);
    wrap.append(img, overlay);

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = track.title;

    const artist = document.createElement('div');
    artist.className = 'card-artist';
    artist.textContent = track.artist;

    card.append(wrap, title, artist);
    card.addEventListener('click', () => playTrackNow(track));
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      addToQueue(track);
    });
    container.appendChild(card);
  });
}

function connectFirebase() {
  try {
    if (!window.firebase) return;
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    queueRef = db.ref('music/queue');
    currentTrackRef = db.ref('music/currentTrack');

    queueRef.on('value', snapshot => {
      const data = snapshot.val();
      const list = Array.isArray(data) ? data : data ? Object.values(data) : [];
      queue = list.map(normalizeTrack).filter(Boolean).slice(0, MAX_QUEUE);
      renderQueue();
    }, e => console.warn('Firebase queue:', e));

    currentTrackRef.on('value', snapshot => {
      const remote = snapshot.val();
      if (!remote?.track || remote.commandId === lastRemoteCommand) return;
      if (remote.commandId) lastRemoteCommand = remote.commandId;
      const track = normalizeTrack(remote.track);
      if (track) playTrackNow(track, false);
    }, e => console.warn('Firebase current track:', e));
  } catch (e) {
    console.warn('Firebase tidak tersedia:', e);
    showToast('Mode lokal aktif. Firebase gagal terhubung.');
  }
}

function persistQueue() {
  if (queueRef) {
    queueRef.set(queue).catch(e => {
      console.warn(e);
      showToast('Antrean gagal disinkronkan.');
    });
  }
}

function publishCurrentTrack(track) {
  if (!currentTrackRef) return;
  const commandId = Date.now();
  lastRemoteCommand = commandId;
  currentTrackRef.set({ track, commandId }).catch(e => console.warn(e));
}

function addToQueue(track) {
  const song = normalizeTrack(track);
  if (!song) return;
  if (queue.length >= MAX_QUEUE) return showToast('Antrean sudah penuh.');
  queue.push(song);
  renderQueue();
  persistQueue();
  showToast(`Ditambahkan: ${song.title}`);
}

function playNext(track) {
  const song = normalizeTrack(track);
  if (!song) return;
  if (queue.length >= MAX_QUEUE) return showToast('Antrean sudah penuh.');
  queue.unshift(song);
  renderQueue();
  persistQueue();
  showToast('Lagu masuk ke urutan berikutnya.');
}

function renderQueue() {
  if (!playlistContainer) return;
  playlistContainer.replaceChildren();
  $('queueCount').textContent = `${queue.length} lagu`;

  if (!queue.length) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Antrean kosong. Klik kanan hasil lagu untuk menambahkannya.';
    playlistContainer.appendChild(p);
    return;
  }

  queue.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = 'track-row';

    const number = document.createElement('span');
    number.className = 'row-index';
    number.textContent = String(index + 1);

    const img = document.createElement('img');
    img.className = 'track-row-thumb';
    img.src = track.cover || '';
    img.alt = 'Sampul';

    const info = document.createElement('div');
    info.className = 'track-row-info';
    const title = document.createElement('div');
    title.className = 'track-row-title';
    title.textContent = track.title;
    const artist = document.createElement('div');
    artist.className = 'track-row-artist';
    artist.textContent = track.artist;
    info.append(title, artist);
    info.addEventListener('click', () => playQueuedTrack(index));

    const wrap = document.createElement('div');
    wrap.className = 'track-menu-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'track-menu-button';
    btn.textContent = '⋮';
    const menu = document.createElement('div');
    menu.className = 'track-menu';
    menu.hidden = true;

    [
      ['Putar sekarang', () => playQueuedTrack(index)],
      ['Putar berikutnya', () => moveQueueTrack(index, 0)],
      ['Pindah ke bawah', () => moveQueueTrack(index, Math.min(queue.length - 1, index + 1))],
      ['Hapus dari antrean', () => removeQueueTrack(index)]
    ].forEach(([label, action]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', e => {
        e.stopPropagation();
        menu.hidden = true;
        action();
      });
      menu.appendChild(b);
    });

    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.track-menu').forEach(m => {
        if (m !== menu) m.hidden = true;
      });
      menu.hidden = !menu.hidden;
    });

    wrap.append(btn, menu);
    row.append(number, img, info, wrap);
    playlistContainer.appendChild(row);
  });
}

function playQueuedTrack(index) {
  if (index < 0 || index >= queue.length) return;
  const [track] = queue.splice(index, 1);
  renderQueue();
  persistQueue();
  playTrackNow(track);
}

function moveQueueTrack(from, to) {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
  const [track] = queue.splice(from, 1);
  queue.splice(to, 0, track);
  renderQueue();
  persistQueue();
}

function removeQueueTrack(index) {
  if (index < 0 || index >= queue.length) return;
  queue.splice(index, 1);
  renderQueue();
  persistQueue();
}

function handlePlaybackFailure(error) {
  const failedTrack = currentTrack;
  if (!failedTrack || audio.dataset.failedTrackId === failedTrack.id) return;

  audio.dataset.failedTrackId = failedTrack.id;
  console.warn('Lagu gagal dimuat:', failedTrack.title, error || '');
  $('playerStatus').textContent = 'Lagu gagal dimuat';

  if (queue.length || autoMixEnabled) {
    showToast('Lagu gagal diputar. Melanjutkan ke lagu berikutnya…');
    setTimeout(() => {
      if (currentTrack?.id === failedTrack.id &&
          audio.dataset.failedTrackId === failedTrack.id) {
        advanceTrack();
      }
    }, 0);
  } else {
    showToast('Lagu gagal diputar. Coba lagu lain.');
  }
}

function playTrackNow(track, broadcast = true) {
  const song = normalizeTrack(track);
  if (!song) return;

  currentTrack = song;
  audio.dataset.failedTrackId = '';
  lyricsForTrack = null;
  lyrics = [];
  playerTitle.textContent = song.title;
  playerArtist.textContent = song.artist;
  playerCover.src = song.cover || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=200&q=80';
  $('playerStatus').textContent = 'Memuat lagu…';
  resetProgress();
  updateMediaSession(song);
  renderLyricsMessage('Mencari lirik…');

  if (song.source === 'youtube') {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    playYouTubeVideo(song);
    if (broadcast) publishCurrentTrack(song);
  } else {
    stopYouTube();
    audio.src = song.source === 'supabase'
      ? song.audioUrl
      : song.source === 'itunes'
        ? song.previewUrl
        : AUDIO_API + '/tracks/' + encodeURIComponent(song.id) + '/stream';
    audio.load();
    audio.play().then(() => {
      if (broadcast) publishCurrentTrack(song);
    }).catch(e => {
      if (e.name === 'NotAllowedError') {
        showToast('Tekan Putar untuk memulai audio.');
        return;
      }
      if (e.name === 'AbortError') return;
      handlePlaybackFailure(e);
    });
  }

  fetchLyrics(song);
}

function renderHistory() {
  if (!historyContainer) return;
  historyContainer.replaceChildren();

  if (!history.length) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Belum ada riwayat pemutaran di perangkat ini.';
    historyContainer.appendChild(p);
    return;
  }

  history.forEach(track => {
    const row = document.createElement('div');
    row.className = 'track-row';

    const img = document.createElement('img');
    img.className = 'track-row-thumb';
    img.src = track.cover || '';
    img.alt = 'Sampul';

    const info = document.createElement('div');
    info.className = 'track-row-info';
    const title = document.createElement('div');
    title.className = 'track-row-title';
    title.textContent = track.title;
    const artist = document.createElement('div');
    artist.className = 'track-row-artist';
    artist.textContent = track.artist;
    info.append(title, artist);
    info.addEventListener('click', () => playTrackNow(track));

    const wrap = document.createElement('div');
    wrap.className = 'track-menu-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'track-menu-button';
    btn.textContent = '⋮';
    const menu = document.createElement('div');
    menu.className = 'track-menu';
    menu.hidden = true;

    [
      ['Putar sekarang', () => playTrackNow(track)],
      ['Tambahkan ke antrean', () => addToQueue(track)],
      ['Putar berikutnya', () => playNext(track)]
    ].forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', e => {
        e.stopPropagation();
        menu.hidden = true;
        fn();
      });
      menu.appendChild(b);
    });

    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.track-menu').forEach(m => {
        if (m !== menu) m.hidden = true;
      });
      menu.hidden = !menu.hidden;
    });

    wrap.append(btn, menu);
    row.append(img, info, wrap);
    historyContainer.appendChild(row);
  });
}

async function fetchRecommendations() {
  if (recommendationInProgress || !currentTrack) return recommendations;
  recommendationInProgress = true;

  try {
    recommendations = await audiusSearch(currentTrack.artist, 15);
    const seen = new Set([
      currentTrack.id,
      ...history.map(t => t.id),
      ...queue.map(t => t.id)
    ]);
    recommendations = recommendations.filter(t => !seen.has(t.id));
    renderTrackCards(recommendationGrid, recommendations, 'Belum ada rekomendasi.');
    return recommendations;
  } catch (e) {
    console.warn('Auto-Mix gagal:', e);
    return [];
  } finally {
    recommendationInProgress = false;
  }
}

async function advanceTrack() {
  if (isAdvancing) return;
  isAdvancing = true;

  try {
    if (queue.length) {
      const next = queue.shift();
      renderQueue();
      persistQueue();
      playTrackNow(next);
      return;
    }

    if (!autoMixEnabled) {
      $('playerStatus').textContent = 'Antrean selesai';
      playerTitle.textContent = 'Antrean selesai';
      playerArtist.textContent = 'Tambahkan lagu untuk melanjutkan';
      return;
    }

    $('playerStatus').textContent = 'Mencari rekomendasi…';
    const tracks = await fetchRecommendations();
    const next = tracks.find(t =>
      !history.some(h => h.id === t.id) &&
      !queue.some(q => q.id === t.id)
    );

    if (next) playTrackNow(next);
    else {
      $('playerStatus').textContent = 'Rekomendasi tidak tersedia';
      showToast('Auto-Mix belum menemukan lagu lain.');
    }
  } finally {
    isAdvancing = false;
  }
}

function addHistory(track) {
  const song = normalizeTrack(track);
  if (!song || lastHistoryId === song.id) return;
  lastHistoryId = song.id;
  history = [{ ...song, playedAt: Date.now() },
    ...history.filter(t => t.id !== song.id)].slice(0, MAX_HISTORY);
  saveLocalHistory();
  renderHistory();
}

function resetPlayButton() {
  playBtn.innerHTML = '<i class="ph-bold ph-play"></i>';
  playBtn.setAttribute('aria-label', 'Putar');
}

function togglePlay() {
  if (!currentTrack) { showToast("Cari lagu terlebih dahulu."); return; }
  if (currentTrack.source === 'youtube') {
    if (!ytPlayer || !ytApiReady) { playYouTubeVideo(currentTrack); return; }
    if (ytIsPlaying) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
    return;
  }
  if (audio.paused) audio.play().catch(() => showToast("Tekan Putar sekali lagi."));
  else audio.pause();
}
function nextTrack() {
  if (queue.length) playQueuedTrack(0);
  else advanceTrack();
}

function prevTrack() {
  if (currentTrack?.source === 'youtube' && ytPlayer) {
    try { if (ytPlayer.getCurrentTime() > 3) { ytPlayer.seekTo(0, true); return; } } catch (_) {}
  } else if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const previous = history.find(t => t.id !== currentTrack?.id);
  if (previous) playTrackNow(previous);
  else if (currentTrack?.source === 'youtube' && ytPlayer) ytPlayer.seekTo(0, true);
  else if (currentTrack) audio.currentTime = 0;
}
function formatTime(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function resetProgress() {
  progressFill.style.width = '0%';
  currentTimeEl.textContent = '0:00';
  durationEl.textContent = '0:00';
  $('progressBar').setAttribute('aria-valuenow', '0');
}

function updateProgress() {
  const current = audio.currentTime || 0;
  const duration = audio.duration || currentTrack?.duration || 0;
  const percent = duration > 0 ? Math.min(100, current / duration * 100) : 0;
  currentTimeEl.textContent = formatTime(current);
  durationEl.textContent = formatTime(duration);
  progressFill.style.width = `${percent}%`;
  $('progressBar').setAttribute('aria-valuenow', String(Math.round(percent)));
  syncLyrics(current);
}

function seekTrack(event) {
  if (currentTrack?.source === 'youtube' && ytPlayer) {
    let duration = 0;
    try { duration = ytPlayer.getDuration() || 0; } catch (_) {}
    if (!duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX ?? rect.left;
    const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    ytPlayer.seekTo(ratio * duration, true);
    return;
  }
  const duration = audio.duration;
  if (!duration) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX ?? rect.left;
  const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  audio.currentTime = ratio * duration;
}
function updateMediaSession(track) {
  if (!('mediaSession' in navigator) ||
      typeof MediaMetadata === 'undefined' || !track) return;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || 'Tanpa judul',
      artist: track.artist || 'Artis tidak diketahui',
      album: 'exWann Music',
      artwork: track.cover
        ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }]
        : []
    });

    const playing = currentTrack?.source === 'youtube'
      ? !!(ytPlayer &&
          typeof ytPlayer.getPlayerState === 'function' &&
          ytPlayer.getPlayerState() === 1)
      : !!audio && !audio.paused;

    navigator.mediaSession.playbackState =
      playing ? 'playing' : 'paused';

    const handlers = {
      play: () => togglePlay(),
      pause: () => {
        if (currentTrack?.source === 'youtube' &&
            ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
          ytPlayer.pauseVideo();
        } else if (audio) {
          audio.pause();
        }
      },
      previoustrack: () => prevTrack(),
      nexttrack: () => nextTrack()
    };

    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (err) {
        console.warn('Media action tidak didukung:', action);
      }
    }
  } catch (err) {
    console.warn('Media Session gagal:', err);
  }
}

/* Panel lirik. LRCLIB tidak selalu memiliki lirik untuk semua lagu. */
const lyricStyle = document.createElement('style');
lyricStyle.textContent = `
#lyricsPanel{margin:24px 0;padding:20px;border:1px solid var(--border,#ffffff20);
border-radius:16px;background:rgba(255,255,255,.025)}
#lyricsPanel h2{font-size:17px;margin:0 0 12px}
#lyricsContent{max-height:300px;overflow:auto;text-align:center;line-height:1.8;color:var(--muted,#aaa)}
#lyricsContent .lyric-line{padding:3px 0}
#lyricsContent .active-lyric{color:var(--primary,#57f5d4);font-weight:800;font-size:1.08em}
`;
document.head.appendChild(lyricStyle);

const lyricsPanel = document.createElement('section');
lyricsPanel.id = 'lyricsPanel';
lyricsPanel.innerHTML = '<h2><i class="ph-bold ph-music-notes"></i> Lirik lagu</h2><div id="lyricsContent">Putar lagu untuk mencari lirik.</div>';
const main = document.querySelector('main');
if (main) main.appendChild(lyricsPanel);
else document.body.insertBefore(lyricsPanel, document.querySelector('footer'));

function renderLyricsMessage(message) {
  const el = $('lyricsContent');
  if (el) el.textContent = message;
}

function parseLrc(text) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const content = line.replace(/\[[^\]]+\]/g, '').trim();
    if (!content || !matches.length) continue;
    for (const m of matches) {
      const fraction = m[3] ? Number(`0.${m[3]}`) : 0;
      lines.push({
        time: Number(m[1]) * 60 + Number(m[2]) + fraction,
        text: content
      });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

async function fetchLyrics(track) {
  const key = track.id;
  lyricsForTrack = key;
  renderLyricsMessage('Mencari lirik tersinkronisasi…');

  try {
    const params = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artist
    });
    if (track.duration) params.set('duration', String(Math.round(track.duration)));

    let response = await fetch(`https://lrclib.net/api/get?${params}`);
    let data = response.ok ? await response.json() : null;

    if (!data?.syncedLyrics) {
      const searchParams = new URLSearchParams({
        track_name: track.title,
        artist_name: track.artist
      });
      response = await fetch(`https://lrclib.net/api/search?${searchParams}`);
      const results = response.ok ? await response.json() : [];
      data = Array.isArray(results)
        ? results.find(x => x.syncedLyrics) || results.find(x => x.plainLyrics)
        : null;
    }

    if (lyricsForTrack !== key) return;
    if (data?.syncedLyrics) {
      lyrics = parseLrc(data.syncedLyrics);
      renderLyricsLines(lyrics);
    } else if (data?.plainLyrics) {
      renderLyricsMessage(data.plainLyrics);
    } else {
      renderLyricsMessage('Lirik tersinkronisasi belum tersedia untuk lagu ini.');
    }
  } catch (e) {
    console.warn('Pencarian lirik gagal:', e);
    if (lyricsForTrack === key) renderLyricsMessage('Lirik tidak dapat dimuat. Periksa koneksi.');
  }
}

function renderLyricsLines(lines) {
  const el = $('lyricsContent');
  if (!el) return;
  el.replaceChildren();
  lines.forEach((line, index) => {
    const p = document.createElement('div');
    p.className = 'lyric-line';
    p.dataset.time = String(line.time);
    p.textContent = line.text;
    el.appendChild(p);
  });
}

function syncLyrics(time) {
  if (!lyrics.length) return;
  const nodes = $('lyricsContent')?.querySelectorAll('.lyric-line');
  if (!nodes?.length) return;
  let active = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].time <= time) active = i;
    else break;
  }
  nodes.forEach((node, i) => {
    node.classList.toggle('active-lyric', i === active);
    if (i === active) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

audio.addEventListener('play', () => {
  isPlaying = true;
  $('playerStatus').textContent = 'Sedang diputar';
  playBtn.innerHTML = '<i class="ph-bold ph-pause"></i>';
  playBtn.setAttribute('aria-label', 'Jeda');
  if (currentTrack) addHistory(currentTrack);
});
audio.addEventListener('pause', () => {
  isPlaying = false;
  resetPlayButton();
  if (currentTrack && audio.ended) return;
  $('playerStatus').textContent = 'Dijeda';
});
audio.addEventListener('waiting', () => { $('playerStatus').textContent = 'Memuat…'; });
audio.addEventListener('playing', () => { $('playerStatus').textContent = 'Sedang diputar'; });
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('durationchange', updateProgress);
audio.addEventListener('ended', advanceTrack);
audio.addEventListener('error', () => {
  handlePlaybackFailure(audio.error);
});

$('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  searchAudius();
});
$('closeYoutubePlayer')?.addEventListener('click', () => {
  $('youtubePlayerPanel').hidden = true;
});
$('playBtn').addEventListener('click', togglePlay);
$('nextBtn').addEventListener('click', nextTrack);
$('prevBtn').addEventListener('click', prevTrack);
$('progressBar').addEventListener('click', seekTrack);
$('progressBar').addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  audio.currentTime = Math.max(0, Math.min(
    audio.duration || 0,
    audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5)
  ));
});
$('clearHistoryBtn').addEventListener('click', () => {
  history = [];
  lastHistoryId = null;
  saveLocalHistory();
  renderHistory();
  showToast('Riwayat dihapus.');
});
$('autoMixToggle').addEventListener('change', e => {
  autoMixEnabled = e.target.checked;
  showToast(`Auto-Mix ${autoMixEnabled ? 'diaktifkan' : 'dinonaktifkan'}.`);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.track-menu-wrap')) {
    document.querySelectorAll('.track-menu').forEach(m => m.hidden = true);
  }
});

renderQueue();
renderHistory();
connectFirebase();

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .catch(e => console.warn('Service Worker:', e));
}
