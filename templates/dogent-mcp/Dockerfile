# 사내 컨테이너 환경에 올릴 때: docker build -t my-mcp . && docker run -p 8800:8800 -e MCP_TOKEN=<토큰> my-mcp
FROM node:20-alpine
WORKDIR /app
COPY server.mjs ./
ENV NODE_ENV=production
EXPOSE 8800
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8800/health || exit 1
USER node
CMD ["node", "server.mjs", "--http", "8800"]
