import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface JwtPayload {
    userId: string;
    email: string;
    role: string;
}

// Extend Express Request to carry the decoded user
declare global {
    namespace Express {
        interface Request {
            user?: JwtPayload;
        }
    }
}

/**
 * Middleware: verifikasi JWT dari header Authorization: Bearer <token>
 * Jika valid, attach decoded payload ke req.user
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Token tidak ditemukan. Silakan login terlebih dahulu.' });
        return;
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token tidak valid atau sudah kadaluarsa.' });
    }
}

/**
 * Middleware: khusus untuk admin
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    if (req.user.role !== 'ADMIN') {
        res.status(403).json({ error: 'Akses ditolak. Membutuhkan hak akses admin.' });
        return;
    }

    next();
}

/**
 * Helper: buat JWT token baru
 */
export function signToken(payload: JwtPayload): string {
    return jwt.sign(payload, process.env.JWT_SECRET as string, {
        expiresIn: '7d',
    });
}
