FROM node:22-alpine
RUN apk add --no-cache make cmake git g++

WORKDIR /src
COPY . ./
RUN yarn install
