FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["npm","start"]
