import { createCubeServer } from './socket.mjs';
const port = Number(process.env.PORT || 4187);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const app = createCubeServer();
app.server.listen(port, '0.0.0.0', () => console.log(`Cube Bomber server listening on port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close());
