import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireAuth, requireAdmin } from '../middleware/auth';
import yts from 'yt-search';

const router = Router();
const prisma = new PrismaClient();

// ── Cloudflare R2 Client (via AWS SDK v3) ─────────────────────────────────────
// R2 memakai S3-compatible API. Endpoint format berbeda dari AWS S3.
const r2Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT, // https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    },
});

// Helper: format durasi  243 → "4:03"
function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * GET /songs
 * Query params: ?genre=Pop&artist=<id>&q=<search>&limit=20&offset=0
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
    const { genre, artist, q, sort, mood, limit = '20', offset = '0', verifyStorage } = req.query as Record<string, string>;

    try {
        let orderBy: any = { createdAt: 'desc' };
        if (sort === 'plays') orderBy = { playCount: 'desc' };
        if (sort === 'latest') orderBy = { createdAt: 'desc' };

        const songs = await prisma.song.findMany({
            where: {
                ...(genre ? { genre } : {}),
                ...(mood ? { moods: { has: mood } } : {}),
                ...(artist ? { artists: { some: { id: artist } } } : {}),
                ...(q
                    ? {
                        OR: [
                            { title: { contains: q, mode: 'insensitive' } },
                            { artists: { some: { name: { contains: q, mode: 'insensitive' } } } },
                        ],
                    }
                    : {}),
            },
            include: {
                artists: { select: { id: true, name: true, avatarUrl: true } },
                album: { select: { id: true, title: true, coverUrl: true } },
            },
            orderBy,
            take: sort === 'random' ? undefined : parseInt(limit, 10),
            skip: sort === 'random' ? undefined : parseInt(offset, 10),
        });

        let finalSongs = songs;
        // Client-side shuffle for "random" since Prisma doesn't have a native stable random sort
        if (sort === 'random') {
            finalSongs = songs.sort(() => Math.random() - 0.5).slice(0, parseInt(limit, 10));
        }

        const songResults = await Promise.all(finalSongs.map(async (s: any) => {
            let existsInStorage = null;
            if (verifyStorage === 'true' && s.audioKey) {
                try {
                    await r2Client.send(new HeadObjectCommand({
                        Bucket: process.env.R2_BUCKET_NAME,
                        Key: s.audioKey
                    }));
                    existsInStorage = true;
                } catch (err: any) {
                    if (err.name === 'NotFound') {
                        existsInStorage = false;
                    } else {
                        console.error(`[GET /songs] Error checking storage for ${s.id}:`, err.message);
                        existsInStorage = null; // Unknown error
                    }
                }
            }

            return {
                id: s.id,
                title: s.title,
                durationSec: s.durationSec,
                duration: formatDuration(s.durationSec),
                coverUrl: s.coverUrl || s.album?.coverUrl || null,
                genre: s.genre,
                artists: s.artists,
                album: s.album,
                existsInStorage,
            };
        }));

        return res.json({
            songs: songResults
        });
    } catch (err) {
        console.error('[GET /songs]', err);
        return res.status(500).json({ error: 'Gagal mengambil daftar lagu.' });
    }
});

/**
 * GET /songs/yt-search
 * Search YouTube videos without downloading
 */
router.get('/yt-search', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { q } = req.query as { q: string };
    if (!q) return res.status(400).json({ error: 'Query q wajib diisi.' });

    try {
        const results = await yts(q);
        const videos = results.videos.slice(0, 10).map(v => ({
            videoId: v.videoId,
            url: v.url,
            title: v.title,
            thumbnail: v.thumbnail,
            duration: v.timestamp,
            author: v.author.name
        }));

        return res.json({ videos });
    } catch (err: any) {
        console.error('[GET /songs/yt-search]', err);
        return res.status(500).json({ error: 'Gagal mencari di YouTube.', details: err.message });
    }
});

/**
 * GET /songs/spotify-search
 * Search Spotify tracks via Ferdev API
 */
