FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev
COPY dist ./dist
ENV WORK_ROOT=/app/work
CMD ["node", "dist/index.js"]
