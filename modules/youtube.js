// modules/youtube.js
// YouTube Data API v3: upload video + thumbnail + captions + pinned comment.

const fs = require('fs');
const { google } = require('googleapis');

function getAuthClient() {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    throw new Error('YouTube OAuth env vars missing. Run node setup-youtube.js once.');
  }
  const oauth2 = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, 'http://localhost:8765/oauth2callback');
  oauth2.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  return oauth2;
}

async function uploadVideo({ videoPath, thumbnailPath, srtPath, metadata, isShort = false }) {
  const auth = getAuthClient();
  const yt = google.youtube({ version: 'v3', auth });

  const snippet = {
    title: metadata.title,
    description: metadata.description,
    tags: (metadata.tags || []).slice(0, 25),
    categoryId: String(metadata.category_id || 27),
    defaultLanguage: metadata.default_language || 'en',
    defaultAudioLanguage: metadata.default_audio_language || 'en',
  };

  const status = {
    privacyStatus: 'public',
    selfDeclaredMadeForKids: false,
    embeddable: true,
  };

  console.log(`[youtube] uploading ${isShort ? 'Short' : 'video'}: ${snippet.title}`);
  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: { snippet, status },
    media: { body: fs.createReadStream(videoPath) },
  }, { maxContentLength: Infinity, maxBodyLength: Infinity });

  const videoId = res.data.id;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[youtube] uploaded: ${url}`);

  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try {
      await yt.thumbnails.set({
        videoId,
        media: { body: fs.createReadStream(thumbnailPath) },
      });
      console.log('[youtube] thumbnail set');
    } catch (e) {
      console.warn('[youtube] thumbnail failed:', e.message);
    }
  }

  if (srtPath && fs.existsSync(srtPath) && !isShort) {
    try {
      await yt.captions.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            videoId,
            language: 'en',
            name: 'English',
            isDraft: false,
          },
        },
        media: { body: fs.createReadStream(srtPath) },
      });
      console.log('[youtube] captions uploaded');
    } catch (e) {
      console.warn('[youtube] captions upload failed:', e.message);
    }
  }

  return { videoId, url };
}

async function postPinnedComment(videoId, commentText) {
  if (!commentText) return null;
  const auth = getAuthClient();
  const yt = google.youtube({ version: 'v3', auth });
  try {
    const res = await yt.commentThreads.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          videoId,
          topLevelComment: {
            snippet: { textOriginal: commentText },
          },
        },
      },
    });
    return res.data.id;
  } catch (e) {
    console.warn('[youtube] pinned comment failed:', e.message);
    return null;
  }
}

module.exports = { uploadVideo, postPinnedComment, getAuthClient };
