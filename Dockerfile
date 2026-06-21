FROM node:18-alpine
WORKDIR /app
COPY proxy.js setup.js troubleshoot.js package.json config.runtime.example.json ./
COPY src ./src
CMD ["node", "proxy.js"]
