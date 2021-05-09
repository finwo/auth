FROM node:alpine
RUN apk update
RUN apk upgrade
COPY . /app
WORKDIR /app
RUN npm ci
RUN npm run build --if-present
CMD node index.js
