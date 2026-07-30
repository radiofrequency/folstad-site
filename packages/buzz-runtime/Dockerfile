FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN npm install --omit=dev=false && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/dist ./dist
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
