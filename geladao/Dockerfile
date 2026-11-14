# Imagem do Geladão para publicação (Railway, Fly.io ou qualquer servidor com Docker)
FROM node:22-slim

# Fuso horário do Brasil: relatórios e caixa usam a data local
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*
ENV TZ=America/Sao_Paulo \
    NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# Banco e backups ficam em /data (monte um volume permanente aqui)
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
