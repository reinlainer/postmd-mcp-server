# 원격(streamable HTTP) 서버 이미지. stdio 로 쓰는 사람은 이 이미지가 필요 없다 —
# npx 로 바로 돌아간다.
FROM node:22-alpine

WORKDIR /app

# 의존성 먼저. 소스만 바뀔 때 이 층을 다시 받지 않는다.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# 루트로 돌릴 이유가 없다. node 사용자는 베이스 이미지에 이미 있다.
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/http.js"]
