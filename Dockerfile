FROM node:20-alpine
RUN apk add --no-cache gcompat

WORKDIR /src
COPY package*.json ./
RUN yarn install
# If you are building your code for production
# RUN npm ci --only=production
COPY . .