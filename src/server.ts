import fastify from 'fastify';
import cors from '@fastify/cors';
import routes from './api';

const server = fastify({
  logger: true
});

// Register CORS
await server.register(cors, {
  origin: '*'
});

// Register routes
await server.register(routes);

// Run the server
const start = async () => {
  try {
    await server.listen({ port: 5000 });
    console.log('Server running at http://localhost:5000');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start(); 