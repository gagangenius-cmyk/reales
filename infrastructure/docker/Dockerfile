# One image, three roles: web (default), worker, scheduler. Select the role with the container command.
#   web:       npm run start -w @reales/web
#   worker:    npm run worker
#   scheduler: npm run scheduler
#   migrate:   npm run db:migrate
# NOTE: not built or scanned in the authoring environment (no registry/CI available). Run it through your pipeline and an image scanner before use.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY migrations ./migrations
COPY scripts ./scripts
RUN npm ci
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "-w", "@reales/web"]
