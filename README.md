# V0.dev API

Interact with v0.dev through a REST API using Stagehand and Browserbase.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory:
```env
BROWSERBASE_API_KEY=your_api_key
BROWSERBASE_PROJECT_ID=your_project_id
```

3. Run the server:
```bash
# Development
npm run dev

# Production
npm run build
npm start
```

The server will run at http://localhost:5000

## API Usage

### Generate UI with v0.dev

```bash
curl -X POST http://localhost:5000/api/prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a modern login form with email and password fields"}'
```

## Hosting (Optional)

To expose your local server, you can use ngrok:

1. Download ngrok from https://ngrok.com/download
2. Run:
```bash
ngrok http 5000
```

## Development

- `api.ts` - Main API routes and v0.dev interaction logic
- `server.ts` - FastAPI server setup
- Built with TypeScript, Fastify, and Stagehand