router.get('/spotify-search', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { q } = req.query as { q: string };
    if (!q) return res.status(400).json({ error: 'Query q wajib diisi.' });

    try {
        const apiKey = "fdv_pd0smcIACrw7J1-nDPKBoA";
        const apiUrl = `https://api.ferdev.my.id/search/spotify?query=${encodeURIComponent(q)}&apikey=${apiKey}`;
        console.log('[Spotify Search] Calling API:', apiUrl);
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) {
            const errText = await apiRes.text();
            console.error('[Spotify Search] API Error:', apiRes.status, errText);
            return res.status(apiRes.status).json({ error: 'Gagal menghubungi API Spotify Search.', details: errText });
        }

        const apiData = await apiRes.json() as any;
        console.log('[Spotify Search] API Response:', JSON.stringify(apiData).substring(0, 500));

        const hasData = Array.isArray(apiData.data) || Array.isArray(apiData.result);
        if (!hasData) {
            return res.status(400).json({ error: 'Gagal mendapatkan data dari Spotify.', details: apiData });
        }

        const rawTracks = apiData.result || apiData.data;

        // Normalize format for frontend SearchResults
        const tracks = Array.isArray(rawTracks) ? rawTracks.map((track: any) => {
            const trackId = track.id || (track.url ? track.url.split('/').pop() : Math.random().toString());
            return {
                videoId: trackId, // Used as key in frontend
                id: trackId,
                url: track.url,
                title: track.title || track.name || 'Unknown Title',
                thumbnail: track.thumbnail || 'https://placehold.co/100x100/png?text=Spotify',
                duration: track.duration_at || '0:00',
                author: track.artists || (track.artist?.name) || 'Unknown Artist'
            };
        }) : [];

        return res.json({ videos: tracks });
    } catch (err: any) {
        console.error('[GET /songs/spotify-search] CRASH:', err);
        return res.status(500).json({ error: 'Gagal mencari di Spotify.', details: err.message });
    }
});

/**
 * GET /songs/:id
 * Detail satu lagu (tanpa streaming URL — harus request terpisah)
 */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
        const song = await prisma.song.findUnique({
            where: { id },
            include: {
                artists: true,
                album: true,
            },
        });

        if (!song) return res.status(404).json({ error: 'Lagu tidak ditemukan.' });

        return res.json({
            id: song.id,
            title: song.title,
            durationSec: song.durationSec,
            duration: formatDuration(song.durationSec),
            coverUrl: song.coverUrl || song.album?.coverUrl || null,
            genre: song.genre,
            lyrics: song.lyrics,
            lyricsLrc: song.lyricsLrc,
            moods: song.moods,
            playCount: song.playCount,
            trackNumber: song.trackNumber,
            artists: song.artists,
            album: song.album,
        });
    } catch (err) {
        console.error('[GET /songs/:id]', err);
        return res.status(500).json({ error: 'Gagal mengambil detail lagu.' });
    }
});

/**
 * POST /songs/:id/play
 * Track spin count
 */
router.post('/:id/play', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        await prisma.song.update({
            where: { id },
            data: { playCount: { increment: 1 } }
        });

        // Record history for stats
        if (req.user) {
            await prisma.playHistory.create({
                data: { userId: req.user.userId, songId: id }
            }).catch(e => console.error('[PlayHistory] Create error (non-blocking):', e));
        }

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Gagal update play count.' });
    }
});


/**
 * POST /songs/:id/generate-lyrics
 * AI-powered lyric search
 */
router.post('/:id/generate-lyrics', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const song = await prisma.song.findUnique({
        where: { id },
        include: { artists: true }
    });

    if (!song) return res.status(404).json({ error: 'Lagu tidak ditemukan.' });

    try {
        // Simple AI prompt for lyrics - you'd likely want a search tool here, 
        // but since I'm an LLM assistant, I will simulate the OpenRouter call
        const artistName = song.artists.map(a => a.name).join(', ');
        const prompt = `Cari dan berikan lirik lengkap untuk lagu "${song.title}" oleh ${artistName}. 
Jika memungkinkan, sertakan format LRC (timestamp) di bawah teks lirik biasa. 
Analisis juga suasana lagu ini dan hasilkan 3-5 mood tags (seperti "Relax", "Energetic", "Sad").
Format output JSON: { "lyrics": "teks...", "lrc": "[00:10.00]teks...", "moods": ["Mood1", "Mood2"] }`;

        // Real OpenRouter Implementation
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "arcee-ai/trinity-large-preview:free",
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[OpenRouter Error]', response.status, errorText);
            throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
        }

        const aiData = await response.json() as any;

        if (!aiData.choices?.[0]?.message?.content) {
            console.error('[AI Response Invalid]', aiData);
            throw new Error('AI tidak memberikan respon yang valid.');
        }

        const content = aiData.choices[0].message.content;
        console.log('[AI Response Content]', content);

        const result = JSON.parse(content);

        const updated = await prisma.song.update({
            where: { id },
            data: {
                lyrics: result.lyrics,
                lyricsLrc: result.lrc,
                moods: result.moods || []
            }
        });

        return res.json(updated);
    } catch (err: any) {
        console.error('[AI Lyrics Error]', err);
        return res.status(500).json({ error: 'Gagal generate lirik via AI.', details: err.message });
    }
});

