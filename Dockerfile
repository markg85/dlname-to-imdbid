FROM node:22-alpine
RUN apk add --no-cache make cmake git g++

WORKDIR /src
COPY package*.json ./
RUN yarn install
COPY . ./
