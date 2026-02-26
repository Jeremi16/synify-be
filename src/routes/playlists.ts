import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

/**
 * POST /playlists
 * Buat playlist baru untuk user yang sedang login
 * Body: { name: string, description?: string }
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
    const { name, description } = req.body as { name?: string; description?: string };

    if (!name) return res.status(400).json({ error: 'Nama playlist wajib diisi.' });

    try {
        const playlist = await prisma.playlist.create({
            data: {
                name,
                description,
                userId: req.user!.userId,
            },
        });

        return res.status(201).json({ playlist });
    } catch (err) {
        console.error('[POST /playlists]', err);
        return res.status(500).json({ error: 'Gagal membuat playlist.' });
    }
});


/**
 * GET /playlists/my
 * Mendapatkan daftar playlist milik user yang sedang login
 */
router.get('/my', requireAuth, async (req: Request, res: Response) => {
    const { songId } = req.query as { songId?: string };
    try {
        const playlists = await prisma.playlist.findMany({
            where: { userId: req.user!.userId },
            orderBy: { createdAt: 'desc' },
            include: {
                _count: {
                    select: { items: true }
                },
                items: songId ? {
                    where: { songId },
                    select: { songId: true }
                } : false
            }
        });

        return res.json({
            playlists: playlists.map((p: any) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                coverUrl: p.coverUrl,
                totalSongs: p._count.items,
                hasSong: songId ? p.items.length > 0 : undefined
            }))
        });
    } catch (err) {
        console.error('[GET /playlists/my]', err);
        return res.status(500).json({ error: 'Gagal mengambil playlist Anda.' });
    }
});

/**
 * GET /playlists/:id
 * Detail playlist beserta semua lagu di dalamnya
 */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
        const playlist = await prisma.playlist.findUnique({
            where: { id },
            include: {
                user: { select: { id: true, name: true } },
                items: {
                    orderBy: { position: 'asc' },
                    include: {
                        song: {
                            include: {
                                artists: { select: { id: true, name: true } },
                                album: { select: { id: true, title: true, coverUrl: true } },
                            },
                        },
                    },
                },
            },
        });

        if (!playlist) return res.status(404).json({ error: 'Playlist tidak ditemukan.' });

        // Flatten structure untuk kemudahan konsumsi di frontend
        const songs = playlist.items.map((item: any) => ({
            position: item.position,
            addedAt: item.addedAt,
            song: {
                id: item.song.id,
                title: item.song.title,
                durationSec: item.song.durationSec,
                coverUrl: item.song.coverUrl || item.song.album?.coverUrl || null,
                artists: item.song.artists,
                album: item.song.album,
            },
        }));

        return res.json({
            id: playlist.id,
            name: playlist.name,
            description: playlist.description,
            coverUrl: playlist.coverUrl,
            owner: playlist.user,
            totalSongs: songs.length,
            songs,
        });
    } catch (err) {
        console.error('[GET /playlists/:id]', err);
        return res.status(500).json({ error: 'Gagal mengambil playlist.' });
    }
});

/**
 * POST /playlists/:id/songs
 * Tambah lagu ke playlist
 * Body: { songId: string }
 */
router.post('/:id/songs', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { songId } = req.body as { songId?: string };

    if (!songId) return res.status(400).json({ error: 'songId wajib diisi.' });

    try {
        // Verifikasi playlist milik user ini
        const playlist = await prisma.playlist.findFirst({
            where: { id, userId: req.user!.userId },
        });
        if (!playlist) return res.status(403).json({ error: 'Tidak diizinkan.' });

        // Cari posisi terakhir
        const lastItem = await prisma.playlistItem.findFirst({
            where: { playlistId: id },
            orderBy: { position: 'desc' },
        });
        const nextPosition = (lastItem?.position ?? 0) + 1;

        const item = await prisma.playlistItem.create({
            data: { playlistId: id, songId, position: nextPosition },
        });

        console.log(`[POST /playlists/${id}/songs] Added song ${songId} at position ${nextPosition}`);
        return res.status(201).json({ item });
    } catch (err: any) {
        if (err.code === 'P2002') {
            return res.status(409).json({ error: 'Lagu sudah ada di playlist.' });
        }
        console.error('[POST /playlists/:id/songs] Error:', err.message);
        return res.status(500).json({ error: 'Gagal menambah lagu ke playlist.' });
    }
});

/**
 * PATCH /playlists/:id
 * Update playlist metadata (Name, Description, Cover)
 */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, description, coverUrl } = req.body as { name?: string; description?: string; coverUrl?: string };

    try {
        const playlist = await prisma.playlist.findFirst({
            where: { id, userId: req.user!.userId },
        });

        if (!playlist) return res.status(403).json({ error: 'Tidak diizinkan.' });

        const updated = await prisma.playlist.update({
            where: { id },
            data: {
                ...(name ? { name } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(coverUrl !== undefined ? { coverUrl } : {}),
            },
        });

        return res.json({ playlist: updated });
    } catch (err) {
        console.error('[PATCH /playlists/:id]', err);
        return res.status(500).json({ error: 'Gagal update playlist.' });
    }
});

/**
 * DELETE /playlists/:id
 * Hapus playlist permanen
 */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
        const playlist = await prisma.playlist.findFirst({
            where: { id, userId: req.user!.userId },
        });

        if (!playlist) return res.status(403).json({ error: 'Tidak diizinkan.' });

        await prisma.playlist.delete({
            where: { id },
        });

        return res.json({ message: 'Playlist berhasil dihapus.' });
    } catch (err) {
        console.error('[DELETE /playlists/:id]', err);
        return res.status(500).json({ error: 'Gagal menghapus playlist.' });
    }
});

export default router;