/**
 * POST /songs/:id/stream-url
 * Generate pre-signed URL Cloudflare R2 untuk streaming audio.
 *
 * ⚠️  Backend TIDAK menjadi proxy streaming.
 *     Client langsung streaming dari R2 menggunakan URL ini.
 *     URL valid selama 300 detik (5 menit).
 *
 * Flow:
 * 1. Client (dengan JWT) → POST /songs/:id/stream-url
 * 2. Backend verifikasi JWT
 * 3. Backend mengambil audioKey dari DB
 * 4. Backend generate signed URL via AWS SDK GetObjectCommand
 * 5. Return { url, expiresIn: 300 }
 * 6. Client set <audio src={url}> → stream langsung dari R2
 */
router.post('/:id/stream-url', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
        // ── Ambil audioKey dari DB ────────────────────────────────────────────
        const song = await prisma.song.findUnique({
            where: { id },
            select: { id: true, audioKey: true, title: true },
        });

        if (!song) return res.status(404).json({ error: 'Lagu tidak ditemukan.' });

        // ── Generate Signed URL ───────────────────────────────────────────────
        const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: song.audioKey, // e.g. "audio/song-01.mp3"
        });

        const EXPIRES_IN_SECONDS = 300; // 5 menit

        const signedUrl = await getSignedUrl(r2Client, command, {
            expiresIn: EXPIRES_IN_SECONDS,
        });

        // ── Catat riwayat putar (opsional, fire-and-forget) ──────────────────
        if (req.user) {
            prisma.playHistory
                .create({
                    data: { userId: req.user.userId, songId: song.id },
                })
                .catch(() => { }); // jangan block response
        }

        return res.json({
            url: signedUrl,
            expiresIn: EXPIRES_IN_SECONDS,
            songId: song.id,
            title: song.title,
        });
    } catch (err) {
        console.error('[POST /songs/:id/stream-url]', err);
        return res.status(500).json({ error: 'Gagal membuat streaming URL.' });
    }
});

/**
 * POST /songs/upload-url
 * (ADMIN ONLY) Generate pre-signed URL untuk upload file ke R2 via PUT.
 * Body: { fileName: string, fileType: string }
 */
router.post('/upload-url', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { fileName, fileType, folder = 'audio' } = req.body as { fileName?: string; fileType?: string; folder?: 'audio' | 'covers' };

    if (!fileName || !fileType) {
        return res.status(400).json({ error: 'fileName dan fileType wajib diisi.' });
    }

    try {
        const uniqueId = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);
        const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const objectKey = `${folder}/${uniqueId}-${safeName}`;

        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey,
            ContentType: fileType,
        });

        // URL berlaku selama 10 menit untuk proses upload
        const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 600 });

        const publicUrl = folder === 'covers' ? `${process.env.R2_ENDPOINT?.replace('https://', 'https://pub-')}/${objectKey}` : null;

        return res.json({
            uploadUrl,
            objectKey,
            publicUrl, // hanya berguna kalau setting domain public di CF, tapi untuk cover mending stream atau bikin endpoint public
            expiresIn: 600
        });
    } catch (err) {
        console.error('[POST /songs/upload-url]', err);
        return res.status(500).json({ error: 'Gagal membuat upload URL.' });
    }
});

/**
 * POST /songs
 * (ADMIN ONLY) Simpan metadata lagu baru ke database setelah file selesai diupload ke R2.
 */
