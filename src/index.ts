import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRouter from './routes/auth';
import songsRouter from './routes/songs';
import playlistsRouter from './routes/playlists';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
}));
app.use(express.json());

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/songs', songsRouter);
app.use('/playlists', playlistsRouter);

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ── Start server (local dev) ──────────────────────────────────────────────────
// Vercel handles its own server lifecycle, so we only listen in non-Vercel env
if (process.env.VERCEL !== '1') {
    app.listen(PORT, () => {
        console.log(`🎵 Spotify Clone API running on http://localhost:${PORT}`);
    });
}

// Export for Vercel serverless
export default app;
