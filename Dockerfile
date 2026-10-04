FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# data/ 保存加密配置与密钥，运行时建议挂载卷持久化
RUN mkdir -p /app/data && chmod 700 /app/data && chown -R node:node /app

USER node

EXPOSE 2556
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