router.post('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { title, durationSec, audioKey, coverUrl, trackNumber, artistId, albumId, genre } = req.body;

    if (!title || !durationSec || !audioKey || !artistId) {
        return res.status(400).json({ error: 'title, durationSec, audioKey, dan artistId wajib diisi.' });
    }

    try {
        const song = await prisma.song.create({
            data: {
                title,
                durationSec: Number(durationSec),
                audioKey,
                coverUrl: coverUrl || null,
                trackNumber: trackNumber ? Number(trackNumber) : null,
                albumId: albumId || null,
                genre: genre || null,
                artists: {
                    connect: Array.isArray(artistId) ? artistId.map(id => ({ id })) : [{ id: artistId }]
                }
            },
            include: {
                artists: true,
                album: true,
            }
        });

        return res.status(201).json({ song });
    } catch (err) {
        console.error('[POST /songs]', err);
        return res.status(500).json({ error: 'Gagal menyimpan metadata lagu.' });
    }
});

/**
 * PATCH /songs/:id
 * (ADMIN ONLY) Update metadata lagu.
 */
router.patch('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { title, durationSec, coverUrl, genre, artistIds, artistNames, albumId, lyrics, lyricsLrc, moods } = req.body;

    try {
        const updateData: any = {};
        if (title !== undefined) updateData.title = title;
        if (durationSec !== undefined) updateData.durationSec = Number(durationSec);
        if (coverUrl !== undefined) updateData.coverUrl = coverUrl;
        if (genre !== undefined) updateData.genre = genre;
        if (albumId !== undefined) updateData.albumId = albumId || null;
        if (lyrics !== undefined) updateData.lyrics = lyrics;
        if (lyricsLrc !== undefined) updateData.lyricsLrc = lyricsLrc;
        if (moods !== undefined) updateData.moods = moods;

        if (artistIds && Array.isArray(artistIds)) {
            updateData.artists = {
                set: artistIds.map(id => ({ id }))
            };
        } else if (artistNames && Array.isArray(artistNames)) {
            // Support updating artists via names (from a string input in UI)
            updateData.artists = {
                set: [], // Clear previous connections
                connectOrCreate: artistNames.map(name => ({
                    where: { name },
                    create: { name }
                }))
            };
        }

        const song = await prisma.song.update({
            where: { id },
            data: updateData,
            include: {
                artists: true,
                album: true,
            }
        });

        return res.json({ song });
    } catch (err: any) {
        console.error(`[PATCH /songs/${id}]`, err);
        return res.status(500).json({ error: 'Gagal memperbarui lagu.', details: err.message });
    }
});

/**
 * DELETE /songs/:id
 * (ADMIN ONLY) Hapus lagu dari database.
 */
router.delete('/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
        // Cek apakah ada recordnya
        const song = await prisma.song.findUnique({ where: { id } });
        if (!song) return res.status(404).json({ error: 'Lagu tidak ditemukan.' });

        // Hapus dari DB
        await prisma.song.delete({ where: { id } });

        // Hapus file dari Cloudflare R2 secara asynchronous (fire & forget)
        // Kita gunakan audioKey yang sudah kita ambil tadi
        if (song.audioKey) {
            const deleteCommand = new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: song.audioKey
            });

            r2Client.send(deleteCommand)
                .then(() => console.log(`[DELETE /songs/${id}] File R2 dihapus: ${song.audioKey}`))
                .catch(err => console.error(`[DELETE /songs/${id}] Gagal hapus file R2:`, err));
        }

        return res.json({ message: 'Lagu dan file berhasil dihapus.' });
    } catch (err: any) {
        console.error(`[DELETE /songs/${id}]`, err);
        return res.status(500).json({ error: 'Gagal menghapus lagu.', details: err.message });
    }
});

export default router;

/**
 * Menggunakan AI (OpenRouter) untuk membersihkan judul YouTube menjadi Judul & Artis yang rapi.
 */
