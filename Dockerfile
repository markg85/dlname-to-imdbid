FROM node:18-alpine
WORKDIR /src
COPY package*.json ./
RUN npm install
# If you are building your code for production
# RUN npm ci --only=production
COPY . .
# note that you need to set the PORT environment variable when running the container. That variable + this expose line needs to be the same.
EXPOSE 80
CMD [ "node", "index.js" ]
