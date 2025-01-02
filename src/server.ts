import fastify from 'fastify';
import cors from '@fastify/cors';
import routes from './api.js';
import { createServer } from 'net';

const server = fastify({
  logger: true
});

// Register CORS
await server.register(cors, {
  origin: '*'
});

// Register routes
await server.register(routes);

// Check if port is in use
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.once('close', () => resolve(true)).close();
      })
      .listen(port);
  });
}

// Find available port
async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (!(await isPortAvailable(port))) {
    port++;
  }
  return port;
}

// Run the server
const start = async () => {
  try {
    const desiredPort = 5000;
    const port = await findAvailablePort(desiredPort);
    
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server running at http://localhost:${port}`);
    
    if (port !== desiredPort) {
      console.log(`Note: Port ${desiredPort} was in use, using port ${port} instead`);
      console.log(`If using ngrok, run: ngrok http ${port}`);
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start(); 