async function cleanMetadataWithAI(rawTitle: string): Promise<{ title: string; artists: string[] }> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.warn('[AI] OPENROUTER_API_KEY tidak ditemukan, menggunakan parser standar.');
        const artists = parseArtists(rawTitle);
        return {
            title: rawTitle.split('-').pop()?.trim() || rawTitle,
            artists: artists.length > 0 ? artists : [rawTitle.split('-')[0].trim()]
        };
    }

    try {
        console.log('[AI] Step 1: Initial cleanup for:', rawTitle);
        const step1Response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "Spotify-Clone Metadata Cleaner"
            },
            body: JSON.stringify({
                model: "z-ai/glm-4.5-air:free",
                messages: [
                    {
                        role: "system",
                        content: "You are a professional music librarian. Task: Extract clean song title and list all artist names from a YouTube title. Rules: 1. REMOVE all noise like 'Official Video', 'Music Video', 'LYRICS', 'Lirik', '4K', 'HD', '(...)', '[...]'. 2. DO NOT include the artist name in the 'title' field. 3. Response MUST be ONLY JSON: { \"title\": \"Clean Title\", \"artists\": [\"Artist 1\", \"Artist 2\"] }"
                    },
                    { role: "user", content: `YouTube Title: "${rawTitle}"` }
                ]
            })
        });

        if (!step1Response.ok) {
            const errBody = await step1Response.text();
            throw new Error(`Step 1 Error: ${step1Response.status} - ${errBody}`);
        }

        const step1Data = await step1Response.json() as any;
        const step1Content = step1Data.choices?.[0]?.message?.content;
        console.log('[AI] Step 1 Output:', step1Content);

        const jsonMatch1 = step1Content?.match(/\{[\s\S]*\}/);
        if (!jsonMatch1) throw new Error('Gagal memproses JSON Step 1.');
        const initialResult = JSON.parse(jsonMatch1[0]);

        // Step 2: Refinement / Double Check
        console.log('[AI] Step 2: Refinement for:', initialResult.title);
        const step2Response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "Spotify-Clone Metadata Cleaner"
            },
            body: JSON.stringify({
                model: "z-ai/glm-4.5-air:free",
                messages: [
                    {
                        role: "system",
                        content: "You are a verification AI. Review this metadata. Is the 'title' still containing artist names, redundant words, or brackets? If yes, clean it further. Response MUST be ONLY JSON: { \"title\": \"Final Clean Title\", \"artists\": [\"Final Artists\"] }"
                    },
                    {
                        role: "user",
                        content: `Input: ${JSON.stringify(initialResult)}\nOriginal YouTube Title: "${rawTitle}"`
                    }
                ]
            })
        });

        const step2Data = await step2Response.json() as any;
        const step2Content = step2Data.choices?.[0]?.message?.content;
        console.log('[AI] Step 2 Output:', step2Content);

        const jsonMatch2 = step2Content?.match(/\{[\s\S]*\}/);
        if (jsonMatch2) {
            const finalResult = JSON.parse(jsonMatch2[0]);
            return {
                title: finalResult.title || initialResult.title,
                artists: Array.isArray(finalResult.artists) ? finalResult.artists : (Array.isArray(initialResult.artists) ? initialResult.artists : [rawTitle.split('-')[0].trim()])
            };
        }

        return {
            title: initialResult.title || rawTitle.split('-').pop()?.trim() || rawTitle,
            artists: Array.isArray(initialResult.artists) ? initialResult.artists : [rawTitle.split('-')[0].trim()]
        };
    } catch (err: any) {
        console.error('[AI Cleanup Error]', err.message);
        const artists = parseArtists(rawTitle);
        const fallbackTitle = rawTitle.split('-').pop()?.trim() || rawTitle;
        // Basic local cleanup for fallback
        const cleanTitle = fallbackTitle.replace(/\(Official.*?\)|\[Official.*?\]|\(Lyrics.*?\)|\[Lyrics.*?\]|Official Music Video|Official Video|Music Video|LYRICS/gi, '').trim();
        return {
            title: cleanTitle,
            artists: artists.length > 0 ? artists : [rawTitle.split('-')[0].trim()]
        };
    }
}

function parseArtists(title: string): string[] {
    // Basic parser for "Artist - Title" or "Artist1 & Artist2 - Title"
    // Also handles "Artist1, Artist2 - Title"
    const dashIndex = title.indexOf('-');
    if (dashIndex === -1) return [];

    let artistPart = title.substring(0, dashIndex).trim();

    // Remove common prefixes like "Official Video", "(Official Music Video)", etc if they are somehow at start?
    // Unlikely for artist part, but let's just split by separators
    const separators = [/ & /g, / , /g, /,/g, / and /g, / x /g, / X /g, / FEAT /gi, / FT /gi];
    let artists = [artistPart];

    for (const sep of separators) {
        artists = artists.flatMap(a => a.split(sep));
    }

    return artists.map(a => a.trim()).filter(a => a.length > 0);
}

/**
 * Menggunakan Spotify API untuk memperkaya data artis (foto & genre).
 */
