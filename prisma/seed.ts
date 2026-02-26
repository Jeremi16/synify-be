import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Seeding database...');

    // ── Artists ──────────────────────────────────────────────────────────────────
    const artist1 = await prisma.artist.upsert({
        where: { id: 'artist-01' },
        update: {},
        create: {
            id: 'artist-01',
            name: 'Tulus',
            bio: 'Penyanyi pop Indonesia dengan nuansa jazz dan soul.',
            avatarUrl: null,
        },
    });

    const artist2 = await prisma.artist.upsert({
        where: { id: 'artist-02' },
        update: {},
        create: {
            id: 'artist-02',
            name: 'Raisa',
            bio: 'Penyanyi dan penulis lagu Indonesia bergenre pop.',
            avatarUrl: null,
        },
    });

    // ── Albums ───────────────────────────────────────────────────────────────────
    const album1 = await prisma.album.upsert({
        where: { id: 'album-01' },
        update: {},
        create: {
            id: 'album-01',
            title: 'Gajah',
            releaseYear: 2014,
            artistId: artist1.id,
            coverUrl: null,
        },
    });

    const album2 = await prisma.album.upsert({
        where: { id: 'album-02' },
        update: {},
        create: {
            id: 'album-02',
            title: 'Raisa',
            releaseYear: 2012,
            artistId: artist2.id,
            coverUrl: null,
        },
    });

    // ── Songs ────────────────────────────────────────────────────────────────────
    // NOTE: audioKey harus sesuai dengan object key di R2 bucket kamu
    const songs = await Promise.all([
        prisma.song.upsert({
            where: { id: 'song-01' },
            update: {},
            create: {
                id: 'song-01',
                title: 'Gajah',
                durationSec: 243,
                audioKey: 'audio/song-01.mp3',
                trackNumber: 1,
                artists: { connect: [{ id: artist1.id }] },
                albumId: album1.id,
                genre: 'Pop',
            },
        }),
        prisma.song.upsert({
            where: { id: 'song-02' },
            update: {},
            create: {
                id: 'song-02',
                title: 'Bumerang',
                durationSec: 198,
                audioKey: 'audio/song-02.mp3',
                trackNumber: 2,
                artists: { connect: [{ id: artist1.id }] },
                albumId: album1.id,
                genre: 'Pop',
            },
        }),
        prisma.song.upsert({
            where: { id: 'song-03' },
            update: {},
            create: {
                id: 'song-03',
                title: 'Sewindu',
                durationSec: 265,
                audioKey: 'audio/song-03.mp3',
                trackNumber: 3,
                artists: { connect: [{ id: artist1.id }] },
                albumId: album1.id,
                genre: 'Pop',
            },
        }),
        prisma.song.upsert({
            where: { id: 'song-04' },
            update: {},
            create: {
                id: 'song-04',
                title: 'Could It Be',
                durationSec: 274,
                audioKey: 'audio/song-04.mp3',
                trackNumber: 1,
                artists: { connect: [{ id: artist2.id }] },
                albumId: album2.id,
                genre: 'Pop',
            },
        }),
        prisma.song.upsert({
            where: { id: 'song-05' },
            update: {},
            create: {
                id: 'song-05',
                title: 'Serba Salah',
                durationSec: 231,
                audioKey: 'audio/song-05.mp3',
                trackNumber: 2,
                artists: { connect: [{ id: artist2.id }] },
                albumId: album2.id,
                genre: 'Pop',
            },
        }),
    ]);

    // ── Demo User ─────────────────────────────────────────────────────────────
    const user = await prisma.user.upsert({
        where: { email: 'demo@example.com' },
        update: {},
        create: {
            email: 'demo@example.com',
            name: 'Demo User',
            avatarUrl: null,
        },
    });

    // ── Playlist ──────────────────────────────────────────────────────────────
    const playlist = await prisma.playlist.upsert({
        where: { id: 'playlist-01' },
        update: {},
        create: {
            id: 'playlist-01',
            name: 'Favoritku',
            description: 'Kumpulan lagu favorit',
            userId: user.id,
        },
    });

    // ── Playlist Items ────────────────────────────────────────────────────────
    for (let i = 0; i < songs.length; i++) {
        await prisma.playlistItem.upsert({
            where: { playlistId_songId: { playlistId: playlist.id, songId: songs[i].id } },
            update: { position: i + 1 },
            create: {
                playlistId: playlist.id,
                songId: songs[i].id,
                position: i + 1,
            },
        });
    }

    console.log('✅ Seeding selesai!');
    console.log(`   - ${2} artis`);
    console.log(`   - ${2} album`);
    console.log(`   - ${songs.length} lagu`);
    console.log(`   - ${1} user demo`);
    console.log(`   - ${1} playlist`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
