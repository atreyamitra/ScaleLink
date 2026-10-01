FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
# Fail the BUILD if the install was incomplete. npm can print "Exit handler never
# called!" yet exit 0, leaving a half-populated node_modules that only crashes
# at container start ("Cannot find module"). Resolve every declared dependency.
RUN npm ci --omit=dev \
 && node -e "for (const d of Object.keys(require('./package.json').dependencies)) require.resolve(d)"

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080
USER node

# Readiness, not just liveness: "healthy" means this instance can reach Redis,
# which is what compose's `depends_on: service_healthy` and load balancers need.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/ready', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