let spotifyAccessToken: string | null = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken(): Promise<string | null> {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.warn('[Spotify] SPOTIFY_CLIENT_ID/SECRET tidak ditemukan.');
        return null;
    }

    if (spotifyAccessToken && Date.now() < spotifyTokenExpiry) {
        return spotifyAccessToken;
    }

    try {
        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': `Base ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials'
        });

        const data = await res.json() as any;
        if (data.access_token) {
            spotifyAccessToken = data.access_token;
            spotifyTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
            return spotifyAccessToken;
        }
    } catch (err: any) {
        console.error('[Spotify Auth Error]', err.message);
    }
    return null;
}

async function enrichArtistMetadata(name: string): Promise<{ avatarUrl: string | null; genres: string[] }> {
    const token = await getSpotifyToken();
    if (!token) return { avatarUrl: null, genres: [] };

    try {
        const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=artist&limit=1`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await res.json() as any;
        const artist = data.artists?.items?.[0];

        if (artist) {
            return {
                avatarUrl: artist.images?.[0]?.url || null,
                genres: artist.genres || []
            };
        }
    } catch (err: any) {
        console.error(`[Spotify Enrich Error] ${name}:`, err.message);
    }
    return { avatarUrl: null, genres: [] };
}

/**
 * POST /songs/yt-preview
 * (ADMIN ONLY) Ambil info youtube dan bersihkan metadata via AI sebelum download.
 */
router.post('/yt-preview', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) return res.status(400).json({ error: 'youtubeUrl wajib diisi.' });

    try {
        const apiKeyDownloader = "fdv_pd0smcIACrw7J1-nDPKBoA"; // Hardcoded
        const apiUrl = `https://api.ferdev.my.id/downloader/ytmp3?link=${encodeURIComponent(youtubeUrl)}&apikey=${apiKeyDownloader}`;
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) return res.status(apiRes.status).json({ error: 'Gagal menghubungi API downloader.' });

        const apiData = await apiRes.json() as any;
        if (!apiData.success || !apiData.data) return res.status(400).json({ error: 'Gagal mendapatkan data dari YouTube.' });

        const { title: rawTitle, thumbnail, duration } = apiData.data;
        const cleanMetadata = await cleanMetadataWithAI(rawTitle);

        // Enrich with Spotify
        const enrichedArtists = await Promise.all(
            cleanMetadata.artists.map(async (name) => {
                const spotifyData = await enrichArtistMetadata(name);
                return { name, ...spotifyData };
            })
        );

        return res.json({
            rawTitle,
            title: cleanMetadata.title,
            artists: enrichedArtists,
            thumbnail,
            duration,
        });
    } catch (err: any) {
        return res.status(500).json({ error: 'Gagal preview metadata.', details: err.message });
    }
});

/**
 * POST /songs/spotify-preview
 * (ADMIN ONLY) Ambil info lagu dari link Spotify via Ferdev API.
 */
router.post('/spotify-preview', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { spotifyUrl } = req.body;
    if (!spotifyUrl) return res.status(400).json({ error: 'spotifyUrl wajib diisi.' });

    try {
        const apiKey = "fdv_pd0smcIACrw7J1-nDPKBoA";
        const apiUrl = `https://api.ferdev.my.id/downloader/spotify?link=${encodeURIComponent(spotifyUrl)}&apikey=${apiKey}`;
        console.log('[Spotify Preview] Calling API:', apiUrl);
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) return res.status(apiRes.status).json({ error: 'Gagal menghubungi API Spotify Downloader.' });

        const apiData = await apiRes.json() as any;
        if (!apiData.success || !apiData.data) return res.status(400).json({ error: 'Gagal mendapatkan data dari Spotify.' });

        const { title, artist, thumbnail } = apiData.data;
        const artistNames = artist.split(',').map((a: string) => a.trim());

        // Enrich with Spotify (for high res images/genres)
        const enrichedArtists = await Promise.all(
            artistNames.map(async (name: string) => {
                const spotifyData = await enrichArtistMetadata(name);
                return { name, ...spotifyData };
            })
        );

        return res.json({
            rawTitle: `${artist} - ${title}`,
            title,
            artists: enrichedArtists,
            thumbnail: apiData.data.album?.images?.[0]?.url || thumbnail,
            duration: '0:00', // Spotify downloader API might not return duration directly here
        });
    } catch (err: any) {
        return res.status(500).json({ error: 'Gagal preview metadata Spotify.', details: err.message });
    }
});

