require('dotenv').config();

const express = require('express');
const app = express();
const PORT = 3001;

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Masukkan judul lagu.' });
  }

  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'API key belum dikonfigurasi.' });
  }

  try {
    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      videoCategoryId: '10',
      maxResults: '10',
      key: process.env.YOUTUBE_API_KEY
    });

    const response = await fetch(
      'https://www.googleapis.com/youtube/v3/search?' + params
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('YouTube API error:', data.error?.message);
      return res.status(response.status).json({
        error: data.error?.message || 'Pencarian gagal.'
      });
    }

    res.json({
      items: (data.items || []).filter(item => item.id?.videoId).map(item => ({
        id: item.id.videoId,
        title: item.snippet.title,
        artist: item.snippet.channelTitle,
        cover: item.snippet.thumbnails.high?.url ||
          item.snippet.thumbnails.default?.url,
        source: 'youtube'
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menghubungi YouTube.' });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log('Backend YouTube aktif di http://127.0.0.1:' + PORT);
});
