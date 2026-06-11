# Soccer Stats App

A soccer stats app where users can browse teams, view their lineup on an interactive pitch (like Google's match view), hover players for quick stats, and click through to full career stats across all competitions.

## Architecture

```
ClaudePractice/
├── client/    Vite + React + TypeScript + Tailwind
└── server/    Express + TypeScript, proxies football-data.org
```

## Data Source

**football-data.org** — free tier (10 req/min, top leagues covered)
- Docs: https://docs.football-data.org/general/v4/index.html
- Set `FOOTBALL_API_KEY` in `server/.env` (get one free at football-data.org)
- The server proxies all requests to avoid exposing the key client-side

## Running Locally

```bash
# Server (port 3001)
cd server && npm install && npm run dev

# Client (port 5173)
cd client && npm install && npm run dev
```

## Environment Variables

`server/.env`:
```
FOOTBALL_API_KEY=your_key_here
PORT=3001
```

## Key Design Decisions

- Player positions from the squad response are mapped to pitch coordinates by formation slot — GK at bottom, defenders, midfielders, forwards stacked up
- Hover tooltip shows current-season stats; click opens a slide-in panel with career history
- Server caches responses in-memory for 5 minutes to stay within the free tier rate limit
- Mock data is returned when `FOOTBALL_API_KEY` is not set, so the UI works without an API key during development

## Free Tier Limits

football-data.org free plan: 10 calls/minute. The server-side cache prevents hitting this during normal use.
