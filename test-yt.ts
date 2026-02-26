import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    const token = jwt.sign({ userId: '1', email: 'demo@example.com', role: 'ADMIN' }, process.env.JWT_SECRET as string);
    console.log('Using Token:', token);

    const res = await fetch('http://localhost:5000/songs/yt-download', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            youtubeUrl: 'https://youtu.be/LMIS2PMqCL0',
            artistId: 'artist-03' // This ID doesn't exist yet, it should trigger Prisma error
        })
    });

    console.log('Status:', res.status);
    const data = await res.json();
    console.log('Response:', data);
}

main().catch(console.error);
