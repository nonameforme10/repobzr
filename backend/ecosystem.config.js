const path = require('path');

module.exports = {
  apps: [
    {
      name: 'bozor-backend',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      }
    },
    {
      name: 'bozor-telegram-bot',
      script: 'python3',
      args: '-m telegram_bot.run',
      cwd: path.resolve(__dirname, '..'),
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        PYTHONUNBUFFERED: '1'
      }
    }
  ]
};
