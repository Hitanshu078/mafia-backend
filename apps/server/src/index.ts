import { createMafiaServer } from './app.js';

// Don't try to keep serving after an uncaught error — state may be
// corrupted. Log it so it's visible in the platform's logs, then exit and
// let the process supervisor (Railway/Render/Fly all restart a crashed
// process automatically; pm2/systemd do the same for self-hosting) bring up
// a clean instance instead of limping along.
process.on('uncaughtException', (err) => {
    console.error('uncaughtException — exiting for a clean restart:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection — exiting for a clean restart:', reason);
    process.exit(1);
});

createMafiaServer().then(({ port, httpServer }) => {
    console.log(`🎭 Mafia server running on http://localhost:${port}`);
    console.log(`   Health check: http://localhost:${port}/health`);

    const shutdown = (signal: string) => {
        console.log(`${signal} received, shutting down gracefully`);
        httpServer.close(() => process.exit(0));
        // Force-exit if connections haven't closed in time (e.g. still-open
        // WebSockets) rather than hanging forever on a deploy/restart.
        setTimeout(() => process.exit(0), 5000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
});