/**
 * POST /songs/yt-download
 * (ADMIN ONLY) Otomatis download dari youtube lalu upload ke R2 dan simpan ke DB.
 */
router.post('/yt-download', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { youtubeUrl, artistId, albumId, genre, title: customTitle, artistNames: customArtistNames } = req.body;

    if (!youtubeUrl) {
        return res.status(400).json({ error: 'youtubeUrl wajib diisi.' });
    }

    try {
        // 1. Fetch from api.ferdev.my.id
        const apiKeyDownloader = "fdv_pd0smcIACrw7J1-nDPKBoA"; // Hardcoded
        const apiUrl = `https://api.ferdev.my.id/downloader/ytmp3?link=${encodeURIComponent(youtubeUrl)}&apikey=${apiKeyDownloader}`;
        console.log('[yt-download] Calling Ferdev API:', apiUrl);
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) {
            const errText = await apiRes.text();
            console.error('[yt-download] Ferdev API Error:', apiRes.status, errText);
            return res.status(apiRes.status).json({ error: 'Gagal menghubungi API downloader.', details: errText });
        }

        const apiData = await apiRes.json() as any;
        if (!apiData.success || !apiData.data) {
            return res.status(400).json({ error: 'Gagal mendapatkan data dari YouTube.' });
        }

        const { title: rawTitle, thumbnail, duration, dlink } = apiData.data;

        // NEW: metadata logic
        let finalTitle = customTitle;
        let finalArtistNames: string[] = Array.isArray(customArtistNames) ? customArtistNames : [];

        if (!finalTitle || finalArtistNames.length === 0) {
            console.log('[yt-download] Using AI Cleanup (no custom metadata provided)');
            const cleanMetadata = await cleanMetadataWithAI(rawTitle);
            if (!finalTitle) finalTitle = cleanMetadata.title;
            if (finalArtistNames.length === 0) finalArtistNames = cleanMetadata.artists;
        }

        const artistNames = artistId ? [] : finalArtistNames;

        // 2. Download MP3 file
        const mp3Res = await fetch(dlink);
        if (!mp3Res.ok) {
            return res.status(mp3Res.status).json({ error: 'Gagal mengunduh file MP3.' });
        }

        const arrayBuffer = await mp3Res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 3. Upload to R2
        const uniqueId = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);
        const safeTitle = finalTitle.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50);
        const objectKey = `audio/${uniqueId}-${safeTitle}.mp3`;

        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey,
            Body: buffer,
            ContentType: 'audio/mpeg'
        });

        await r2Client.send(command);
        console.log('[yt-download] Success upload to R2:', objectKey);

        // 4. Save to DB
        console.log('[yt-download] Saving to DB...');

        const song = await prisma.song.create({
            data: {
                title: finalTitle,
                durationSec: Math.floor(Number(duration) || 0),
                audioKey: objectKey,
                coverUrl: thumbnail || null,
                albumId: albumId || null,
                genre: genre || null,
                artists: {
                    connectOrCreate: artistId
                        ? (Array.isArray(artistId) ? artistId : [artistId]).map(id => ({
                            where: { id },
                            create: { id, name: 'Unknown Artist' }
                        }))
                        : await Promise.all(artistNames.map(async (name) => {
                            const spotify = await enrichArtistMetadata(name);
                            return {
                                where: { name },
                                create: {
                                    name,
                                    avatarUrl: spotify.avatarUrl,
                                    bio: spotify.genres.length > 0 ? `Genres: ${spotify.genres.join(', ')}` : null
                                }
                            };
                        }))
                }
            },
            include: {
                artists: true,
                album: true,
            }
        });

        console.log('[yt-download] Success save to DB:', song.id);
        return res.status(201).json({ song });
    } catch (err: any) {
        console.error('[POST /songs/yt-download]', err?.message, err?.stack || err);
        return res.status(500).json({ error: 'Terjadi kesalahan sistem saat proses download YouTube.', details: err?.message });
    }
});

/**
 * POST /songs/spotify-download
 * (ADMIN ONLY) Download dari Spotify via Ferdev API lalu upload ke R2 dan simpan ke DB.
 */
