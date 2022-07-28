FROM node:18-alpine
WORKDIR /src
COPY package*.json ./
RUN npm install
# If you are building your code for production
# RUN npm ci --only=production
COPY . .
CMD [ "node", "index.js" ]
