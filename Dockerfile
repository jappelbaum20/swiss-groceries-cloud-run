FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

ARG SOURCE_SHA
ARG CLOUD_BUILD_ID
ENV SOURCE_SHA=${SOURCE_SHA}
ENV CLOUD_BUILD_ID=${CLOUD_BUILD_ID}

ENV NODE_ENV=production
ENV PORT=8080
ENV SWISSGROCERIES_LOG_LEVEL=info

USER node

EXPOSE 8080

CMD ["npm", "start"]