router.post('/spotify-download', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const { spotifyUrl, artistId, albumId, genre, title: customTitle, artistNames: customArtistNames } = req.body;

    if (!spotifyUrl) return res.status(400).json({ error: 'spotifyUrl wajib diisi.' });

    try {
        const apiKey = "fdv_pd0smcIACrw7J1-nDPKBoA";
        const apiUrl = `https://api.ferdev.my.id/downloader/spotify?link=${encodeURIComponent(spotifyUrl)}&apikey=${apiKey}`;
        console.log('[Spotify Download] Prepared to fetch API:', apiUrl);
        let apiRes;
        for (let i = 0; i < 3; i++) {
            try {
                apiRes = await fetch(apiUrl);
                if (apiRes.ok) break; // Keluar loop jika berhasil
            } catch (e: any) {
                console.error(`[Spotify Download] Ferdev API Fetch Error (Attempt ${i + 1}):`, e.message);
                if (i === 2) throw new Error(`Ferdev API fetch failed: ${e.message}`);
                await new Promise(res => setTimeout(res, 2000)); // Tunggu 2 detik
            }
        }

        if (!apiRes || !apiRes.ok) return res.status(apiRes?.status || 500).json({ error: 'Gagal menghubungi API Spotify Downloader.' });

        const apiData = await apiRes.json() as any;
        if (!apiData.success || !apiData.data) return res.status(400).json({ error: 'Gagal mendapatkan data dari Spotify.' });

        const { title: spotifyTitle, artist: spotifyArtist } = apiData.data;
        const dlink = apiData.download || apiData.data.download || apiData.data.url;
        const thumbnail = apiData.data.album?.images?.[0]?.url || apiData.data.thumbnail;

        if (!dlink) {
            return res.status(400).json({ error: 'Link download tidak ditemukan pada response Spotify API.' });
        }

        console.log('[Spotify Download] Extracted dlink:', dlink);

        const finalTitle = customTitle || spotifyTitle;
        const finalArtistNames = Array.isArray(customArtistNames) ? customArtistNames : spotifyArtist.split(',').map((a: string) => a.trim());

        // 2. Download MP3 file
        console.log('[Spotify Download] Fetching MP3...');
        let mp3Res;
        for (let i = 0; i < 3; i++) {
            try {
                mp3Res = await fetch(dlink, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'audio/mpeg, audio/*;q=0.9, */*;q=0.8',
                    }
                });
                if (mp3Res.ok) break;
            } catch (e: any) {
                console.error(`[Spotify Download] MP3 Fetch Error (Attempt ${i + 1}):`, e.message);
                if (i === 2) throw new Error(`MP3 fetch failed: ${e.message}`);
                await new Promise(res => setTimeout(res, 2000));
            }
        }

        console.log('[Spotify Download] MP3 HTTP Status:', mp3Res?.status);
        if (!mp3Res || !mp3Res.ok) return res.status(mp3Res?.status || 500).json({ error: `Gagal mengunduh file MP3 dari Spotify source.` });

        const buffer = Buffer.from(await mp3Res.arrayBuffer());

        // 3. Upload to R2
        const uniqueId = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);
        const safeTitle = finalTitle.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50);
        const objectKey = `audio/${uniqueId}-${safeTitle}.mp3`;

        await r2Client.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: objectKey,
            Body: buffer,
            ContentType: 'audio/mpeg'
        }));

        // 4. Save to DB
        const song = await prisma.song.create({
            data: {
                title: finalTitle,
                durationSec: 0, // Duration will be updated correctly on playback or from metadata if available
                audioKey: objectKey,
                coverUrl: thumbnail || null,
                albumId: albumId || null,
                genre: genre || null,
                artists: {
                    connectOrCreate: artistId
                        ? (Array.isArray(artistId) ? artistId : [artistId]).map(id => ({
                            where: { id },
                            create: { id, name: 'Unknown Artist' }
                        }))
                        : await Promise.all(finalArtistNames.map(async (name: string) => {
                            const spotify = await enrichArtistMetadata(name);
                            return {
                                where: { name },
                                create: {
                                    name,
                                    avatarUrl: spotify.avatarUrl,
                                    bio: spotify.genres.length > 0 ? `Genres: ${spotify.genres.join(', ')}` : null
                                }
                            };
                        }))
                }
            },
            include: { artists: true, album: true }
        });

        return res.status(201).json({ song });
    } catch (err: any) {
        console.error('[POST /songs/spotify-download]', err?.message);
        return res.status(500).json({ error: 'Gagal download Spotify.', details: err.message });
    }
});
