# YoutubeClipQuiz AutoTimed

Complete automatic live music quiz:
- No host PIN
- Automatically searches YouTube for embeddable music videos
- 10-second clip phase
- 5-second answer phase
- 3-second answer reveal
- Automatically advances through all questions
- QR join, phone answers, live scoring, leaderboard

## Local setup
1. Install Node.js 18 or later.
2. Copy `.env.example` to `.env`.
3. Put a NEW restricted YouTube Data API v3 key in `.env`.
4. Run `npm install` and `npm start`.
5. Open `http://localhost:3000/host.html`.

## Render
Create a Node Web Service with:
- Build: `npm install`
- Start: `npm start`
- Health check: `/health`
- Environment: `YOUTUBE_API_KEY` and `PUBLIC_URL`

After Render assigns the HTTPS URL, set `PUBLIC_URL` to that full URL and redeploy. Do not upload `.env`.

## Security
The key previously posted in chat is exposed. Revoke it and use a new restricted key before public deployment.
