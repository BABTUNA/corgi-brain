# Corgi Brain bridge on Supabase Compute: the web UI, the API and the Claude explorer agents with
# their headless Chromium. Playwright's image ships the browsers.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
ENV NODE_ENV=production
# Compute provides $PORT; the bridge reads it. SUPABASE_URL and the project keys arrive as the
# same default environment variables Edge Functions get; ANTHROPIC_API_KEY is a project secret.
CMD ["node", "server.js"]
