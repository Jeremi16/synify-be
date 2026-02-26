import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { PrismaClient } from '@prisma/client';
import { signToken } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * POST /auth/login
 * Body: { idToken: string }  ← ID token dari Google Sign-In di frontend
 *
 * Flow:
 * 1. Frontend: google.accounts.id.initialize → user klik → dapat id_token
 * 2. Frontend kirim id_token ke endpoint ini
 * 3. Backend verifikasi ke Google
 * 4. Buat/update user di DB
 * 5. Return JWT
 */
router.post('/login', async (req: Request, res: Response) => {
    const { idToken } = req.body as { idToken?: string };

    if (!idToken) {
        return res.status(400).json({ error: 'idToken wajib diisi.' });
    }

    try {
        // ── 1. Verifikasi ID token ke Google ──────────────────────────────────
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        if (!payload || !payload.email) {
            return res.status(400).json({ error: 'Token Google tidak valid.' });
        }

        const { sub: googleId, email, name, picture } = payload;

        // ── 2. Upsert user di database ────────────────────────────────────────
        const user = await prisma.user.upsert({
            where: { email },
            update: {
                googleId,
                name: name || email,
                avatarUrl: picture || null,
            },
            create: {
                googleId,
                email,
                name: name || email,
                avatarUrl: picture || null,
            },
        });

        // ── 3. Sign JWT ───────────────────────────────────────────────────────
        const token = signToken({ userId: user.id, email: user.email, role: user.role });

        return res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                avatarUrl: user.avatarUrl,
                role: user.role,
                createdAt: user.createdAt,
            },
        });
    } catch (err) {
        console.error('[/auth/login]', err);
        return res.status(500).json({ error: 'Gagal melakukan autentikasi.' });
    }
});

/**
 * GET /auth/me
 * Mendapatkan profil user yang sedang login (dari JWT)
 */
router.get('/me', async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const jwt = await import('jsonwebtoken');
        const decoded = jwt.default.verify(
            authHeader.split(' ')[1],
            process.env.JWT_SECRET as string
        ) as { userId: string };

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                email: true,
                name: true,
                avatarUrl: true,
                role: true,
                createdAt: true,
                _count: {
                    select: {
                        playlists: true,
                        playHistory: true
                    }
                }
            },
        });

        if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
        return res.json({ user });
    } catch {
        return res.status(401).json({ error: 'Token tidak valid.' });
    }
});

export default router;
