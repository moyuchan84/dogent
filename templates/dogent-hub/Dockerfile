# 샘플입니다. Dogent Hub와 LLM 프록시를 한 이미지에 담는다 (의존성 없음, 묶은 .mjs 두 개만).
#   docker build -t dogent-hub .
#   docker run -p 8790:8790 -e HUB_TOKEN=... -e HUB_ADMIN_TOKEN=... -v hub-data:/data dogent-hub
#   LLM 프록시로 띄울 때:
#   docker run -p 8791:8791 -e LLM_UPSTREAM_URL=... -e LLM_UPSTREAM_KEY=... -v $PWD/tokens.json:/etc/dogent/tokens.json:ro dogent-hub \
#     node tools/llm-proxy.mjs --tokens /etc/dogent/tokens.json --host 0.0.0.0 --port 8791 --audit /data/llm-audit.jsonl
FROM node:20-alpine
WORKDIR /app
COPY tools/ ./tools/
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production
EXPOSE 8790 8791
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8790/health || exit 1
# 기본은 Hub. 파일 저장소라 컨테이너는 하나만 띄운다
CMD ["node", "tools/hub.mjs", "--data", "/data", "--host", "0.0.0.0", "--port", "8790"]
